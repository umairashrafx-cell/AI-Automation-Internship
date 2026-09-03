-- =============================================================================
-- UrbanCart AI Automation System
-- Supabase schema : VECTOR / RAG KNOWLEDGE STORE
-- =============================================================================
-- Runs unchanged on:
--   * Supabase (paste into the SQL Editor, or `supabase db push`)
--   * any PostgreSQL with the `vector` extension
--   * the embedded PGlite instance used for the local demo and the test suite
--
-- Why this is separate from database/schema.sql
--   Vector search and relational OLTP have opposite operational profiles.
--   Embeddings are large, immutable, rebuilt in bulk by an ingestion job, and
--   queried with an approximate index. Orders and leads are small, mutable,
--   and queried transactionally. Keeping them in separate stores means a
--   catalogue re-index can never slow down or lock the orders table, and each
--   store can be sized and scaled on its own.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- DOCUMENTS - one row per source file in Google Drive
-- =============================================================================
CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        TEXT        NOT NULL,
  title           TEXT,
  document_type   TEXT        NOT NULL CHECK (document_type IN (
                                'product_catalog','shipping_policy','return_policy',
                                'warranty_policy','support_guidelines','training','other')),
  -- Where the file came from, so we can re-fetch or attribute an answer.
  source          TEXT        NOT NULL DEFAULT 'google_drive'
                              CHECK (source IN ('google_drive','local','upload','notion')),
  source_ref      TEXT,       -- Google Drive fileId, or a relative local path
  mime_type       TEXT,
  -- SHA-256 of the extracted text. Ingestion is a no-op when this is unchanged,
  -- which makes the Drive poll idempotent and cheap.
  content_hash    TEXT        NOT NULL,
  version         INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Only 'active' documents are retrievable. Re-ingesting a changed file marks
  -- the previous row 'superseded' rather than deleting it, so an answer given
  -- last month can still be explained.
  status          TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','superseded','failed','processing')),
  language        TEXT        NOT NULL DEFAULT 'en',
  chunk_count     INTEGER     NOT NULL DEFAULT 0,
  char_count      INTEGER     NOT NULL DEFAULT 0,
  effective_from  DATE,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_type    ON documents (document_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_documents_status  ON documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_hash    ON documents (content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_srcref  ON documents (source, source_ref);
CREATE INDEX IF NOT EXISTS idx_documents_meta    ON documents USING GIN (metadata);

-- Exactly one ACTIVE version of a given source file at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_active_source
  ON documents (source, source_ref) WHERE status = 'active';

-- =============================================================================
-- DOCUMENT CHUNKS - the retrievable units, one embedding each
-- =============================================================================
CREATE TABLE IF NOT EXISTS document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_text    TEXT        NOT NULL CHECK (length(btrim(chunk_text)) > 0),
  chunk_index   INTEGER     NOT NULL CHECK (chunk_index >= 0),
  token_estimate INTEGER,
  -- 1536 dims = OpenAI text-embedding-3-small. The local demo provider emits
  -- the same width so the schema never changes between modes.
  embedding     vector(1536),
  -- Denormalised for cheap pre-filtering without joining documents:
  --   { "document_type", "section", "filename", "version", "heading" }
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON document_chunks USING GIN (metadata);

-- Approximate-nearest-neighbour index. HNSW gives better recall/latency than
-- IVFFlat and needs no training pass, but is only available in pgvector >= 0.5,
-- so we degrade to IVFFlat and finally to a sequential scan.
DO $idx$
BEGIN
  BEGIN
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
      ON document_chunks USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding_ivf
        ON document_chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'No ANN index available; similarity search will use a sequential scan.';
    END;
  END;
END
$idx$;

-- =============================================================================
-- INGESTION AUDIT - every ingestion attempt, successful or not
-- =============================================================================
CREATE TABLE IF NOT EXISTS document_ingestion_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    UUID        REFERENCES documents(id) ON DELETE SET NULL,
  filename       TEXT        NOT NULL,
  source_ref     TEXT,
  action         TEXT        NOT NULL CHECK (action IN ('created','updated','skipped_unchanged','failed','deleted')),
  chunks_written INTEGER     NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  error_message  TEXT,
  correlation_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_created ON document_ingestion_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_failed  ON document_ingestion_log (created_at DESC) WHERE action = 'failed';

-- =============================================================================
-- SIMILARITY SEARCH FUNCTION
-- =============================================================================
-- Called from the backend as a Supabase RPC:
--   supabase.rpc('match_document_chunks', { query_embedding, match_count, ... })
-- and as a plain SELECT when running against local pgvector.
--
-- Returns cosine SIMILARITY (1 = identical), not distance, so the calling code
-- compares against a single intuitive threshold.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding  vector(1536),
  match_count      INTEGER DEFAULT 5,
  min_similarity   DOUBLE PRECISION DEFAULT 0.25,
  filter_types     TEXT[]  DEFAULT NULL,
  filter_metadata  JSONB   DEFAULT NULL
)
RETURNS TABLE (
  chunk_id      UUID,
  document_id   UUID,
  chunk_text    TEXT,
  chunk_index   INTEGER,
  similarity    DOUBLE PRECISION,
  filename      TEXT,
  title         TEXT,
  document_type TEXT,
  version       INTEGER,
  effective_from DATE,
  metadata      JSONB
)
LANGUAGE sql
STABLE
AS $fn$
  SELECT
    c.id                                     AS chunk_id,
    d.id                                     AS document_id,
    c.chunk_text,
    c.chunk_index,
    (1 - (c.embedding <=> query_embedding))::DOUBLE PRECISION AS similarity,
    d.filename,
    d.title,
    d.document_type,
    d.version,
    d.effective_from,
    c.metadata
  FROM document_chunks c
  JOIN documents d ON d.id = c.document_id
  WHERE d.status = 'active'
    AND c.embedding IS NOT NULL
    -- Metadata pre-filtering: restrict to given document types, and/or require
    -- the chunk metadata to contain the supplied JSON fragment.
    AND (filter_types IS NULL OR d.document_type = ANY (filter_types))
    AND (filter_metadata IS NULL OR c.metadata @> filter_metadata)
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ORDER BY c.embedding <=> query_embedding,
           -- Prefer the newest effective version when scores tie.
           d.effective_from DESC NULLS LAST,
           d.version DESC
  LIMIT match_count;
$fn$;

-- Convenience view for the admin/knowledge endpoints.
CREATE OR REPLACE VIEW v_knowledge_base_status AS
SELECT d.id, d.filename, d.title, d.document_type, d.source, d.source_ref,
       d.version, d.status, d.chunk_count, d.char_count, d.effective_from,
       d.updated_at,
       (SELECT count(*) FROM document_chunks c
         WHERE c.document_id = d.id AND c.embedding IS NOT NULL) AS embedded_chunks
FROM documents d;

-- =============================================================================
-- ROW LEVEL SECURITY (Supabase only)
-- =============================================================================
-- The knowledge base is internal business information. Only the backend, which
-- authenticates with the service-role key, may read or write it. The anon key
-- (which ships to browsers) gets nothing. The DO block makes this a no-op on a
-- plain PostgreSQL or PGlite instance, where the `auth` schema does not exist.
-- -----------------------------------------------------------------------------
ALTER TABLE documents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_ingestion_log ENABLE ROW LEVEL SECURITY;

DO $rls$
BEGIN
  IF to_regnamespace('auth') IS NOT NULL THEN
    -- service_role bypasses RLS entirely in Supabase; these policies exist to
    -- make the intent explicit and to deny every other role by omission.
    DROP POLICY IF EXISTS documents_service_read  ON documents;
    DROP POLICY IF EXISTS chunks_service_read     ON document_chunks;
    DROP POLICY IF EXISTS ingestion_service_read  ON document_ingestion_log;

    CREATE POLICY documents_service_read ON documents
      FOR SELECT USING (auth.role() = 'service_role');
    CREATE POLICY chunks_service_read ON document_chunks
      FOR SELECT USING (auth.role() = 'service_role');
    CREATE POLICY ingestion_service_read ON document_ingestion_log
      FOR SELECT USING (auth.role() = 'service_role');

    RAISE NOTICE 'Supabase RLS policies applied (service_role only).';
  ELSE
    RAISE NOTICE 'auth schema not present - RLS enabled with no policies (deny all except superuser/owner).';
  END IF;
END
$rls$;

-- The RPC must be callable by the backend only.
REVOKE ALL ON FUNCTION match_document_chunks(vector, INTEGER, DOUBLE PRECISION, TEXT[], JSONB) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION match_document_chunks(vector, INTEGER, DOUBLE PRECISION, TEXT[], JSONB) TO service_role;
  END IF;
END
$grant$;
