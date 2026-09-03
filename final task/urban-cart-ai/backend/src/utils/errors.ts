/**
 * Error taxonomy.
 *
 * Two-audience principle: every error carries an INTERNAL message (logged,
 * sent to Slack, stored in workflow_executions) and a SAFE customer-facing
 * message. The HTTP layer only ever serialises the safe one.
 */

import { SAFE_RESPONSES } from '../config/constants.ts';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CUSTOMER_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'INVALID_ORDER_NUMBER'
  | 'PRODUCT_NOT_FOUND'
  | 'VERIFICATION_REQUIRED'
  | 'DUPLICATE_LEAD'
  | 'KNOWLEDGE_UNAVAILABLE'
  | 'LOW_CONFIDENCE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'DATABASE_ERROR'
  | 'VECTOR_STORE_ERROR'
  | 'DOCUMENT_PROCESSING_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'INTERNAL_ERROR';

interface AppErrorOptions {
  /** HTTP status to return. */
  status?: number;
  /** Message safe to show a customer. Defaults by code. */
  safeMessage?: string;
  /** Structured detail for logs only. Never serialised to the client. */
  details?: Record<string, unknown>;
  /** Original error. */
  cause?: unknown;
  /** Whether a retry could plausibly succeed (drives connector back-off). */
  retryable?: boolean;
  /** Whether this failure should page a human in Slack. */
  notify?: boolean;
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  INVALID_ORDER_NUMBER: 400,
  PRODUCT_NOT_FOUND: 404,
  VERIFICATION_REQUIRED: 403,
  DUPLICATE_LEAD: 409,
  KNOWLEDGE_UNAVAILABLE: 200, // handled conversationally, not as an HTTP failure
  LOW_CONFIDENCE: 200,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  DATABASE_ERROR: 503,
  VECTOR_STORE_ERROR: 503,
  DOCUMENT_PROCESSING_ERROR: 500,
  CONFIGURATION_ERROR: 500,
  INTERNAL_ERROR: 500,
};

const DEFAULT_SAFE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: SAFE_RESPONSES.INVALID_INPUT,
  NOT_FOUND: SAFE_RESPONSES.GENERIC,
  CUSTOMER_NOT_FOUND: SAFE_RESPONSES.GENERIC,
  ORDER_NOT_FOUND: SAFE_RESPONSES.ORDER_NOT_FOUND,
  INVALID_ORDER_NUMBER: SAFE_RESPONSES.INVALID_ORDER_FORMAT,
  PRODUCT_NOT_FOUND: SAFE_RESPONSES.PRODUCT_NOT_FOUND,
  VERIFICATION_REQUIRED: SAFE_RESPONSES.ORDER_VERIFICATION_REQUIRED,
  DUPLICATE_LEAD: SAFE_RESPONSES.GENERIC,
  KNOWLEDGE_UNAVAILABLE: SAFE_RESPONSES.NO_KNOWLEDGE,
  LOW_CONFIDENCE: SAFE_RESPONSES.NO_KNOWLEDGE,
  UNAUTHORIZED: SAFE_RESPONSES.GENERIC,
  FORBIDDEN: SAFE_RESPONSES.GENERIC,
  RATE_LIMITED: SAFE_RESPONSES.RATE_LIMITED,
  UPSTREAM_TIMEOUT: SAFE_RESPONSES.GENERIC,
  UPSTREAM_ERROR: SAFE_RESPONSES.GENERIC,
  DATABASE_ERROR: SAFE_RESPONSES.GENERIC,
  VECTOR_STORE_ERROR: SAFE_RESPONSES.NO_KNOWLEDGE,
  DOCUMENT_PROCESSING_ERROR: SAFE_RESPONSES.GENERIC,
  CONFIGURATION_ERROR: SAFE_RESPONSES.GENERIC,
  INTERNAL_ERROR: SAFE_RESPONSES.GENERIC,
};

/** Codes that always warrant a Slack alert to the engineering channel. */
const ALWAYS_NOTIFY: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'DATABASE_ERROR',
  'VECTOR_STORE_ERROR',
  'DOCUMENT_PROCESSING_ERROR',
  'CONFIGURATION_ERROR',
  'INTERNAL_ERROR',
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to render to a customer on any channel. */
  readonly safeMessage: string;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly notify: boolean;

  constructor(code: ErrorCode, internalMessage: string, options: AppErrorOptions = {}) {
    super(internalMessage);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.safeMessage = options.safeMessage ?? DEFAULT_SAFE[code];
    this.details = options.details ?? {};
    this.retryable =
      options.retryable ??
      ['UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR', 'DATABASE_ERROR', 'VECTOR_STORE_ERROR'].includes(code);
    this.notify = options.notify ?? ALWAYS_NOTIFY.has(code);
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, AppError);
  }

  /** The only shape ever sent over HTTP. Contains no internal detail. */
  toClientJSON(correlationId?: string) {
    return {
      success: false as const,
      error: { code: this.code, message: this.safeMessage },
      ...(correlationId ? { correlationId } : {}),
    };
  }
}

/** Normalise anything thrown into an AppError. */
export function toAppError(err: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError(fallbackCode, err.message, { cause: err });
  }
  return new AppError(fallbackCode, typeof err === 'string' ? err : 'Unknown error', { cause: err });
}

/* Convenience constructors ------------------------------------------------- */

export const errors = {
  validation: (msg: string, details?: Record<string, unknown>) =>
    new AppError('VALIDATION_ERROR', msg, { details }),
  notFound: (what: string) => new AppError('NOT_FOUND', `${what} not found`),
  orderNotFound: (orderNumber: string) =>
    new AppError('ORDER_NOT_FOUND', `Order ${orderNumber} not found`, { details: { orderNumber } }),
  invalidOrderNumber: (raw: string) =>
    new AppError('INVALID_ORDER_NUMBER', `Malformed order number: ${raw}`, { details: { raw } }),
  productNotFound: (query: string) =>
    new AppError('PRODUCT_NOT_FOUND', `No product matched "${query}"`, { details: { query } }),
  verificationRequired: (orderNumber: string) =>
    new AppError('VERIFICATION_REQUIRED', `Ownership not verified for ${orderNumber}`, {
      details: { orderNumber },
    }),
  duplicateLead: (leadReference: string) =>
    new AppError('DUPLICATE_LEAD', `Duplicate of existing lead ${leadReference}`, {
      details: { leadReference },
    }),
  knowledgeUnavailable: (query: string, bestSimilarity: number) =>
    new AppError('KNOWLEDGE_UNAVAILABLE', `No grounded knowledge for "${query}"`, {
      details: { query, bestSimilarity },
    }),
  unauthorized: (why: string) => new AppError('UNAUTHORIZED', why),
  rateLimited: (key: string) => new AppError('RATE_LIMITED', `Rate limit exceeded for ${key}`),
  upstream: (service: string, msg: string, cause?: unknown) =>
    new AppError('UPSTREAM_ERROR', `${service}: ${msg}`, { details: { service }, cause }),
  upstreamTimeout: (service: string, ms: number) =>
    new AppError('UPSTREAM_TIMEOUT', `${service} timed out after ${ms}ms`, {
      details: { service, timeoutMs: ms },
    }),
  database: (msg: string, cause?: unknown) => new AppError('DATABASE_ERROR', msg, { cause }),
  documentProcessing: (file: string, msg: string, cause?: unknown) =>
    new AppError('DOCUMENT_PROCESSING_ERROR', `${file}: ${msg}`, { details: { file }, cause }),
  configuration: (msg: string) => new AppError('CONFIGURATION_ERROR', msg),
};
