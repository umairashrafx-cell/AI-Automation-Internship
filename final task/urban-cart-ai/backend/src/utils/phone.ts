/**
 * Pakistani phone-number normalisation.
 *
 * Phone is the natural key that joins a WhatsApp thread, a Vapi caller id and a
 * website chat form to one customer row, so normalisation has to be strict and
 * total: "0300 123 4567", "+92 300 1234567" and "923001234567" must all
 * collapse to exactly "+923001234567".
 */

const PK_COUNTRY_CODE = '92';

/** Digits only, keeping a leading + if present. */
function clean(raw: string): string {
  return raw.trim().replace(/[^\d+]/g, '');
}

export interface PhoneNormalisation {
  ok: boolean;
  /** E.164, e.g. +923001234567. Only set when ok. */
  e164?: string;
  reason?: string;
}

/**
 * Normalise a Pakistani (or already-international) number to E.164.
 * Accepts: 03001234567, 3001234567, 923001234567, +923001234567, 0092300...
 */
export function normalisePhone(raw: string | null | undefined): PhoneNormalisation {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'empty' };

  let s = clean(raw);
  if (!s) return { ok: false, reason: 'empty' };

  // 00 international prefix -> +
  if (s.startsWith('00')) s = `+${s.slice(2)}`;

  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (!/^[1-9]\d{7,14}$/.test(digits)) {
      return { ok: false, reason: 'not a valid international number' };
    }
    return { ok: true, e164: `+${digits}` };
  }

  const digits = s.replace(/\D/g, '');

  // 92XXXXXXXXXX (12 digits) -> already country-coded
  if (digits.startsWith(PK_COUNTRY_CODE) && digits.length === 12) {
    return { ok: true, e164: `+${digits}` };
  }
  // 0XXXXXXXXXX (11 digits, national format)
  if (digits.startsWith('0') && digits.length === 11) {
    return { ok: true, e164: `+${PK_COUNTRY_CODE}${digits.slice(1)}` };
  }
  // XXXXXXXXXX (10 digits, no trunk prefix)
  if (digits.length === 10 && !digits.startsWith('0')) {
    return { ok: true, e164: `+${PK_COUNTRY_CODE}${digits}` };
  }

  return { ok: false, reason: `unrecognised phone format (${digits.length} digits)` };
}

/** Throwing variant for code paths that have already validated input. */
export function toE164(raw: string): string {
  const r = normalisePhone(raw);
  if (!r.ok || !r.e164) throw new Error(`Invalid phone number: ${r.reason}`);
  return r.e164;
}

/** Human-friendly rendering for Slack messages: +92 300 1234567. */
export function formatPhoneForDisplay(e164: string): string {
  if (!e164.startsWith(`+${PK_COUNTRY_CODE}`) || e164.length !== 13) return e164;
  return `+${PK_COUNTRY_CODE} ${e164.slice(3, 6)} ${e164.slice(6)}`;
}

/** Extract the first phone-looking token from free text (voice transcripts). */
export function extractPhone(text: string): string | null {
  const match = text.match(/(\+?\d[\d\s-]{8,16}\d)/);
  if (!match?.[1]) return null;
  const r = normalisePhone(match[1]);
  return r.ok && r.e164 ? r.e164 : null;
}
