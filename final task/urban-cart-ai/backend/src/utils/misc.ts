/**
 * Small shared helpers: ids, money formatting, retry/backoff, timeouts.
 */

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

/** Correlation id stamped on a request and carried through every hop. */
export function newCorrelationId(): string {
  return `uc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function newId(): string {
  return randomUUID();
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/** `200000` -> `Rs. 200,000`. Pakistani retail convention. */
export function formatPkr(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return 'N/A';
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (Number.isNaN(n)) return 'N/A';
  const whole = Math.round(n);
  return `Rs. ${whole.toLocaleString('en-US')}`;
}

/**
 * Parse a spoken/typed budget into a number.
 * Handles "200000", "Rs. 200,000", "2 lakh", "200k", "2.5 lac".
 */
export function parseBudget(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;

  const text = raw.toLowerCase().replace(/rs\.?|pkr|rupees?/g, '').trim();
  if (!text) return null;

  const lakh = text.match(/([\d.]+)\s*(lakh|lac|lakhs)/);
  if (lakh?.[1]) {
    const n = Number(lakh[1]);
    return Number.isFinite(n) ? Math.round(n * 100_000) : null;
  }
  const crore = text.match(/([\d.]+)\s*crore/);
  if (crore?.[1]) {
    const n = Number(crore[1]);
    return Number.isFinite(n) ? Math.round(n * 10_000_000) : null;
  }
  const k = text.match(/([\d.]+)\s*k\b/);
  if (k?.[1]) {
    const n = Number(k[1]);
    return Number.isFinite(n) ? Math.round(n * 1_000) : null;
  }

  const digits = text.replace(/[,\s]/g, '').match(/\d+(\.\d+)?/);
  if (!digits?.[0]) return null;
  const n = Number(digits[0]);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/* -------------------------------------------------------------------------- */
/* Async control                                                              */
/* -------------------------------------------------------------------------- */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reject if a promise has not settled within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying immediately. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Exponential backoff with full jitter. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 4_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      if (options.shouldRetry && !options.shouldRetry(err, attempt)) break;
      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * ceiling);
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------------- */
/* Signatures                                                                 */
/* -------------------------------------------------------------------------- */

/** HMAC-SHA256 hex signature of a raw request body. */
export function signPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Constant-time comparison that never throws on length mismatch. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not reveal the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** Round to `places` decimals, avoiding float noise in similarity scores. */
export function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Business-day-aware "days from now" used for delivery estimates. */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** ISO date (YYYY-MM-DD) for a Date. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Difference in whole days between two dates (b - a). */
export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}
