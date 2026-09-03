/**
 * A single SQL surface over two transports.
 *
 *   PGliteClient  - embedded PostgreSQL 18 + pgvector, no server, no password.
 *                   Used for the local demo and the automated test suite.
 *   PgPoolClient  - node-postgres against a real PostgreSQL or Supabase.
 *
 * Both speak the same dialect and the same `$1` placeholder syntax, so the
 * repositories above this layer are written once and are identical in
 * development and production. Nothing here is a mock: PGlite is a genuine
 * PostgreSQL build compiled to WASM, running the project's real schema.
 */

import { mkdirSync } from 'node:fs';
import { env } from '../config/env.ts';
import { errors } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlClient {
  readonly kind: 'pglite' | 'postgres';
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run several statements as one unit. Rolls back on any throw. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  /** Execute a multi-statement script (schema files). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Shared query instrumentation                                               */
/* -------------------------------------------------------------------------- */

const SLOW_QUERY_MS = 500;

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0]?.slice(0, 120) ?? '';
}

function instrument<T>(sql: string, started: number, result: QueryResult<T>): QueryResult<T> {
  const ms = Date.now() - started;
  if (ms > SLOW_QUERY_MS) {
    logger.warn('slow query', { sql: firstLine(sql), durationMs: ms, rows: result.rowCount });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* PGlite (embedded)                                                          */
/* -------------------------------------------------------------------------- */

type PGliteLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec: (sql: string) => Promise<unknown>;
  transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

class PGliteClient implements SqlClient {
  readonly kind = 'pglite' as const;
  readonly db: PGliteLike;

  constructor(db: PGliteLike) {
    this.db = db;
  }

  static async create(dataDir: string): Promise<PGliteClient> {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');
    const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');

    // An in-memory database is used for tests so runs never contaminate
    // each other; anything else persists under data/pglite.
    const isMemory = dataDir === ':memory:' || env.isTest;
    if (!isMemory) mkdirSync(dataDir, { recursive: true });

    const db = await new PGlite({
      ...(isMemory ? {} : { dataDir }),
      extensions: { vector, citext, pgcrypto },
    });

    logger.info('database ready', { driver: 'pglite', location: isMemory ? 'memory' : dataDir });
    return new PGliteClient(db as unknown as PGliteLike);
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const started = Date.now();
    try {
      const res = await this.db.query(text, params);
      const rows = (res.rows ?? []) as T[];
      return instrument(text, started, { rows, rowCount: res.affectedRows ?? rows.length });
    } catch (err) {
      throw wrapDbError(err, text);
    }
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(new PGliteClient(tx as PGliteLike)));
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.db.exec(sql);
    } catch (err) {
      throw wrapDbError(err, sql);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* node-postgres (external PostgreSQL / Supabase)                             */
/* -------------------------------------------------------------------------- */

class PgPoolClient implements SqlClient {
  readonly kind = 'postgres' as const;

  // `pool` is a pg.Pool, or a checked-out pg.PoolClient when inside a tx.
  readonly pool: { query: Function; connect?: Function; end?: Function };
  readonly isTransaction: boolean;

  constructor(
    pool: { query: Function; connect?: Function; end?: Function },
    isTransaction = false,
  ) {
    this.pool = pool;
    this.isTransaction = isTransaction;
  }

  static async create(connectionString: string): Promise<PgPoolClient> {
    const pg = await import('pg');
    const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: new (c: unknown) => unknown }).Pool;

    const pool = new Pool({
      connectionString,
      max: env.db.poolMax,
      ssl: env.db.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      // Fail a stuck statement rather than holding a pool slot forever.
      statement_timeout: 15_000,
    }) as { query: Function; connect: Function; end: Function; on: Function };

    pool.on('error', (err: Error) => {
      logger.error('postgres pool error', { error: err.message });
    });

    // Prove connectivity at boot instead of failing mid-conversation.
    const probe = (await pool.query('SELECT current_database() AS db, version() AS v')) as {
      rows: Array<{ db: string; v: string }>;
    };
    logger.info('database ready', {
      driver: 'postgres',
      database: probe.rows[0]?.db,
      version: probe.rows[0]?.v.split(',')[0],
    });

    return new PgPoolClient(pool);
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const started = Date.now();
    try {
      const res = (await this.pool.query(text, params)) as { rows: T[]; rowCount: number | null };
      return instrument(text, started, { rows: res.rows, rowCount: res.rowCount ?? res.rows.length });
    } catch (err) {
      throw wrapDbError(err, text);
    }
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    if (this.isTransaction) return fn(this); // already inside one; join it
    const client = (await this.pool.connect!()) as {
      query: Function;
      release: () => void;
    };
    try {
      await client.query('BEGIN');
      const result = await fn(new PgPoolClient(client, true));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('rollback failed', { error: (rollbackErr as Error).message });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    // pg sends multi-statement strings in simple-query mode, which is what we
    // want for schema files.
    try {
      await this.pool.query(sql);
    } catch (err) {
      throw wrapDbError(err, sql);
    }
  }

  async close(): Promise<void> {
    if (!this.isTransaction && this.pool.end) await this.pool.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Error translation                                                          */
/* -------------------------------------------------------------------------- */

/** Postgres SQLSTATE codes we translate into domain errors. */
function wrapDbError(err: unknown, sql: string): Error {
  const e = err as { code?: string; message?: string; detail?: string; constraint?: string };
  const message = e?.message ?? 'database error';

  // 23505 unique_violation, 23503 fk_violation, 23514 check_violation
  if (e?.code === '23505') {
    return errors.database(`unique violation on ${e.constraint ?? 'constraint'}: ${message}`, err);
  }
  if (e?.code === '23503' || e?.code === '23514') {
    return errors.database(`constraint violation (${e.code}): ${message}`, err);
  }

  logger.error('database query failed', {
    sqlState: e?.code,
    sql: firstLine(sql),
    error: message,
  });
  return errors.database(message, err);
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export async function createSqlClient(): Promise<SqlClient> {
  if (env.db.driver === 'postgres') {
    if (!env.db.url) throw errors.configuration('DB_DRIVER=postgres but DATABASE_URL is empty.');
    return PgPoolClient.create(env.db.url);
  }
  return PGliteClient.create(env.db.pgliteDataDir);
}
