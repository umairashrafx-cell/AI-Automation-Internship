/**
 * Answer-generation providers.
 *
 *   AnthropicProvider - the official @anthropic-ai/sdk. Default model is
 *     claude-opus-5. Note two current-API details that are easy to get wrong:
 *       * `temperature` / `top_p` were REMOVED on Opus 5 and return a 400.
 *         We never send them on this path.
 *       * Thinking is on by default. Rather than disabling it (which on Opus 5
 *         can leak tool calls into visible text), we lower `output_config.effort`
 *         - grounded RAG answers are short and well-specified, so "low" is right.
 *
 *   OpenAIProvider - Chat Completions over fetch, for teams already on OpenAI.
 *
 *   ExtractiveProvider - NO model call at all. Composes the answer from the
 *     retrieved sentences that best match the question. It literally cannot
 *     hallucinate because it can only emit text that exists in the documents.
 *     Reads stiffly, which is exactly why it is the offline default rather than
 *     something pretending to be an LLM.
 */

import { env, resolvedLlmProvider } from '../config/env.ts';
import { errors } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { retry, withTimeout } from '../utils/misc.ts';
import { splitSentences, tokenize } from '../utils/text.ts';
import type { RetrievedChunk } from '../models/types.ts';

export interface GenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Prior turns, oldest first, already trimmed to a sensible window. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Retrieved evidence - the extractive provider needs the raw chunks. */
  chunks: RetrievedChunk[];
  /** The customer's original question, for the extractive provider. */
  question: string;
  correlationId?: string;
}

export interface GenerateResult {
  text: string;
  provider: 'anthropic' | 'openai' | 'extractive';
  model: string;
  /** Present only for real model calls. */
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'extractive';
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

const LLM_TIMEOUT_MS = 45_000;

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private client: unknown = null;

  constructor(model: string) {
    this.model = model;
  }

  private async getClient() {
    if (this.client) return this.client as { messages: { create: Function } };
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    this.client = new Anthropic({ apiKey: env.llm.anthropicApiKey });
    return this.client as { messages: { create: Function } };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const client = await this.getClient();

    const messages = [
      ...(request.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: request.userPrompt },
    ];

    const response = (await retry(
      () =>
        withTimeout(
          client.messages.create({
            model: this.model,
            max_tokens: env.llm.maxTokens,
            system: request.systemPrompt,
            messages,
            // Effort, not disabled thinking - see the file header.
            output_config: { effort: env.llm.effort },
          }) as Promise<{
            content: Array<{ type: string; text?: string }>;
            stop_reason: string;
            usage: { input_tokens: number; output_tokens: number };
          }>,
          LLM_TIMEOUT_MS,
          () => errors.upstreamTimeout('anthropic', LLM_TIMEOUT_MS),
        ),
      {
        attempts: 2,
        baseDelayMs: 600,
        shouldRetry: (err) => /429|5\d\d|timeout|overloaded/i.test((err as Error).message),
        onRetry: (err, attempt) =>
          logger.warn('anthropic retry', {
            correlationId: request.correlationId,
            attempt,
            error: (err as Error).message,
          }),
      },
    )) as {
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    // A safety decline is not an outage - treat it as "cannot answer" so the
    // caller escalates to a human rather than surfacing an error.
    if (response.stop_reason === 'refusal') {
      logger.warn('anthropic refused the request', { correlationId: request.correlationId });
      return {
        text: 'ESCALATE: the assistant could not produce a response for this request.',
        provider: this.name,
        model: this.model,
        latencyMs: Date.now() - started,
      };
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();

    return {
      text,
      provider: this.name,
      model: this.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      latencyMs: Date.now() - started,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

class OpenAIProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly model = 'gpt-4o-mini';

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const response = await withTimeout(
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.llm.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: env.llm.maxTokens,
          temperature: env.llm.temperature,
          messages: [
            { role: 'system', content: request.systemPrompt },
            ...(request.history ?? []),
            { role: 'user', content: request.userPrompt },
          ],
        }),
      }),
      LLM_TIMEOUT_MS,
      () => errors.upstreamTimeout('openai', LLM_TIMEOUT_MS),
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw errors.upstream('openai', `HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const json = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      text: (json.choices[0]?.message.content ?? '').trim(),
      provider: this.name,
      model: this.model,
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
        : undefined,
      latencyMs: Date.now() - started,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Extractive (no model)                                                      */
/* -------------------------------------------------------------------------- */

class ExtractiveProvider implements LlmProvider {
  readonly name = 'extractive' as const;
  readonly model = 'extractive-v1';

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();

    if (request.chunks.length === 0) {
      return {
        text: 'ESCALATE: no supporting documentation was retrieved for this question.',
        provider: this.name,
        model: this.model,
        latencyMs: Date.now() - started,
      };
    }

    const queryTerms = new Set(tokenize(request.question));

    // Score every sentence in the retrieved chunks by term overlap with the
    // question, weighted by the similarity of the chunk it came from.
    const scored: Array<{ sentence: string; score: number; chunk: RetrievedChunk }> = [];
    for (const chunk of request.chunks) {
      // Chunks carry a "Heading > Subheading" breadcrumb as their first line so
      // that topic words are present in the embedded text. It is navigation,
      // not prose, so it must not be quoted back to the customer.
      const trail = (chunk.metadata['headingTrail'] as string[] | undefined) ?? [];
      const breadcrumb = trail.join(' > ');
      const body =
        breadcrumb && chunk.chunkText.startsWith(breadcrumb)
          ? chunk.chunkText.slice(breadcrumb.length).trimStart()
          : chunk.chunkText;

      for (const rawSentence of splitSentences(body)) {
        // Chunk text keeps the newlines that mark document structure. A
        // sentence quoted back to a customer must not, or the reply arrives
        // wrapped at the source PDF's column width.
        const sentence = rawSentence.replace(/\s+/g, ' ').trim();
        if (sentence.length < 25 || sentence.length > 400) continue;
        const terms = tokenize(sentence);
        if (terms.length === 0) continue;
        let overlap = 0;
        for (const t of new Set(terms)) if (queryTerms.has(t)) overlap++;
        if (overlap === 0) continue;
        // Normalise by query length so long sentences do not automatically win.
        const score = (overlap / Math.max(1, queryTerms.size)) * (0.5 + chunk.similarity);
        scored.push({ sentence, score, chunk });
      }
    }

    if (scored.length === 0) {
      return {
        text: 'ESCALATE: the retrieved documents do not address this question.',
        provider: this.name,
        model: this.model,
        latencyMs: Date.now() - started,
      };
    }

    scored.sort((a, b) => b.score - a.score);

    // Take the best two or three non-duplicate sentences.
    const picked: typeof scored = [];
    for (const candidate of scored) {
      if (picked.length >= 3) break;
      if (picked.some((p) => p.sentence === candidate.sentence)) continue;
      picked.push(candidate);
    }

    const topDoc = picked[0]?.chunk;
    const policyName = topDoc?.title ?? topDoc?.filename ?? 'our policy documents';
    const body = picked.map((p) => p.sentence).join(' ');

    return {
      // Framed as a quotation, because that is exactly what it is.
      text: `According to ${policyName}: ${body}`,
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

let provider: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (provider) return provider;
  const resolved = resolvedLlmProvider();

  if (resolved === 'anthropic') {
    provider = new AnthropicProvider(env.llm.anthropicModel);
    logger.info('llm provider', { provider: 'anthropic', model: env.llm.anthropicModel });
  } else if (resolved === 'openai') {
    provider = new OpenAIProvider();
    logger.info('llm provider', { provider: 'openai' });
  } else {
    provider = new ExtractiveProvider();
    logger.warn('llm provider', {
      provider: 'extractive',
      note: 'no LLM key configured; answers are assembled verbatim from retrieved documents',
    });
  }
  return provider;
}

export function resetLlmProvider(): void {
  provider = null;
}
