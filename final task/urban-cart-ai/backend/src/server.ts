/**
 * Process entry point: validate configuration, warm the database, listen, and
 * shut down cleanly.
 */

import { createApp } from './app.ts';
import {
  env,
  integrationReadiness,
  resolvedEmbeddingProvider,
  resolvedLlmProvider,
  resolvedVectorStore,
  validateEnvironment,
} from './config/env.ts';
import { closeDatabase, getDb } from './database/index.ts';
import { knowledgeRepo } from './database/repositories/knowledge.repo.ts';
import { logger } from './utils/logger.ts';

async function main(): Promise<void> {
  /* ---- 1. Configuration ------------------------------------------------ */
  const { errors: configErrors, warnings } = validateEnvironment();

  for (const warning of warnings) logger.warn('configuration', { warning });

  if (configErrors.length > 0) {
    for (const error of configErrors) logger.error('configuration error', { error });
    logger.error('refusing to start with an invalid configuration', {
      hint: 'copy .env.example to .env and fill in the required values',
    });
    process.exit(1);
  }

  /* ---- 2. Database ----------------------------------------------------- */
  // Connect and migrate at boot so a schema problem is a startup failure
  // rather than something a customer discovers mid-conversation.
  await getDb();

  const knowledge = await knowledgeRepo.stats().catch(() => ({ documents: 0, chunks: 0, embedded: 0 }));
  if (knowledge.documents === 0) {
    logger.warn('knowledge base is empty', {
      hint: 'run `npm run kb:generate && npm run rag:ingest` so the assistant can answer policy questions',
    });
  }

  /* ---- 3. Listen ------------------------------------------------------- */
  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info('UrbanCart AI is listening', {
      url: `http://localhost:${env.port}`,
      chatUi: `http://localhost:${env.port}/`,
      nodeEnv: env.nodeEnv,
      database: env.db.driver,
      vectorStore: resolvedVectorStore(),
      embeddings: resolvedEmbeddingProvider(),
      llm: resolvedLlmProvider(),
      knowledgeBase: `${knowledge.documents} documents / ${knowledge.chunks} chunks`,
      liveIntegrations: Object.entries(integrationReadiness)
        .filter(([, ready]) => ready)
        .map(([name]) => name),
      dryRunIntegrations: Object.entries(integrationReadiness)
        .filter(([, ready]) => !ready)
        .map(([name]) => name),
    });
  });

  /* ---- 4. Graceful shutdown -------------------------------------------- */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    // Stop accepting connections, then drain, then close the database.
    server.close(async () => {
      await closeDatabase().catch((err) =>
        logger.error('error closing database', { error: (err as Error).message }),
      );
      logger.info('shutdown complete');
      process.exit(0);
    });

    // Don't hang forever on a stuck connection.
    setTimeout(() => {
      logger.warn('forcing shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { error: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception - exiting', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
