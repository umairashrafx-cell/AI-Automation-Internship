/**
 * Stage 6 of the RAG pipeline: the vector store.
 *
 * Two backends behind one interface. Both execute the SAME SQL - the Supabase
 * backend calls `match_document_chunks` as an RPC, the pgvector backend calls
 * the identical function through the SQL client - so retrieval semantics,
 * ranking and metadata filtering are guaranteed to be identical whichever is
 * configured. That is deliberate: the demo you can run offline behaves the same
 * as the production deployment.
 */

import { env, integrationReadiness, ragThresholds, resolvedVectorStore } from '../config/env.ts';
import { knowledgeRepo, toVectorLiteral } from '../database/repositories/knowledge.repo.ts';
import type { DocumentType, KnowledgeDocument, RetrievedChunk } from '../models/types.ts';
import { errors } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { withTimeout } from '../utils/misc.ts';

export interface SearchOptions {
  topK?: number;
  minSimilarity?: number;
  /** Restrict to these document types - the main metadata filter. */
  documentTypes?: DocumentType[] | null;
  /** JSONB containment filter on chunk metadata, e.g. { section: "Returns" }. */
  metadataFilter?: Record<string, unknown> | null;
}

export interface UpsertDocumentInput {
  filename: string;
  title: string | null;
  documentType: DocumentType;
  source: KnowledgeDocument['source'];
  sourceRef: string;
  mimeType: string | null;
  contentHash: string;
  charCount: number;
  effectiveFrom: string | null;
  metadata: Record<string, unknown>;
}

export interface UpsertChunk {
  text: string;
  index: number;
  tokenEstimate: number;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  readonly kind: 'supabase' | 'pgvector';
  search(embedding: number[], options?: SearchOptions): Promise<RetrievedChunk[]>;
  upsertDocument(
    doc: UpsertDocumentInput,
    chunks: UpsertChunk[],
  ): Promise<{ document: KnowledgeDocument; chunksWritten: number; action: 'created' | 'updated' }>;
  findActive(source: string, sourceRef: string): Promise<KnowledgeDocument | null>;
  listDocuments(): Promise<KnowledgeDocument[]>;
  stats(): Promise<{ documents: number; chunks: number; embedded: number }>;
}

/* -------------------------------------------------------------------------- */
/* pgvector backend (local PostgreSQL / PGlite)                               */
/* -------------------------------------------------------------------------- */

class PgVectorStore implements VectorStore {
  readonly kind = 'pgvector' as const;

  async search(embedding: number[], options: SearchOptions = {}): Promise<RetrievedChunk[]> {
    return knowledgeRepo.searchSimilar(embedding, options);
  }

  async upsertDocument(doc: UpsertDocumentInput, chunks: UpsertChunk[]) {
    return knowledgeRepo.replaceDocument(doc, chunks);
  }

  async findActive(source: string, sourceRef: string) {
    return knowledgeRepo.findActiveBySourceRef(source, sourceRef);
  }

  async listDocuments() {
    return knowledgeRepo.listDocuments();
  }

  async stats() {
    return knowledgeRepo.stats();
  }
}

/* -------------------------------------------------------------------------- */
/* Supabase backend                                                           */
/* -------------------------------------------------------------------------- */

const SUPABASE_TIMEOUT_MS = 15_000;

type SupabaseClientLike = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown,
      ) => {
        eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
        order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }>;
      };
    };
    insert: (rows: unknown) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> };
    update: (row: unknown) => { eq: (c: string, v: unknown) => Promise<{ error: unknown }> };
    delete: () => { eq: (c: string, v: unknown) => Promise<{ error: unknown }> };
  };
};

class SupabaseVectorStore implements VectorStore {
  readonly kind = 'supabase' as const;
  private client: SupabaseClientLike | null = null;

  private async getClient(): Promise<SupabaseClientLike> {
    if (this.client) return this.client;
    if (!integrationReadiness.supabase) {
      throw errors.configuration(
        'Supabase vector store selected but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.',
      );
    }
    const { createClient } = await import('@supabase/supabase-js');
    // The service-role key bypasses RLS. It is server-only and must never be
    // shipped to a browser - see the RLS section of supabase-schema.sql.
    this.client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as SupabaseClientLike;
    logger.info('vector store', { kind: 'supabase', url: env.supabase.url.replace(/https?:\/\//, '') });
    return this.client;
  }

  async search(embedding: number[], options: SearchOptions = {}): Promise<RetrievedChunk[]> {
    const client = await this.getClient();
    const { data, error } = await withTimeout(
      client.rpc('match_document_chunks', {
        query_embedding: toVectorLiteral(embedding),
        match_count: options.topK ?? env.rag.topK,
        min_similarity: options.minSimilarity ?? ragThresholds().minSimilarity,
        filter_types:
          options.documentTypes && options.documentTypes.length > 0 ? options.documentTypes : null,
        filter_metadata: options.metadataFilter ?? null,
      }),
      SUPABASE_TIMEOUT_MS,
      () => errors.upstreamTimeout('supabase-rpc', SUPABASE_TIMEOUT_MS),
    );

    if (error) {
      throw new (await import('../utils/errors.ts')).AppError(
        'VECTOR_STORE_ERROR',
        `supabase match_document_chunks failed: ${JSON.stringify(error).slice(0, 300)}`,
      );
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      chunkId: String(r['chunk_id']),
      documentId: String(r['document_id']),
      chunkText: String(r['chunk_text']),
      chunkIndex: Number(r['chunk_index']),
      similarity: Number(r['similarity']),
      filename: String(r['filename']),
      title: (r['title'] as string | null) ?? null,
      documentType: r['document_type'] as DocumentType,
      version: Number(r['version']),
      effectiveFrom: (r['effective_from'] as string | null) ?? null,
      metadata: (r['metadata'] as Record<string, unknown>) ?? {},
    }));
  }

  async upsertDocument(doc: UpsertDocumentInput, chunks: UpsertChunk[]) {
    const client = await this.getClient();

    // Supersede the previous active version, then insert the new one.
    const existing = (await client
      .from('documents')
      .select('id, version')
      .eq('source', doc.source)
      .eq('source_ref', doc.sourceRef)
      .maybeSingle()) as { data: { id: string; version: number } | null; error: unknown };

    const previous = existing.data;
    const nextVersion = previous ? Number(previous.version) + 1 : 1;

    if (previous) {
      await client.from('documents').update({ status: 'superseded' }).eq('id', previous.id);
      await client.from('document_chunks').delete().eq('document_id', previous.id);
    }

    const inserted = (await client
      .from('documents')
      .insert({
        filename: doc.filename,
        title: doc.title,
        document_type: doc.documentType,
        source: doc.source,
        source_ref: doc.sourceRef,
        mime_type: doc.mimeType,
        content_hash: doc.contentHash,
        version: nextVersion,
        status: 'active',
        chunk_count: chunks.length,
        char_count: doc.charCount,
        effective_from: doc.effectiveFrom,
        metadata: doc.metadata,
      })
      .select('*')) as { data: Array<Record<string, unknown>> | null; error: unknown };

    if (inserted.error || !inserted.data?.[0]) {
      throw errors.upstream('supabase', `document insert failed: ${JSON.stringify(inserted.error)}`);
    }
    const row = inserted.data[0];
    const documentId = String(row['id']);

    if (chunks.length > 0) {
      const payload = chunks.map((c) => ({
        document_id: documentId,
        chunk_text: c.text,
        chunk_index: c.index,
        token_estimate: c.tokenEstimate,
        embedding: toVectorLiteral(c.embedding),
        metadata: c.metadata,
      }));
      const chunkInsert = (await client
        .from('document_chunks')
        .insert(payload)
        .select('id')) as { data: unknown; error: unknown };
      if (chunkInsert.error) {
        throw errors.upstream('supabase', `chunk insert failed: ${JSON.stringify(chunkInsert.error)}`);
      }
    }

    return {
      document: {
        id: documentId,
        filename: doc.filename,
        title: doc.title,
        documentType: doc.documentType,
        source: doc.source,
        sourceRef: doc.sourceRef,
        mimeType: doc.mimeType,
        contentHash: doc.contentHash,
        version: nextVersion,
        status: 'active' as const,
        chunkCount: chunks.length,
        charCount: doc.charCount,
        effectiveFrom: doc.effectiveFrom,
        metadata: doc.metadata,
        updatedAt: new Date().toISOString(),
      },
      chunksWritten: chunks.length,
      action: previous ? ('updated' as const) : ('created' as const),
    };
  }

  async findActive(source: string, sourceRef: string): Promise<KnowledgeDocument | null> {
    const client = await this.getClient();
    const res = (await client
      .from('documents')
      .select('*')
      .eq('source', source)
      .eq('source_ref', sourceRef)
      .maybeSingle()) as { data: Record<string, unknown> | null; error: unknown };

    const row = res.data;
    if (!row || row['status'] !== 'active') return null;
    return {
      id: String(row['id']),
      filename: String(row['filename']),
      title: (row['title'] as string | null) ?? null,
      documentType: row['document_type'] as DocumentType,
      source: row['source'] as KnowledgeDocument['source'],
      sourceRef: (row['source_ref'] as string | null) ?? null,
      mimeType: (row['mime_type'] as string | null) ?? null,
      contentHash: String(row['content_hash']),
      version: Number(row['version']),
      status: 'active',
      chunkCount: Number(row['chunk_count'] ?? 0),
      charCount: Number(row['char_count'] ?? 0),
      effectiveFrom: (row['effective_from'] as string | null) ?? null,
      metadata: (row['metadata'] as Record<string, unknown>) ?? {},
      updatedAt: String(row['updated_at'] ?? new Date().toISOString()),
    };
  }

  async listDocuments(): Promise<KnowledgeDocument[]> {
    const client = await this.getClient();
    const res = (await client
      .from('documents')
      .select('*')
      .eq('status', 'active')
      .order('document_type', { ascending: true })) as {
      data: Array<Record<string, unknown>> | null;
      error: unknown;
    };
    return (res.data ?? []).map((row) => ({
      id: String(row['id']),
      filename: String(row['filename']),
      title: (row['title'] as string | null) ?? null,
      documentType: row['document_type'] as DocumentType,
      source: row['source'] as KnowledgeDocument['source'],
      sourceRef: (row['source_ref'] as string | null) ?? null,
      mimeType: (row['mime_type'] as string | null) ?? null,
      contentHash: String(row['content_hash']),
      version: Number(row['version']),
      status: 'active' as const,
      chunkCount: Number(row['chunk_count'] ?? 0),
      charCount: Number(row['char_count'] ?? 0),
      effectiveFrom: (row['effective_from'] as string | null) ?? null,
      metadata: (row['metadata'] as Record<string, unknown>) ?? {},
      updatedAt: String(row['updated_at'] ?? ''),
    }));
  }

  async stats() {
    const docs = await this.listDocuments();
    const chunks = docs.reduce((sum, d) => sum + d.chunkCount, 0);
    return { documents: docs.length, chunks, embedded: chunks };
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

let store: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (store) return store;
  store = resolvedVectorStore() === 'supabase' ? new SupabaseVectorStore() : new PgVectorStore();
  logger.info('vector store selected', { kind: store.kind });
  return store;
}

export function resetVectorStore(): void {
  store = null;
}
