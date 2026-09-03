/**
 * Drop the embedded PGlite database and rebuild it from schema.sql + seed.sql.
 *
 *   npm run db:reset
 *
 * Also the recovery path when PGlite reports "Aborted()" at startup: PGlite is
 * a single-process embedded database, so killing the server with SIGKILL while
 * it holds the data directory can leave it unreadable. Stop the server with
 * Ctrl+C (SIGINT) normally; use this when that did not happen.
 *
 * Refuses to run against an external PostgreSQL - deleting a real database is
 * not something a convenience script should be able to do.
 */

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, env } from '../backend/src/config/env.ts';
import { closeDatabase, getDb } from '../backend/src/database/index.ts';

async function main(): Promise<void> {
  if (env.db.driver !== 'pglite') {
    console.error(
      `Refusing to reset: DB_DRIVER is "${env.db.driver}", not "pglite".\n` +
        'This script only deletes the local embedded database. To reset an external\n' +
        'PostgreSQL, drop and recreate the database yourself, then run:\n' +
        '  npm run db:seed',
    );
    process.exit(1);
  }

  if (existsSync(env.db.pgliteDataDir)) {
    await rm(env.db.pgliteDataDir, { recursive: true, force: true });
    console.log(`Removed ${env.db.pgliteDataDir}`);
  }

  // getDb() recreates the directory and applies both schema files.
  const db = await getDb();
  await db.exec(readFileSync(join(PROJECT_ROOT, 'database', 'seed.sql'), 'utf8'));

  const counts = await db.query<{ products: string; customers: string; orders: string }>(
    `SELECT (SELECT count(*)::text FROM products)  AS products,
            (SELECT count(*)::text FROM customers) AS customers,
            (SELECT count(*)::text FROM orders)    AS orders`,
  );

  console.log('Database reset and seeded:', counts.rows[0]);
  console.log('Now run: npm run rag:ingest');
  await closeDatabase();
}

main().catch(async (err) => {
  console.error('Reset failed:', err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
