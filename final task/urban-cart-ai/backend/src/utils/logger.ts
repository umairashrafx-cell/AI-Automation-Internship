/**
 * Structured JSON logger with automatic redaction.
 *
 * Requirement: "Logging without exposing sensitive information."
 * Every value is passed through a redactor that masks credentials outright and
 * partially masks personal data (phone/email) so logs stay debuggable without
 * becoming a customer-data leak.
 */

import { env } from '../config/env.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[env.logLevel];

/** Keys whose values are replaced entirely. */
const SECRET_KEYS = [
  'password', 'token', 'apikey', 'api_key', 'secret', 'authorization', 'auth',
  'servicerolekey', 'service_role_key', 'anonkey', 'signature', 'credential',
  'bearer', 'cookie', 'set-cookie', 'x-api-key', 'x-vapi-secret',
];

/** Keys that are personal data: masked but partially readable for support. */
const PII_KEYS = ['phone', 'email', 'delivery_address', 'deliveryaddress', 'address'];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, '');
  return SECRET_KEYS.some((s) => k.includes(s.replace(/[-_]/g, '')));
}

function isPiiKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, '');
  return PII_KEYS.some((s) => k === s.replace(/[-_]/g, ''));
}

/** `+923001234567` -> `+92300****567`; `a@b.com` -> `a***@b.com`. */
export function maskPii(value: string): string {
  if (value.includes('@')) {
    const [local = '', domain = ''] = value.split('@');
    const head = local.slice(0, 1);
    return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
  }
  if (value.length <= 6) return '*'.repeat(value.length);
  return `${value.slice(0, 5)}${'*'.repeat(Math.max(1, value.length - 8))}${value.slice(-3)}`;
}

/** Recursively redact a value for safe logging. */
export function redact(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (isSecretKey(key)) return '[REDACTED]';
    if (isPiiKey(key)) return maskPii(value);
    return value.length > 600 ? `${value.slice(0, 600)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return isSecretKey(key) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redact(v, key, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? '[REDACTED]' : redact(v, k, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface LogContext {
  /** Ties every log line, DB row and outbound call of one request together. */
  correlationId?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVELS[level] < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),

  /** Returns a logger that stamps every line with a fixed context. */
  child(base: LogContext) {
    return {
      debug: (msg: string, ctx?: LogContext) => emit('debug', msg, { ...base, ...ctx }),
      info: (msg: string, ctx?: LogContext) => emit('info', msg, { ...base, ...ctx }),
      warn: (msg: string, ctx?: LogContext) => emit('warn', msg, { ...base, ...ctx }),
      error: (msg: string, ctx?: LogContext) => emit('error', msg, { ...base, ...ctx }),
    };
  },
};

export type Logger = typeof logger;
