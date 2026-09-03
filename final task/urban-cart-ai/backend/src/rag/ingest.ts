/**
 * The RAG ingestion pipeline (Workflow 6).
 *
 *   Google Drive / local folder
 *     -> detect new or changed document
 *     -> download
 *     -> extract text
 *     -> clean text
 *     -> chunk
 *     -> generate embeddings
 *     -> store document metadata + chunks + vectors
 *     -> knowledge is live
 *
 * The requirement this satisfies: "We don't want developers changing the system
 * every time we update a PDF." Ingestion is idempotent and content-addressed -
 * re-running it on an unchanged corpus writes nothing and costs no embedding
 * calls, and dropping a new file into a folder is the entire publish process.
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { env } from '../config/env.ts';
import { logger } from '../utils/logger.ts';
import { toAppError } from '../utils/errors.ts';
import { knowledgeRepo } from '../database/repositories/knowledge.repo.ts';
import { newCorrelationId } from '../utils/misc.ts';
import type { DocumentType, KnowledgeDocument } from '../models/types.ts';
import { chunkDocument } from './chunker.ts';
import { getEmbeddingProvider } from './embeddings.ts';
import { extractFromBuffer, inferDocumentType, isSupported } from './extractors.ts';
import { getVectorStore } from './vector-store.ts';

export interface IngestionSourceFile {
  /** Stable identifier: Drive fileId, or the path relative to the KB root. */
  sourceRef: string;
  filename: string;
  buffer: Buffer;
  source: KnowledgeDocument['source'];
  /** Overrides folder-based inference when the caller already knows. */
  documentType?: DocumentType;
  /** Drive's modifiedTime, or the file mtime. */
  modifiedAt?: Date | null;
}

export interface IngestFileResult {
  filename: string;
  sourceRef: string;
  action: 'created' | 'updated' | 'skipped_unchanged' | 'failed';
  documentId?: string;
  documentType?: DocumentType;
  chunks: number;
  durationMs: number;
  error?: string;
}

export interface IngestRunResult {
  correlationId: string;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  totalChunks: number;
  durationMs: number;
  files: IngestFileResult[];
  embeddingProvider: string;
  vectorStore: string;
}

/**
 * Ingest one document.
 *
 * `force` re-embeds even when the content hash is unchanged - needed after
 * switching embedding providers, because vectors from different models are not
 * comparable and mixing them silently destroys retrieval quality.
 */
export async function ingestFile(
  file: IngestionSourceFile,
  options: { force?: boolean; correlationId?: string } = {},
): Promise<IngestFileResult> {
  const started = Date.now();
  const correlationId = options.correlationId ?? newCorrelationId();
  const log = logger.child({ correlationId, filename: file.filename });

  try {
    const extracted = await extractFromBuffer(file.buffer, file.filename);
    const documentType = file.documentType ?? inferDocumentType(file.sourceRef);
    const store = getVectorStore();

    // Change detection: identical extracted text means nothing to do.
    const existing = await store.findActive(file.source, file.sourceRef);
    if (existing && existing.contentHash === extracted.contentHash && !options.force) {
      await knowledgeRepo.logIngestion({
        documentId: existing.id,
        filename: file.filename,
        sourceRef: file.sourceRef,
        action: 'skipped_unchanged',
        durationMs: Date.now() - started,
        correlationId,
      });
      log.debug('document unchanged, skipping');
      return {
        filename: file.filename,
        sourceRef: file.sourceRef,
        action: 'skipped_unchanged',
        documentId: existing.id,
        documentType,
        chunks: existing.chunkCount,
        durationMs: Date.now() - started,
      };
    }

    // Prefer the document's own title; otherwise humanise the filename
    // ("urbancart-return-policy.pdf" -> "Urbancart Return Policy").
    const title =
      extracted.title ??
      basename(file.filename, extname(file.filename))
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();

    const chunks = chunkDocument(extracted.text, {
      baseMetadata: {
        filename: file.filename,
        document_type: documentType,
        source: file.source,
      },
    });

    if (chunks.length === 0) {
      throw toAppError(new Error('document produced no chunks'), 'DOCUMENT_PROCESSING_ERROR');
    }

    const provider = getEmbeddingProvider();
    const embeddings = await provider.embed(chunks.map((c) => c.text));
    if (embeddings.length !== chunks.length) {
      throw toAppError(
        new Error(`embedding count mismatch: ${embeddings.length} vs ${chunks.length} chunks`),
        'DOCUMENT_PROCESSING_ERROR',
      );
    }

    const written = await store.upsertDocument(
      {
        filename: file.filename,
        title,
        documentType,
        source: file.source,
        sourceRef: file.sourceRef,
        mimeType: extracted.mimeType,
        contentHash: extracted.contentHash,
        charCount: extracted.charCount,
        effectiveFrom: (file.modifiedAt ?? new Date()).toISOString().slice(0, 10),
        metadata: {
          ...extracted.meta,
          headings: extracted.headings.slice(0, 25),
          embeddingProvider: provider.name,
          embeddingModel: provider.name === 'openai' ? env.rag.embeddingModel : 'local-hashed-bow',
        },
      },
      chunks.map((c, i) => ({
        text: c.text,
        index: c.index,
        tokenEstimate: c.tokenEstimate,
        embedding: embeddings[i] ?? [],
        metadata: c.metadata,
      })),
    );

    const durationMs = Date.now() - started;
    await knowledgeRepo.logIngestion({
      documentId: written.document.id,
      filename: file.filename,
      sourceRef: file.sourceRef,
      action: written.action,
      chunksWritten: written.chunksWritten,
      durationMs,
      correlationId,
    });

    log.info('document ingested', {
      action: written.action,
      documentType,
      chunks: written.chunksWritten,
      version: written.document.version,
      durationMs,
    });

    return {
      filename: file.filename,
      sourceRef: file.sourceRef,
      action: written.action,
      documentId: written.document.id,
      documentType,
      chunks: written.chunksWritten,
      durationMs,
    };
  } catch (err) {
    const appErr = toAppError(err, 'DOCUMENT_PROCESSING_ERROR');
    const durationMs = Date.now() - started;
    log.error('document ingestion failed', { error: appErr.message });

    // Best-effort audit row; a logging failure must not mask the real error.
    await knowledgeRepo
      .logIngestion({
        filename: file.filename,
        sourceRef: file.sourceRef,
        action: 'failed',
        durationMs,
        errorMessage: appErr.message,
        correlationId,
      })
      .catch(() => undefined);

    return {
      filename: file.filename,
      sourceRef: file.sourceRef,
      action: 'failed',
      chunks: 0,
      durationMs,
      error: appErr.message,
    };
  }
}

/** Recursively list every supported file under a directory. */
async function walk(dir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, root)));
    } else if (entry.isFile() && isSupported(entry.name) && !entry.name.startsWith('~$')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Ingest every supported document under the local knowledge-base directory.
 *
 * This mirrors the Google Drive folder exactly (same folder names, same files),
 * so the pipeline is identical whether documents arrive from Drive or from
 * disk - only the fetch step differs.
 */
export async function ingestLocalKnowledgeBase(
  options: { force?: boolean; correlationId?: string } = {},
): Promise<IngestRunResult> {
  const started = Date.now();
  const correlationId = options.correlationId ?? newCorrelationId();
  const root = env.rag.knowledgeBaseDir;
  const files = await walk(root, root);

  logger.info('ingestion run started', {
    correlationId,
    root,
    fileCount: files.length,
    force: options.force ?? false,
  });

  const results: IngestFileResult[] = [];
  for (const path of files) {
    const buffer = await readFile(path);
    const stats = await stat(path);
    const sourceRef = relative(root, path).replace(/\\/g, '/');
    results.push(
      await ingestFile(
        {
          sourceRef,
          filename: basename(path),
          buffer,
          source: 'local',
          modifiedAt: stats.mtime,
        },
        { force: options.force ?? false, correlationId },
      ),
    );
  }

  const summary: IngestRunResult = {
    correlationId,
    processed: results.length,
    created: results.filter((r) => r.action === 'created').length,
    updated: results.filter((r) => r.action === 'updated').length,
    skipped: results.filter((r) => r.action === 'skipped_unchanged').length,
    failed: results.filter((r) => r.action === 'failed').length,
    totalChunks: results.reduce((sum, r) => sum + r.chunks, 0),
    durationMs: Date.now() - started,
    files: results,
    embeddingProvider: getEmbeddingProvider().name,
    vectorStore: getVectorStore().kind,
  };

  logger.info('ingestion run complete', {
    correlationId,
    processed: summary.processed,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
    failed: summary.failed,
    totalChunks: summary.totalChunks,
    durationMs: summary.durationMs,
  });

  return summary;
}
