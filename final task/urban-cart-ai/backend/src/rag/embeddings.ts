/**
 * Stage 5 of the RAG pipeline: embedding generation.
 *
 * Two providers, one interface:
 *
 *   OpenAIEmbeddingProvider - real `text-embedding-3-small` calls. Batched,
 *     retried with backoff. Used whenever OPENAI_API_KEY is present.
 *
 *   LocalEmbeddingProvider - a deterministic hashed bag-of-words vector
 *     (the "hashing trick": signed feature hashing of unigrams and bigrams,
 *     sublinear term frequency, L2-normalised). This is REAL vector maths and
 *     real cosine similarity, not a stub returning canned results - but it is
 *     LEXICAL, not semantic: it matches shared wording, and will miss a
 *     paraphrase that shares no vocabulary. It exists so the whole pipeline is
 *     demonstrable and testable with no API key, and it is reported as
 *     "degraded" by /health so nobody mistakes it for production quality.
 */

import { env, resolvedEmbeddingProvider } from '../config/env.ts';
import { errors } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { retry, withTimeout } from '../utils/misc.ts';
import { tokenize } from '../utils/text.ts';

export interface EmbeddingProvider {
  readonly name: 'openai' | 'local';
  readonly dimensions: number;
  /** True when this provider is production-grade. */
  readonly isSemantic: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

/* -------------------------------------------------------------------------- */
/* OpenAI                                                                     */
/* -------------------------------------------------------------------------- */

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const OPENAI_BATCH_SIZE = 96;
const OPENAI_TIMEOUT_MS = 30_000;

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai' as const;
  readonly isSemantic = true;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string, dimensions: number) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += OPENAI_BATCH_SIZE) {
      const batch = texts.slice(i, i + OPENAI_BATCH_SIZE);
      const vectors = await retry(() => this.embedBatch(batch), {
        attempts: 3,
        baseDelayMs: 500,
        shouldRetry: (err) => {
          const msg = (err as Error).message;
          // Retry rate limits and 5xx; never retry an auth or validation error.
          return /429|5\d\d|timeout|ECONNRESET|fetch failed/i.test(msg);
        },
        onRetry: (err, attempt, delay) =>
          logger.warn('openai embeddings retry', {
            attempt,
            delayMs: delay,
            error: (err as Error).message,
          }),
      });
      out.push(...vectors);
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const response = await withTimeout(
      fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
          encoding_format: 'float',
        }),
      }),
      OPENAI_TIMEOUT_MS,
      () => errors.upstreamTimeout('openai-embeddings', OPENAI_TIMEOUT_MS),
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw errors.upstream(
        'openai-embeddings',
        `HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    // The API may return out of order; index is authoritative.
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/* -------------------------------------------------------------------------- */
/* Local deterministic provider                                               */
/* -------------------------------------------------------------------------- */

/** FNV-1a, 32-bit. Fast, stable across runs and processes. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local' as const;
  readonly isSemantic = false;
  readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const terms = tokenize(text);
    if (terms.length === 0) return vector;

    // Unigrams plus adjacent bigrams: bigrams capture short phrases like
    // "return window" or "damaged product" that unigrams alone would scatter.
    const features = new Map<string, number>();
    const bump = (key: string, weight: number) =>
      features.set(key, (features.get(key) ?? 0) + weight);

    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      if (!term) continue;
      bump(term, 1);
      const next = terms[i + 1];
      if (next) bump(`${term}_${next}`, 0.6);
    }

    for (const [feature, rawCount] of features) {
      // Sublinear term frequency: the 10th occurrence should not count as much
      // as the 1st, otherwise long documents dominate every query.
      const weight = 1 + Math.log(rawCount);
      // Two hashed buckets per feature with independent signs reduces the
      // collision bias of single-bucket feature hashing.
      for (let k = 0; k < 2; k++) {
        const h = fnv1a(feature, k === 0 ? 0x811c9dc5 : 0x9e3779b1);
        const bucket = h % this.dimensions;
        const sign = ((h >>> 16) & 1) === 0 ? 1 : -1;
        const current = vector[bucket] ?? 0;
        vector[bucket] = current + sign * weight;
      }
    }

    // L2-normalise so the cosine distance operator behaves as expected.
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
    return vector;
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (provider) return provider;

  const resolved = resolvedEmbeddingProvider();
  if (resolved === 'openai') {
    provider = new OpenAIEmbeddingProvider(
      env.llm.openaiApiKey,
      env.rag.embeddingModel,
      env.rag.embeddingDimensions,
    );
    logger.info('embedding provider', { provider: 'openai', model: env.rag.embeddingModel });
  } else {
    provider = new LocalEmbeddingProvider(env.rag.embeddingDimensions);
    logger.warn('embedding provider', {
      provider: 'local',
      note: 'deterministic hashed bag-of-words; lexical matching only, demo quality',
    });
  }
  return provider;
}

/** Test seam. */
export function resetEmbeddingProvider(): void {
  provider = null;
}

/** Cosine similarity between two L2-normalised-or-not vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
