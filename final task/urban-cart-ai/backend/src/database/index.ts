/**
 * Database lifecycle: one lazily-created client per process, plus schema
 * application.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, env, resolvedVectorStore } from '../config/env.ts';
import { createSqlClient, type SqlClient } from './sql-client.ts';
import { logger } from '../utils/logger.ts';
import { errors } from '../utils/errors.ts';

let client: SqlClient | null = null;
let initPromise: Promise<SqlClient> | null = null;

const SCHEMA_FILE = join(PROJECT_ROOT, 'database', 'schema.sql');
const VECTOR_SCHEMA_FILE = join(PROJECT_ROOT, 'database', 'supabase-schema.sql');

/**
 * Get the shared client, creating and migrating it on first use.
 * Concurrent callers share one initialisation.
 */
export async function getDb(): Promise<SqlClient> {
  if (client) return client;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const c = await createSqlClient();
    await applySchemas(c);
    client = c;
    return c;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

/**
 * Apply the relational schema, and the vector schema when vectors live in this
 * same database. Both scripts are idempotent (CREATE ... IF NOT EXISTS), so
 * running them on every boot is safe and keeps a fresh checkout working with a
 * single `npm start`.
 */
export async function applySchemas(c: SqlClient): Promise<void> {
  if (!existsSync(SCHEMA_FILE)) {
    throw errors.configuration(`Relational schema not found at ${SCHEMA_FILE}`);
  }

  await c.exec(readFileSync(SCHEMA_FILE, 'utf8'));
  logger.info('relational schema applied', { file: 'database/schema.sql' });

  if (resolvedVectorStore() === 'pgvector') {
    if (!existsSync(VECTOR_SCHEMA_FILE)) {
      throw errors.configuration(`Vector schema not found at ${VECTOR_SCHEMA_FILE}`);
    }
    await c.exec(readFileSync(VECTOR_SCHEMA_FILE, 'utf8'));
    logger.info('vector schema applied', {
      file: 'database/supabase-schema.sql',
      target: env.db.driver,
    });
  } else {
    logger.info('vector schema skipped', {
      reason: 'VECTOR_STORE resolves to supabase; apply supabase-schema.sql there',
    });
  }
}

/** Close the pool / embedded database. Used by tests and graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    initPromise = null;
  }
}

/** Cheap liveness probe used by /health. */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const db = await getDb();
    await db.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

export type { SqlClient, QueryResult } from './sql-client.ts';
