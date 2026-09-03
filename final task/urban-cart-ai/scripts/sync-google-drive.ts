/**
 * Ingest the knowledge base from Google Drive.
 *
 *   npm run drive:sync
 *   npm run drive:sync -- --force     # re-embed everything
 *
 * This is the production path for Workflow 6. It lists the Drive folder,
 * downloads anything new or changed, and hands each file to exactly the same
 * ingestion pipeline the local knowledge base uses - only the fetch step
 * differs, so a document behaves identically whichever source it came from.
 *
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_DRIVE_FOLDER_ID.
 */

import { env, integrationReadiness } from '../backend/src/config/env.ts';
import { closeDatabase, getDb } from '../backend/src/database/index.ts';
import { googleDriveConnector } from '../backend/src/connectors/google-drive.connector.ts';
import { ingestFile } from '../backend/src/rag/ingest.ts';
import { getEmbeddingProvider } from '../backend/src/rag/embeddings.ts';
import { getVectorStore } from '../backend/src/rag/vector-store.ts';
import { knowledgeRepo } from '../backend/src/database/repositories/knowledge.repo.ts';
import { newCorrelationId } from '../backend/src/utils/misc.ts';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const correlationId = newCorrelationId();

  if (!integrationReadiness.googleDrive) {
    console.error(
      '\nGoogle Drive is not configured.\n\n' +
        'Unlike the other integrations this one CANNOT be dry-run: there is no\n' +
        'document to ingest without real credentials, and inventing one would be\n' +
        'faking the pipeline. Use the local knowledge base instead:\n\n' +
        '    npm run rag:ingest\n\n' +
        'To connect Drive:\n' +
        '  1. Google Cloud Console -> create a project\n' +
        '  2. Enable the Google Drive API\n' +
        '  3. Create a Service Account, add a JSON key, download it\n' +
        '  4. In Drive, share the "UrbanCart Knowledge Base" folder (Viewer)\n' +
        '     with the service account email\n' +
        '  5. Set in .env:\n' +
        '       GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./google-service-account.json\n' +
        '       GOOGLE_DRIVE_FOLDER_ID=<folder id from the Drive URL>\n',
    );
    process.exit(1);
  }

  await getDb();
  const started = Date.now();

  console.log(`Listing Google Drive folder ${env.googleDrive.folderId} …`);
  const files = await googleDriveConnector.listKnowledgeBase();
  console.log(`Found ${files.length} supported document(s).\n`);

  const results = [];
  for (const file of files) {
    process.stdout.write(`  ${file.relativePath.padEnd(52)} `);
    const buffer = await googleDriveConnector.downloadFile(file);

    const result = await ingestFile(
      {
        // The Drive fileId is the stable key: renaming a file in Drive must
        // update the existing document, not create a duplicate.
        sourceRef: file.id,
        filename: file.name,
        buffer,
        source: 'google_drive',
        modifiedAt: new Date(file.modifiedTime),
      },
      { force, correlationId },
    );

    results.push(result);
    console.log(
      result.action === 'failed'
        ? `FAILED - ${result.error}`
        : `${result.action} (${result.chunks} chunks)`,
    );
  }

  const summary = {
    processed: results.length,
    created: results.filter((r) => r.action === 'created').length,
    updated: results.filter((r) => r.action === 'updated').length,
    skipped: results.filter((r) => r.action === 'skipped_unchanged').length,
    failed: results.filter((r) => r.action === 'failed').length,
    chunks: results.reduce((sum, r) => sum + r.chunks, 0),
  };

  const stats = await knowledgeRepo.stats();

  console.log('\n=== Google Drive sync complete ===');
  console.log(`  embedding provider : ${getEmbeddingProvider().name}`);
  console.log(`  vector store       : ${getVectorStore().kind}`);
  console.log(`  processed          : ${summary.processed}`);
  console.log(`    created          : ${summary.created}`);
  console.log(`    updated          : ${summary.updated}`);
  console.log(`    skipped          : ${summary.skipped}`);
  console.log(`    failed           : ${summary.failed}`);
  console.log(`  chunks written     : ${summary.chunks}`);
  console.log(`  duration           : ${Date.now() - started} ms`);
  console.log(
    `\nKnowledge base: ${stats.documents} active documents, ${stats.chunks} chunks, ${stats.embedded} embedded.\n`,
  );

  await closeDatabase();
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('Google Drive sync failed:', err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
