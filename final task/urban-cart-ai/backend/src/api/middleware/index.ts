/**
 * Express middleware: request context, authentication, validation, rate
 * limiting and the central error handler.
 */

import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { env } from '../../config/env.ts';
import { AppError, errors, toAppError } from '../../utils/errors.ts';
import { logger } from '../../utils/logger.ts';
import { newCorrelationId, safeCompare, signPayload } from '../../utils/misc.ts';
import { opsRepo } from '../../database/repositories/ops.repo.ts';
import { notificationService } from '../../services/notification.service.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      rawBody?: string;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Request context                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Stamp every request with a correlation id, echo it back, and log the
 * outcome. The same id flows into workflow_executions, the outbox and every
 * log line, so one customer complaint can be traced across all of them.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  req.correlationId = incoming && /^[\w-]{6,64}$/.test(incoming) ? incoming : newCorrelationId();
  res.setHeader('X-Correlation-Id', req.correlationId);

  const started = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - started;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http request', {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
    });
  });

  next();
}

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  const allowed = env.security.corsAllowedOrigins;

  if (origin && (allowed.includes(origin) || allowed.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key,X-Correlation-Id,X-Signature,X-Vapi-Secret');
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/** Conservative security headers for the served chat UI. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Protects the internal tool endpoints that n8n and Vapi call.
 *
 * In development with no key configured the guard logs a warning and allows the
 * request, so the demo runs out of the box; in production a missing key is a
 * boot-time fatal error (see validateEnvironment), so this can never silently
 * expose data in production.
 */
export function requireApiKey(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.security.internalApiKey;

  if (!expected) {
    if (env.isProduction) {
      next(errors.configuration('INTERNAL_API_KEY is not configured'));
      return;
    }
    logger.warn('internal endpoint called without INTERNAL_API_KEY configured', {
      correlationId: req.correlationId,
      path: req.path,
    });
    next();
    return;
  }

  const provided = req.header('x-api-key') ?? '';
  if (!provided || !safeCompare(provided, expected)) {
    logger.warn('rejected: bad or missing API key', {
      correlationId: req.correlationId,
      path: req.path,
    });
    next(errors.unauthorized('invalid or missing X-API-Key'));
    return;
  }
  next();
}

/**
 * Verify an HMAC-SHA256 signature over the raw request body.
 * Used for n8n and Zapier webhooks, where a shared secret is signed rather
 * than transmitted.
 */
export function verifySignature(req: Request, _res: Response, next: NextFunction): void {
  const secret = env.security.webhookSigningSecret;
  if (!secret) {
    if (env.isProduction) {
      next(errors.configuration('WEBHOOK_SIGNING_SECRET is not configured'));
      return;
    }
    logger.warn('webhook signature check skipped (no secret configured)', {
      correlationId: req.correlationId,
    });
    next();
    return;
  }

  const provided = req.header('x-signature') ?? '';
  const expected = signPayload(req.rawBody ?? '', secret);
  if (!safeCompare(provided.replace(/^sha256=/, ''), expected)) {
    next(errors.unauthorized('invalid webhook signature'));
    return;
  }
  next();
}

/**
 * Vapi sends a static shared secret in X-Vapi-Secret on every server webhook.
 * Compared in constant time.
 */
export function verifyVapiSecret(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.vapi.webhookSecret;
  if (!expected) {
    if (env.isProduction) {
      next(errors.configuration('VAPI_WEBHOOK_SECRET is not configured'));
      return;
    }
    logger.warn('vapi webhook secret check skipped (not configured)', {
      correlationId: req.correlationId,
    });
    next();
    return;
  }
  const provided = req.header('x-vapi-secret') ?? '';
  if (!safeCompare(provided, expected)) {
    next(errors.unauthorized('invalid X-Vapi-Secret'));
    return;
  }
  next();
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

/**
 * Fixed-window limiter, per client, in-process.
 *
 * Adequate for a single node and for stopping a runaway script. A multi-node
 * deployment must move this to Redis - noted in the production recommendations
 * rather than pretended away.
 */
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const limit = env.security.rateLimitPerMinute;
  if (limit <= 0) {
    next();
    return;
  }

  // Hash the identifier so raw IPs never appear in memory dumps or logs.
  const identity = req.header('x-api-key') ?? req.ip ?? 'unknown';
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 60_000 };
    buckets.set(key, bucket);
  }
  bucket.count++;

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));

  if (bucket.count > limit) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    next(errors.rateLimited(key));
    return;
  }
  next();
}

/** Periodically drop expired buckets so the map cannot grow without bound. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000);
sweeper.unref();

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface Validator<T> {
  parse: (input: unknown) => T;
}

/** Validate req.body with a zod schema, replacing it with the parsed value. */
export function validateBody<T>(schema: Validator<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      const issues = (err as { issues?: Array<{ path: unknown[]; message: string }> }).issues;
      next(
        new AppError('VALIDATION_ERROR', `request body failed validation: ${(err as Error).message}`, {
          details: {
            issues: issues?.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        }),
      );
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Error handling                                                             */
/* -------------------------------------------------------------------------- */

export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError('NOT_FOUND', `no route for ${req.method} ${req.path}`));
}

/**
 * The only place an error becomes an HTTP response.
 *
 * Guarantees, in order:
 *   1. the client receives the SAFE message and never internal detail;
 *   2. the failure is recorded in workflow_executions;
 *   3. failures worth a human's attention alert engineering in Slack.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appErr = toAppError(err);

  logger.error('request failed', {
    correlationId: req.correlationId,
    path: req.path,
    code: appErr.code,
    status: appErr.status,
    error: appErr.message,
    details: appErr.details,
  });

  void opsRepo
    .recordExecution({
      workflowName: `http:${req.method} ${req.path}`,
      status: 'failed',
      correlationId: req.correlationId,
      errorCode: appErr.code,
      errorMessage: appErr.message,
    })
    .catch(() => undefined);

  if (appErr.notify) {
    void notificationService
      .notifyAutomationFailure({
        workflow: `API ${req.method} ${req.path}`,
        errorCode: appErr.code,
        errorMessage: appErr.message,
        correlationId: req.correlationId,
      })
      .catch(() => undefined);
  }

  if (res.headersSent) return;
  res.status(appErr.status).json(appErr.toClientJSON(req.correlationId));
}
