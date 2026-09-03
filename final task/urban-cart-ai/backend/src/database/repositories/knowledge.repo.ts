/**
 * Knowledge repository: documents, chunks and pgvector similarity search.
 *
 * This is the pgvector-backed implementation. The Supabase implementation lives
 * in backend/src/rag/vector-store.ts and calls the identical SQL through the
 * `match_document_chunks` RPC, so retrieval behaviour is the same either way.
 */

import { getDb, type SqlClient } from '../index.ts';
import type { DocumentType, KnowledgeDocument, RetrievedChunk } from '../../models/types.ts';
import { env, ragThresholds } from '../../config/env.ts';

interface DocumentRow {
  id: string;
  filename: string;
  title: string | null;
  document_type: string;
  source: string;
  source_ref: string | null;
  mime_type: string | null;
  content_hash: string;
  version: number;
  status: string;
  chunk_count: number;
  char_count: number;
  effective_from: string | Date | null;
  metadata: unknown;
  updated_at: string | Date;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function mapDoc(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    filename: row.filename,
    title: row.title,
    documentType: row.document_type as DocumentType,
    source: row.source as KnowledgeDocument['source'],
    sourceRef: row.source_ref,
    mimeType: row.mime_type,
    contentHash: row.content_hash,
    version: Number(row.version),
    status: row.status as KnowledgeDocument['status'],
    chunkCount: Number(row.chunk_count),
    charCount: Number(row.char_count),
    effectiveFrom: row.effective_from
      ? row.effective_from instanceof Date
        ? row.effective_from.toISOString().slice(0, 10)
        : String(row.effective_from).slice(0, 10)
      : null,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

const DOC_COLUMNS = `id, filename, title, document_type, source, source_ref, mime_type,
                     content_hash, version, status, chunk_count, char_count,
                     effective_from, metadata, updated_at`;

/** pgvector wants a bracketed literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

export const knowledgeRepo = {
  async findActiveBySourceRef(
    source: string,
    sourceRef: string,
    tx?: SqlClient,
  ): Promise<KnowledgeDocument | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<DocumentRow>(
      `SELECT ${DOC_COLUMNS} FROM documents
       WHERE source = $1 AND source_ref = $2 AND status = 'active'`,
      [source, sourceRef],
    );
    return res.rows[0] ? mapDoc(res.rows[0]) : null;
  },

  /**
   * Replace the active version of a document and all its chunks, atomically.
   *
   * The previous active row is marked `superseded` rather than deleted, so the
   * provenance of an answer given last month is still explainable. Its chunks
   * are removed because only active documents are retrievable and keeping dead
   * vectors would bloat the ANN index.
   */
  async replaceDocument(
    doc: {
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
    },
    chunks: Array<{
      text: string;
      index: number;
      tokenEstimate: number;
      embedding: number[];
      metadata: Record<string, unknown>;
    }>,
    tx?: SqlClient,
  ): Promise<{ document: KnowledgeDocument; chunksWritten: number; action: 'created' | 'updated' }> {
    const outer = tx ?? (await getDb());

    return outer.transaction(async (t) => {
      const prior = await t.query<{ id: string; version: number }>(
        `SELECT id, version FROM documents
         WHERE source = $1 AND source_ref = $2 AND status = 'active'`,
        [doc.source, doc.sourceRef],
      );
      const previous = prior.rows[0];
      const nextVersion = previous ? Number(previous.version) + 1 : 1;

      if (previous) {
        // Free the partial unique index before inserting the new active row.
        await t.query(`UPDATE documents SET status = 'superseded' WHERE id = $1`, [previous.id]);
        await t.query('DELETE FROM document_chunks WHERE document_id = $1', [previous.id]);
      }

      const inserted = await t.query<DocumentRow>(
        `INSERT INTO documents
           (filename, title, document_type, source, source_ref, mime_type, content_hash,
            version, status, chunk_count, char_count, effective_from, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12::jsonb)
         RETURNING ${DOC_COLUMNS}`,
        [
          doc.filename,
          doc.title,
          doc.documentType,
          doc.source,
          doc.sourceRef,
          doc.mimeType,
          doc.contentHash,
          nextVersion,
          chunks.length,
          doc.charCount,
          doc.effectiveFrom,
          JSON.stringify(doc.metadata),
        ],
      );
      const docRow = inserted.rows[0];
      if (!docRow) throw new Error('document insert returned no row');

      for (const chunk of chunks) {
        await t.query(
          `INSERT INTO document_chunks
             (document_id, chunk_text, chunk_index, token_estimate, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)`,
          [
            docRow.id,
            chunk.text,
            chunk.index,
            chunk.tokenEstimate,
            toVectorLiteral(chunk.embedding),
            JSON.stringify(chunk.metadata),
          ],
        );
      }

      return {
        document: mapDoc(docRow),
        chunksWritten: chunks.length,
        action: previous ? ('updated' as const) : ('created' as const),
      };
    });
  },

  /**
   * Cosine similarity search over active documents.
   * Mirrors the Supabase `match_document_chunks` RPC exactly.
   */
  async searchSimilar(
    embedding: number[],
    options: {
      topK?: number;
      minSimilarity?: number;
      documentTypes?: DocumentType[] | null;
      metadataFilter?: Record<string, unknown> | null;
    } = {},
    tx?: SqlClient,
  ): Promise<RetrievedChunk[]> {
    const db = tx ?? (await getDb());
    const topK = options.topK ?? env.rag.topK;
    const minSimilarity = options.minSimilarity ?? ragThresholds().minSimilarity;

    const res = await db.query<{
      chunk_id: string;
      document_id: string;
      chunk_text: string;
      chunk_index: number;
      similarity: string;
      filename: string;
      title: string | null;
      document_type: string;
      version: number;
      effective_from: string | Date | null;
      metadata: unknown;
    }>(
      `SELECT * FROM match_document_chunks($1::vector, $2, $3, $4, $5::jsonb)`,
      [
        toVectorLiteral(embedding),
        topK,
        minSimilarity,
        options.documentTypes && options.documentTypes.length > 0 ? options.documentTypes : null,
        options.metadataFilter ? JSON.stringify(options.metadataFilter) : null,
      ],
    );

    return res.rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      chunkText: r.chunk_text,
      chunkIndex: Number(r.chunk_index),
      similarity: Number(r.similarity),
      filename: r.filename,
      title: r.title,
      documentType: r.document_type as DocumentType,
      version: Number(r.version),
      effectiveFrom: r.effective_from
        ? r.effective_from instanceof Date
          ? r.effective_from.toISOString().slice(0, 10)
          : String(r.effective_from).slice(0, 10)
        : null,
      metadata: parseJson<Record<string, unknown>>(r.metadata, {}),
    }));
  },

  async listDocuments(tx?: SqlClient): Promise<KnowledgeDocument[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<DocumentRow>(
      `SELECT ${DOC_COLUMNS} FROM documents WHERE status = 'active' ORDER BY document_type, filename`,
    );
    return res.rows.map(mapDoc);
  },

  async logIngestion(
    input: {
      documentId?: string | null;
      filename: string;
      sourceRef?: string | null;
      action: 'created' | 'updated' | 'skipped_unchanged' | 'failed' | 'deleted';
      chunksWritten?: number;
      durationMs?: number;
      errorMessage?: string | null;
      correlationId?: string | null;
    },
    tx?: SqlClient,
  ): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query(
      `INSERT INTO document_ingestion_log
         (document_id, filename, source_ref, action, chunks_written, duration_ms,
          error_message, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.documentId ?? null,
        input.filename,
        input.sourceRef ?? null,
        input.action,
        input.chunksWritten ?? 0,
        input.durationMs ?? null,
        input.errorMessage ? input.errorMessage.slice(0, 1000) : null,
        input.correlationId ?? null,
      ],
    );
  },

  async ingestionHistory(limit = 25, tx?: SqlClient) {
    const db = tx ?? (await getDb());
    const res = await db.query<{
      filename: string;
      action: string;
      chunks_written: number;
      duration_ms: number | null;
      error_message: string | null;
      created_at: string | Date;
    }>(
      `SELECT filename, action, chunks_written, duration_ms, error_message, created_at
       FROM document_ingestion_log ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows;
  },

  async stats(tx?: SqlClient): Promise<{ documents: number; chunks: number; embedded: number }> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ documents: string; chunks: string; embedded: string }>(
      `SELECT
         (SELECT count(*)::text FROM documents WHERE status = 'active') AS documents,
         (SELECT count(*)::text FROM document_chunks)                   AS chunks,
         (SELECT count(*)::text FROM document_chunks
                                WHERE embedding IS NOT NULL)            AS embedded`,
    );
    const r = res.rows[0];
    return {
      documents: Number(r?.documents ?? 0),
      chunks: Number(r?.chunks ?? 0),
      embedded: Number(r?.embedded ?? 0),
    };
  },
};
