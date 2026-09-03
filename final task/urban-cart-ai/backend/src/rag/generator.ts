/**
 * Stages 9-10 of the RAG pipeline: grounded answer generation.
 *
 * The gate order matters and is deliberate:
 *
 *   1. Retrieval status must be `grounded`. `uncertain` and `empty` never
 *      reach the model at all - we do not give a language model weak evidence
 *      and hope it declines to use it.
 *   2. The model may still return "ESCALATE:", which we honour.
 *   3. The generated answer is checked for unsupported numbers. A price,
 *      duration or percentage that appears in the answer but in none of the
 *      supplied evidence is treated as a hallucination and forces escalation.
 *
 * Step 3 is the backstop that makes the "never invent a price or a return
 * window" requirement enforceable rather than merely requested.
 */

import { ragThresholds } from '../config/env.ts';
import { getLlmProvider } from '../connectors/llm.ts';
import { logger } from '../utils/logger.ts';
import { round } from '../utils/misc.ts';
import type { ConversationMessage, RetrievedSource } from '../models/types.ts';
import {
  GROUNDING_SYSTEM_PROMPT,
  VOICE_SYSTEM_PROMPT,
  buildBusinessDataBlock,
  buildUserPrompt,
  type BusinessFacts,
} from './prompt.ts';
import type { RetrievalResult } from './retriever.ts';

export interface GenerateGroundedInput {
  question: string;
  retrieval: RetrievalResult;
  facts?: BusinessFacts;
  history?: ConversationMessage[];
  /** Voice replies are short, list-free and spoken. */
  voice?: boolean;
  correlationId?: string;
}

export interface GroundedAnswer {
  answer: string;
  /** False when the system refused to answer and a human is required. */
  grounded: boolean;
  confidence: number;
  sources: RetrievedSource[];
  /** Why we refused, when grounded is false. */
  refusalReason?: 'no_evidence' | 'low_confidence' | 'model_escalated' | 'unsupported_claim';
  provider: string;
  model: string;
  latencyMs: number;
}

/** Numbers that carry business meaning and must be traceable to evidence. */
const NUMERIC_CLAIM = /(?:rs\.?\s?)?\b\d{1,3}(?:,\d{3})+\b|\b\d+\s*(?:day|days|week|weeks|month|months|year|years|%|percent)\b|\brs\.?\s?\d+\b/gi;

/** Normalise "Rs. 200,000" / "200000" / "7 days" to a comparable token. */
function normaliseClaim(raw: string): string {
  return raw.toLowerCase().replace(/[rs.\s,]/g, '');
}

/**
 * Find numeric claims in the answer that are not present in the evidence.
 *
 * Deliberately conservative: only flags claims with no digit-sequence match
 * anywhere in the supplied material, so ordinary rephrasing ("seven days" for
 * "7 days") does not trip it, but a fabricated "Rs. 5,000 restocking fee" does.
 */
export function findUnsupportedClaims(answer: string, evidence: string): string[] {
  const claims = answer.match(NUMERIC_CLAIM) ?? [];
  if (claims.length === 0) return [];

  const haystack = normaliseClaim(evidence);
  const unsupported: string[] = [];

  for (const claim of claims) {
    const digits = claim.replace(/\D/g, '');
    if (digits.length === 0) continue;
    // A bare small number ("2 days") is too common to police reliably; only
    // audit claims with two or more digits.
    if (digits.length < 2) continue;
    if (!haystack.includes(digits)) unsupported.push(claim.trim());
  }
  return [...new Set(unsupported)];
}

export async function generateGroundedAnswer(
  input: GenerateGroundedInput,
): Promise<GroundedAnswer> {
  const { retrieval } = input;
  const provider = getLlmProvider();

  const base = {
    confidence: retrieval.confidence,
    sources: retrieval.sources,
    provider: provider.name,
    model: provider.model,
  };

  // Gate 1: no usable evidence.
  if (retrieval.status === 'empty') {
    return {
      ...base,
      answer: '',
      grounded: false,
      refusalReason: 'no_evidence',
      latencyMs: 0,
    };
  }
  if (retrieval.status === 'uncertain') {
    logger.info('refusing to answer: confidence below threshold', {
      correlationId: input.correlationId,
      confidence: retrieval.confidence,
      threshold: ragThresholds().confidenceThreshold,
    });
    return {
      ...base,
      answer: '',
      grounded: false,
      refusalReason: 'low_confidence',
      latencyMs: 0,
    };
  }

  const history = (input.history ?? [])
    .filter((m) => m.role === 'customer' || m.role === 'assistant')
    .slice(-6)
    .map((m) => ({
      role: (m.role === 'customer' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }));

  const result = await provider.generate({
    systemPrompt: input.voice ? VOICE_SYSTEM_PROMPT : GROUNDING_SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(input.question, retrieval.chunks, input.facts ?? {}),
    history,
    chunks: retrieval.chunks,
    question: input.question,
    correlationId: input.correlationId,
  });

  const text = result.text.trim();

  // Gate 2: the model declined.
  if (/^ESCALATE\s*:/i.test(text)) {
    logger.info('model escalated', {
      correlationId: input.correlationId,
      reason: text.slice(0, 200),
    });
    return {
      ...base,
      answer: '',
      grounded: false,
      refusalReason: 'model_escalated',
      latencyMs: result.latencyMs,
    };
  }

  if (!text) {
    return { ...base, answer: '', grounded: false, refusalReason: 'no_evidence', latencyMs: result.latencyMs };
  }

  // Gate 3: numeric claims must trace back to the evidence we supplied.
  const evidence = [
    retrieval.chunks.map((c) => c.chunkText).join('\n'),
    buildBusinessDataBlock(input.facts ?? {}),
  ].join('\n');

  const unsupported = findUnsupportedClaims(text, evidence);
  if (unsupported.length > 0) {
    logger.warn('answer rejected: unsupported numeric claim', {
      correlationId: input.correlationId,
      claims: unsupported,
      provider: provider.name,
    });
    return {
      ...base,
      answer: '',
      grounded: false,
      refusalReason: 'unsupported_claim',
      confidence: round(retrieval.confidence * 0.5, 3),
      latencyMs: result.latencyMs,
    };
  }

  return {
    ...base,
    answer: text,
    grounded: true,
    latencyMs: result.latencyMs,
  };
}
