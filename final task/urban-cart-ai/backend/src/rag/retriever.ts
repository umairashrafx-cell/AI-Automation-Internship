/**
 * Stages 7-8 of the RAG pipeline: similarity search, filtering and confidence.
 *
 * The retriever is where "do not hallucinate" is actually enforced. It returns
 * a decision, not just chunks:
 *
 *   grounded  - enough high-similarity evidence to answer
 *   uncertain - something was found but it is too weak to rely on
 *   empty     - nothing relevant at all
 *
 * Only `grounded` allows an answer to be generated. The other two route to the
 * escalation path, which is exactly the client's requirement: "If the
 * information isn't available, the AI should tell the customer that it needs
 * human assistance rather than guessing."
 */

import { env, ragThresholds } from '../config/env.ts';
import type { DocumentType, Intent, RetrievedChunk, RetrievedSource } from '../models/types.ts';
import { getEmbeddingProvider } from './embeddings.ts';
import { getVectorStore, type SearchOptions } from './vector-store.ts';
import { logger } from '../utils/logger.ts';
import { round } from '../utils/misc.ts';
import { tokenize } from '../utils/text.ts';

export interface RetrievalResult {
  status: 'grounded' | 'uncertain' | 'empty';
  chunks: RetrievedChunk[];
  /** Best similarity seen, before filtering. 0 when nothing was returned. */
  bestSimilarity: number;
  /** 0-1 grounding confidence used by the escalation gate. */
  confidence: number;
  sources: RetrievedSource[];
  /** Document types the query was restricted to, for explainability. */
  appliedFilters: { documentTypes: DocumentType[] | null };
  timings: { embedMs: number; searchMs: number };
}

/**
 * Metadata filtering: map the classified intent to the document types that
 * could possibly answer it.
 *
 * This is not just an optimisation. Restricting a warranty question to warranty
 * and catalogue documents stops a superficially similar sentence in the RETURN
 * policy from being retrieved and presented as warranty terms - a realistic and
 * expensive way for a support bot to be confidently wrong.
 */
export const INTENT_DOCUMENT_TYPES: Partial<Record<Intent, DocumentType[]>> = {
  product_inquiry: ['product_catalog', 'warranty_policy'],
  price_inquiry: ['product_catalog'],
  availability_inquiry: ['product_catalog'],
  // `training` is included: the agent training notes hold the approved answers
  // to common questions (payments, cancellation, installments, authenticity)
  // that are not covered by any of the four formal policies.
  policy_question: [
    'return_policy',
    'shipping_policy',
    'warranty_policy',
    'support_guidelines',
    'product_catalog',
    'training',
  ],
  order_status: ['shipping_policy', 'training'],
  complaint: ['return_policy', 'warranty_policy', 'support_guidelines'],
};

/** Keyword hints that narrow a broad policy question to one policy family. */
const TOPIC_HINTS: Array<{ types: DocumentType[]; terms: string[] }> = [
  { types: ['return_policy'], terms: ['return', 'returns', 'refund', 'exchange', 'money back', 'send back'] },
  { types: ['warranty_policy'], terms: ['warranty', 'guarantee', 'repair', 'defect', 'faulty'] },
  { types: ['shipping_policy'], terms: ['delivery', 'deliver', 'shipping', 'ship', 'courier', 'dispatch', 'arrive'] },
  { types: ['product_catalog'], terms: ['specification', 'spec', 'feature', 'colour', 'color', 'storage', 'battery'] },
  { types: ['support_guidelines'], terms: ['complaint', 'escalate', 'agent', 'support hours', 'contact'] },
  // Answers that live only in the training notes.
  { types: ['training', 'shipping_policy'], terms: ['cancel', 'cancellation'] },
  { types: ['training'], terms: ['payment', 'pay', 'installment', 'instalment', 'cash on delivery', 'jazzcash', 'easypaisa', 'card', 'genuine', 'original', 'authentic', 'bulk'] },
];

/** Narrow the candidate document types using the query wording. */
export function resolveDocumentTypes(query: string, intent: Intent): DocumentType[] | null {
  const lower = query.toLowerCase();
  const hinted = new Set<DocumentType>();

  for (const hint of TOPIC_HINTS) {
    if (hint.terms.some((t) => lower.includes(t))) {
      for (const type of hint.types) hinted.add(type);
    }
  }
  if (hinted.size > 0) return [...hinted];

  return INTENT_DOCUMENT_TYPES[intent] ?? null;
}

/**
 * Grounding confidence.
 *
 * Similarity alone is a poor signal, especially with the local lexical
 * embedding provider, so confidence combines three things:
 *   - the best chunk's similarity (dominant term)
 *   - agreement: do the top chunks corroborate each other, or is there one
 *     lucky hit surrounded by noise?
 *   - lexical coverage: how many of the query's content words actually appear
 *     in the retrieved text. This is what catches "the vector store returned
 *     its five nearest neighbours, but none of them mention warranties".
 */
export function computeConfidence(query: string, chunks: RetrievedChunk[]): number {
  if (chunks.length === 0) return 0;

  const best = chunks[0]?.similarity ?? 0;
  const supporting = chunks.slice(1, 3);
  const agreement =
    supporting.length === 0
      ? 0
      : supporting.reduce((sum, c) => sum + c.similarity, 0) / supporting.length;

  const queryTerms = new Set(tokenize(query));
  let covered = 0;
  if (queryTerms.size > 0) {
    const corpus = chunks
      .slice(0, 3)
      .map((c) => c.chunkText.toLowerCase())
      .join(' ');
    for (const term of queryTerms) if (corpus.includes(term)) covered++;
  }
  const coverage = queryTerms.size === 0 ? 0 : covered / queryTerms.size;

  const score = 0.55 * best + 0.15 * agreement + 0.3 * coverage;
  return round(Math.max(0, Math.min(1, score)), 3);
}

export interface RetrieveOptions extends SearchOptions {
  intent?: Intent;
  /** Skip intent-based type filtering and search everything. */
  searchAllTypes?: boolean;
  correlationId?: string;
}

export async function retrieve(query: string, options: RetrieveOptions = {}): Promise<RetrievalResult> {
  const trimmed = query.trim();
  const empty: RetrievalResult = {
    status: 'empty',
    chunks: [],
    bestSimilarity: 0,
    confidence: 0,
    sources: [],
    appliedFilters: { documentTypes: null },
    timings: { embedMs: 0, searchMs: 0 },
  };
  if (!trimmed) return empty;

  const documentTypes = options.searchAllTypes
    ? null
    : (options.documentTypes ?? resolveDocumentTypes(trimmed, options.intent ?? 'policy_question'));

  const provider = getEmbeddingProvider();
  const store = getVectorStore();
  const thresholds = ragThresholds();

  const embedStart = Date.now();
  const [embedding] = await provider.embed([trimmed]);
  const embedMs = Date.now() - embedStart;
  if (!embedding) return empty;

  const searchStart = Date.now();
  let chunks = await store.search(embedding, {
    topK: options.topK ?? env.rag.topK,
    minSimilarity: options.minSimilarity ?? thresholds.minSimilarity,
    documentTypes,
    metadataFilter: options.metadataFilter ?? null,
  });
  let searchMs = Date.now() - searchStart;

  let confidence = computeConfidence(trimmed, chunks);
  let widened = false;

  // Widen once when the filtered search found nothing OR found only weak
  // matches.
  //
  // Filtering by document type is usually right, but the keyword hints that
  // drive it are imperfect: "price match guarantee" contains "guarantee", which
  // points at the warranty policy, so a price-match document filed under
  // returns would be locked out entirely. Retrying unfiltered and keeping
  // whichever result is genuinely better means a bad guess about the topic
  // costs a little latency instead of costing the customer their answer.
  // The confidence gate still decides whether the winner is good enough.
  if (documentTypes !== null && (chunks.length === 0 || confidence < thresholds.confidenceThreshold)) {
    const retryStart = Date.now();
    const wide = await store.search(embedding, {
      topK: options.topK ?? env.rag.topK,
      minSimilarity: options.minSimilarity ?? thresholds.minSimilarity,
      documentTypes: null,
      metadataFilter: options.metadataFilter ?? null,
    });
    searchMs += Date.now() - retryStart;

    const wideConfidence = computeConfidence(trimmed, wide);
    if (wide.length > 0 && wideConfidence > confidence) {
      chunks = wide;
      confidence = wideConfidence;
      widened = true;
      logger.debug('retrieval widened past the document-type filter', {
        correlationId: options.correlationId,
        documentTypes,
        confidence: wideConfidence,
      });
    }
  }

  const bestSimilarity = chunks[0]?.similarity ?? 0;

  const sources: RetrievedSource[] = chunks.map((c) => ({
    documentId: c.documentId,
    filename: c.filename,
    documentType: c.documentType,
    section: (c.metadata['section'] as string | undefined) ?? undefined,
    version: c.version,
    similarity: round(c.similarity, 3),
  }));

  let status: RetrievalResult['status'];
  if (chunks.length === 0) status = 'empty';
  else if (confidence < thresholds.confidenceThreshold) status = 'uncertain';
  else status = 'grounded';

  logger.debug('retrieval complete', {
    correlationId: options.correlationId,
    status,
    chunkCount: chunks.length,
    bestSimilarity: round(bestSimilarity, 3),
    confidence,
    documentTypes,
    embedMs,
    searchMs,
  });

  return {
    status,
    chunks,
    bestSimilarity: round(bestSimilarity, 3),
    confidence,
    sources,
    // Report the filter that actually produced the result, so an answer's
    // provenance is never described inaccurately.
    appliedFilters: { documentTypes: widened ? null : documentTypes },
    timings: { embedMs, searchMs },
  };
}
