/**
 * Test bootstrap.
 *
 * NODE_ENV=test makes the PGlite client use an IN-MEMORY database, so each test
 * file gets a private PostgreSQL instance that starts empty and leaves nothing
 * behind. The schema, the seed data and the RAG index are all built from the
 * same files the application uses - the tests exercise the real pipeline, not a
 * fixture of it.
 */

// MUST be the first import: it sets the environment before the config is read.
import './env.ts';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../backend/src/config/env.ts';
import { closeDatabase, getDb } from '../../backend/src/database/index.ts';
import { ingestLocalKnowledgeBase } from '../../backend/src/rag/ingest.ts';

let ready: Promise<void> | null = null;

/** Schema + seed + knowledge base. Idempotent, and shared by all tests in a file. */
export function bootstrap(options: { withKnowledge?: boolean } = {}): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const db = await getDb();
    db.exec.bind(db);
    await db.exec(readFileSync(join(PROJECT_ROOT, 'database', 'seed.sql'), 'utf8'));
    if (options.withKnowledge !== false) {
      await ingestLocalKnowledgeBase({ force: false });
    }
  })();
  return ready;
}

export async function teardown(): Promise<void> {
  await closeDatabase();
  ready = null;
}

/** Unique session id so tests never share conversation state. */
let sessionCounter = 0;
export function session(prefix = 'test'): string {
  sessionCounter += 1;
  return `${prefix}-${process.pid}-${sessionCounter}`;
}

/**
 * Records a documented test case so the suite doubles as the evidence table the
 * assignment asks for (input, expected, actual, components, pass/fail).
 */
export interface TestRecord {
  id: string;
  name: string;
  input: string;
  expected: string;
  actual: string;
  components: string[];
  passed: boolean;
}

export const results: TestRecord[] = [];

export function record(entry: TestRecord): void {
  results.push(entry);
}
