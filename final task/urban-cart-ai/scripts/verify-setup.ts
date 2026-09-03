/**
 * Check that the system is correctly set up and report exactly what is live,
 * what is degraded, and what is running in dry-run.
 *
 *   npm run verify
 *
 * Written to be the first thing anyone runs after cloning, and the first thing
 * to run when something is behaving oddly.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_ROOT,
  env,
  integrationReadiness,
  resolvedEmbeddingProvider,
  resolvedLlmProvider,
  resolvedVectorStore,
  ragThresholds,
  validateEnvironment,
} from '../backend/src/config/env.ts';
import { closeDatabase, getDb } from '../backend/src/database/index.ts';
import { knowledgeRepo } from '../backend/src/database/repositories/knowledge.repo.ts';
import { retrieve } from '../backend/src/rag/retriever.ts';

const PASS = '  [ok]   ';
const WARN = '  [warn] ';
const FAIL = '  [FAIL] ';

let failures = 0;
let warnings = 0;

function pass(msg: string) {
  console.log(PASS + msg);
}
function warn(msg: string) {
  warnings++;
  console.log(WARN + msg);
}
function fail(msg: string) {
  failures++;
  console.log(FAIL + msg);
}

async function main(): Promise<void> {
  console.log('\n=== UrbanCart AI - setup verification ===\n');

  /* ---- Node ------------------------------------------------------------ */
  console.log('Runtime');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) pass(`Node ${process.versions.node} (native TypeScript supported)`);
  else fail(`Node ${process.versions.node} - version 22.6 or newer is required to run .ts directly`);

  /* ---- Configuration --------------------------------------------------- */
  console.log('\nConfiguration');
  if (existsSync(join(PROJECT_ROOT, '.env'))) pass('.env found');
  else warn('.env not found - defaults are being used (copy .env.example to .env)');

  const { errors, warnings: configWarnings } = validateEnvironment();
  for (const e of errors) fail(e);
  for (const w of configWarnings) warn(w);
  if (errors.length === 0) pass('configuration is valid');

  /* ---- Database -------------------------------------------------------- */
  console.log('\nDatabase');
  try {
    const db = await getDb();
    const tables = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    pass(`${env.db.driver} connected, ${tables.rows[0]?.count} tables`);

    const seed = await db.query<{ products: string; customers: string; orders: string }>(
      `SELECT (SELECT count(*)::text FROM products)  AS products,
              (SELECT count(*)::text FROM customers) AS customers,
              (SELECT count(*)::text FROM orders)    AS orders`,
    );
    const row = seed.rows[0];
    if (Number(row?.products ?? 0) > 0) {
      pass(`seed data: ${row?.products} products, ${row?.customers} customers, ${row?.orders} orders`);
    } else {
      warn('no seed data - run `npm run db:seed`');
    }

    const uc = await db.query('SELECT 1 FROM orders WHERE order_number = $1', ['UC-10452']);
    if (uc.rows.length > 0) pass('demo order UC-10452 present');
    else warn('demo order UC-10452 missing - run `npm run db:seed`');
  } catch (err) {
    fail(`database unreachable: ${(err as Error).message}`);
    if (env.db.driver === 'pglite' && /abort/i.test((err as Error).message)) {
      console.log(
        '         PGlite data directory looks corrupt (this happens if the server\n' +
          '         was killed rather than stopped). Recover with: npm run db:reset',
      );
    }
  }

  /* ---- Knowledge base -------------------------------------------------- */
  console.log('\nKnowledge base (RAG)');
  try {
    const stats = await knowledgeRepo.stats();
    if (stats.documents === 0) {
      warn('no documents ingested - run `npm run kb:generate && npm run rag:ingest`');
    } else {
      pass(`${stats.documents} documents, ${stats.chunks} chunks, ${stats.embedded} embedded`);
      if (stats.embedded < stats.chunks) {
        fail(`${stats.chunks - stats.embedded} chunk(s) have no embedding - re-run \`npm run rag:reindex\``);
      }

      // Prove retrieval end-to-end, not just that rows exist.
      const probe = await retrieve('Can I return headphones after 10 days?', {
        intent: 'policy_question',
      });
      if (probe.status === 'grounded') {
        pass(
          `retrieval probe grounded (confidence ${probe.confidence}, top source ${probe.sources[0]?.filename})`,
        );
      } else {
        fail(`retrieval probe returned "${probe.status}" - the knowledge base may need re-indexing`);
      }
    }
  } catch (err) {
    fail(`knowledge base check failed: ${(err as Error).message}`);
  }

  /* ---- AI components --------------------------------------------------- */
  console.log('\nAI components');
  const embedding = resolvedEmbeddingProvider();
  if (embedding === 'openai') pass(`embeddings: OpenAI ${env.rag.embeddingModel}`);
  else warn('embeddings: LOCAL hashed bag-of-words (lexical only, demo quality)');

  const llm = resolvedLlmProvider();
  if (llm === 'anthropic') pass(`answers: Anthropic ${env.llm.anthropicModel}`);
  else if (llm === 'openai') pass('answers: OpenAI');
  else warn('answers: EXTRACTIVE (verbatim document quotes, no LLM call)');

  pass(`vector store: ${resolvedVectorStore()}`);
  const t = ragThresholds();
  pass(`thresholds: minSimilarity ${t.minSimilarity}, confidence ${t.confidenceThreshold}`);

  /* ---- Integrations ---------------------------------------------------- */
  console.log('\nIntegrations');
  const dryRun: string[] = [];
  for (const [name, ready] of Object.entries(integrationReadiness)) {
    if (ready) pass(`${name}: live`);
    else dryRun.push(name);
  }
  if (dryRun.length > 0) {
    warn(`dry-run (payloads recorded, nothing sent): ${dryRun.join(', ')}`);
  }

  /* ---- Artefacts ------------------------------------------------------- */
  console.log('\nProject artefacts');
  const artefacts: Array<[string, string]> = [
    ['knowledge-base/Returns/urbancart-return-policy.pdf', 'return policy PDF'],
    ['knowledge-base/Warranty/urbancart-warranty-policy.docx', 'warranty policy DOCX'],
    ['knowledge-base/Products/urbancart-product-catalog.xlsx', 'product catalogue XLSX'],
    ['n8n/workflows/01-customer-chat-request.json', 'n8n workflows'],
    ['vapi/assistant.json', 'Vapi assistant config'],
    ['database/schema.sql', 'PostgreSQL schema'],
    ['database/supabase-schema.sql', 'Supabase vector schema'],
    ['frontend/index.html', 'chat interface'],
  ];
  for (const [path, label] of artefacts) {
    if (existsSync(join(PROJECT_ROOT, path))) pass(`${label} present`);
    else fail(`${label} missing (${path})`);
  }

  /* ---- Summary --------------------------------------------------------- */
  console.log('\n' + '='.repeat(60));
  if (failures === 0 && warnings === 0) {
    console.log('Everything is configured and live. Run `npm start`.');
  } else if (failures === 0) {
    console.log(
      `Ready to run with ${warnings} warning(s).\n` +
        'Warnings are expected without third-party credentials - the system runs\n' +
        'fully, with degraded AI quality and integrations in dry-run.\n\n' +
        'Start it with: npm start',
    );
  } else {
    console.log(`${failures} failure(s) and ${warnings} warning(s). Fix the failures above first.`);
  }
  console.log('='.repeat(60) + '\n');

  await closeDatabase();
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch(async (err) => {
  console.error('Verification crashed:', err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
