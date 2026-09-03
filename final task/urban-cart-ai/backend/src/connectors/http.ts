/**
 * Outbound HTTP for every third-party integration.
 *
 * Two modes, chosen per integration by whether its credentials are present:
 *
 *   LIVE     - the request is sent, with a timeout, bounded retries on
 *              transient failures, and the outcome recorded.
 *   DRY-RUN  - the request is BUILT exactly as it would be sent (URL, method,
 *              headers, body) and appended to data/outbox/<service>.jsonl,
 *              then reported as `dry_run`.
 *
 * DRY-RUN never fabricates a success response. Callers receive
 * `{ delivered: false, dryRun: true }` and must treat it as "not delivered".
 * This is what makes the demo honest: you can read the outbox file and see the
 * precise Slack Block Kit payload or Airtable record that production would POST,
 * with no pretence that a message was actually sent.
 *
 * Secrets are redacted before anything is written to the outbox or the log.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config/env.ts';
import { logger, redact } from '../utils/logger.ts';
import { AppError, errors } from '../utils/errors.ts';
import { retry, withTimeout } from '../utils/misc.ts';
import type { IntegrationDestination } from '../database/repositories/ops.repo.ts';

const OUTBOX_DIR = join(PROJECT_ROOT, 'data', 'outbox');
const DEFAULT_TIMEOUT_MS = 12_000;

export interface OutboundRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Human label used in logs and in the outbox record. */
  operation: string;
}

export interface OutboundResult<T = unknown> {
  delivered: boolean;
  dryRun: boolean;
  status?: number;
  data?: T;
  /** Provider-side identifier (Slack ts, Airtable record id, Notion page id). */
  externalRef?: string;
  error?: string;
  durationMs: number;
}

/** Append one record to data/outbox/<service>.jsonl. */
async function writeToOutbox(
  service: IntegrationDestination,
  request: OutboundRequest,
  reason: string,
): Promise<void> {
  await mkdir(OUTBOX_DIR, { recursive: true });
  const record = {
    ts: new Date().toISOString(),
    service,
    operation: request.operation,
    reason,
    request: {
      method: request.method ?? 'POST',
      url: request.url,
      // Redaction matters here: the outbox is a plain file a developer will
      // open and may paste into a ticket.
      headers: redact(request.headers ?? {}),
      body: redact(request.body),
    },
  };
  await appendFile(join(OUTBOX_DIR, `${service}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
}

/** Status codes worth retrying. 4xx (except 429) are permanent. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Send an outbound request, or record it when the integration is not configured.
 *
 * @param ready `false` routes to DRY-RUN. Comes from `integrationReadiness`.
 */
export async function dispatch<T = unknown>(
  service: IntegrationDestination,
  request: OutboundRequest,
  options: { ready: boolean; correlationId?: string; extractRef?: (data: T) => string | undefined } = {
    ready: false,
  },
): Promise<OutboundResult<T>> {
  const started = Date.now();
  const log = logger.child({ correlationId: options.correlationId, service, operation: request.operation });

  if (!options.ready) {
    const reason = `${service} has no credentials configured`;
    await writeToOutbox(service, request, reason).catch((err) =>
      log.error('failed to write to outbox', { error: (err as Error).message }),
    );
    log.info('integration dry-run (payload recorded, NOT sent)', {
      outbox: `data/outbox/${service}.jsonl`,
    });
    return { delivered: false, dryRun: true, durationMs: Date.now() - started };
  }

  const method = request.method ?? 'POST';
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const result = await retry(
      async () => {
        const response = await withTimeout(
          fetch(request.url, {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(request.headers ?? {}),
            },
            body: request.body === undefined || method === 'GET' ? undefined : JSON.stringify(request.body),
          }),
          timeoutMs,
          () => errors.upstreamTimeout(service, timeoutMs),
        );

        const text = await response.text();
        let data: unknown;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }

        if (!response.ok) {
          throw new AppError(
            isRetryableStatus(response.status) ? 'UPSTREAM_ERROR' : 'UPSTREAM_ERROR',
            `${service} ${request.operation} failed: HTTP ${response.status} ${String(text).slice(0, 300)}`,
            { retryable: isRetryableStatus(response.status), details: { status: response.status } },
          );
        }

        return { status: response.status, data: data as T };
      },
      {
        attempts: 3,
        baseDelayMs: 400,
        shouldRetry: (err) => (err instanceof AppError ? err.retryable : true),
        onRetry: (err, attempt, delay) =>
          log.warn('integration retry', {
            attempt,
            delayMs: delay,
            error: (err as Error).message,
          }),
      },
    );

    const externalRef = options.extractRef?.(result.data);
    log.info('integration delivered', { status: result.status, externalRef });

    return {
      delivered: true,
      dryRun: false,
      status: result.status,
      data: result.data,
      externalRef,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const message = (err as Error).message;
    log.error('integration failed', { error: message });
    return {
      delivered: false,
      dryRun: false,
      error: message,
      durationMs: Date.now() - started,
    };
  }
}

/** Path of a service's outbox file, for tests and the admin endpoint. */
export function outboxPath(service: IntegrationDestination): string {
  return join(OUTBOX_DIR, `${service}.jsonl`);
}
