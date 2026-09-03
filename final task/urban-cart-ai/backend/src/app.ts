/**
 * Express application assembly.
 * Separated from server.ts so the test suite can mount the app without
 * binding a port or installing signal handlers.
 */

import express, { type Express } from 'express';
import { join } from 'node:path';
import { PROJECT_ROOT } from './config/env.ts';
import { buildRouter } from './api/routes.ts';
import {
  cors,
  errorHandler,
  notFound,
  rateLimit,
  requestContext,
  securityHeaders,
} from './api/middleware/index.ts';

export function createApp(): Express {
  const app = express();

  // Behind a load balancer this makes req.ip the real client address.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(securityHeaders);
  app.use(cors);

  // Capture the raw body for HMAC verification. The signature is computed over
  // the exact bytes received, so it must be captured before JSON parsing.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use(rateLimit);
  app.use(buildRouter());

  // The demo chat UI. Static, no build step.
  app.use(express.static(join(PROJECT_ROOT, 'frontend'), { index: 'index.html' }));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
