/**
 * Run the RAG ingestion pipeline over the local knowledge base.
 *
 *   npm run rag:ingest          # only changed documents
 *   npm run rag:reindex         # re-embed everything (use after changing
 *                               # EMBEDDING_PROVIDER - vectors from different
 *                               # models are not comparable)
 *
 * When GOOGLE_DRIVE_FOLDER_ID and a service-account key are configured, the
 * same pipeline runs against Drive instead - see scripts/sync-google-drive.ts.
 */

import { closeDatabase, getDb } from '../backend/src/database/index.ts';
import { ingestLocalKnowledgeBase } from '../backend/src/rag/ingest.ts';
import { knowledgeRepo } from '../backend/src/database/repositories/knowledge.repo.ts';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  // Ensure the schema exists before ingesting into it.
  await getDb();

  const result = await ingestLocalKnowledgeBase({ force });

  console.log('\n=== RAG ingestion summary ===');
  console.log(`Embedding provider : ${result.embeddingProvider}`);
  console.log(`Vector store       : ${result.vectorStore}`);
  console.log(`Processed          : ${result.processed}`);
  console.log(`  created          : ${result.created}`);
  console.log(`  updated          : ${result.updated}`);
  console.log(`  skipped          : ${result.skipped}`);
  console.log(`  failed           : ${result.failed}`);
  console.log(`Total chunks       : ${result.totalChunks}`);
  console.log(`Duration           : ${result.durationMs} ms\n`);

  for (const file of result.files) {
    const status = file.action.padEnd(18);
    const type = (file.documentType ?? '-').padEnd(20);
    console.log(`  ${status} ${type} ${String(file.chunks).padStart(3)} chunks  ${file.filename}`);
    if (file.error) console.log(`      error: ${file.error}`);
  }

  const stats = await knowledgeRepo.stats();
  console.log(
    `\nKnowledge base now holds ${stats.documents} active documents, ` +
      `${stats.chunks} chunks, ${stats.embedded} embedded.\n`,
  );

  await closeDatabase();
  if (result.failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('Ingestion failed:', err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
