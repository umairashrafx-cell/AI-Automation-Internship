/**
 * Intent classification and entity extraction.
 *
 * Deliberately rule-based rather than an LLM call:
 *   * it runs in well under a millisecond, on the customer's latency path,
 *     before any model or database work begins;
 *   * it is deterministic, so the test suite can assert on it;
 *   * it costs nothing per message, and intent classification is by far the
 *     highest-volume operation in the system;
 *   * misclassification is recoverable - retrieval widens and the confidence
 *     gate still protects the answer.
 *
 * The escalation signals here are the ones the client named: damaged product,
 * complicated refund, angry customer, missing information.
 */

import type { Intent, PurchaseIntent } from '../models/types.ts';
import { ORDER_NUMBER_IN_TEXT } from '../config/constants.ts';
import { parseBudget } from '../utils/misc.ts';
import { extractPhone } from '../utils/phone.ts';
import { normaliseForMatch } from '../utils/text.ts';

export interface ClassifiedMessage {
  intent: Intent;
  /** 0-1 confidence in the intent label itself (not in the eventual answer). */
  intentConfidence: number;
  entities: {
    orderNumber: string | null;
    productQuery: string | null;
    phone: string | null;
    budget: number | null;
    location: string | null;
    name: string | null;
    purchaseIntent: PurchaseIntent | null;
  };
  signals: {
    isComplaint: boolean;
    isAngry: boolean;
    damagedProduct: boolean;
    refundRequest: boolean;
    wantsHuman: boolean;
  };
}

/* -------------------------------------------------------------------------- */
/* Lexicons                                                                   */
/* -------------------------------------------------------------------------- */

const PAKISTANI_CITIES = [
  'lahore', 'karachi', 'islamabad', 'rawalpindi', 'faisalabad', 'multan',
  'peshawar', 'quetta', 'sialkot', 'gujranwala', 'hyderabad', 'bahawalpur',
  'sargodha', 'abbottabad', 'mardan', 'sukkur', 'larkana', 'sahiwal',
];

const ANGRY_TERMS = [
  'angry', 'furious', 'ridiculous', 'unacceptable', 'worst', 'terrible',
  'pathetic', 'useless', 'fed up', 'sick of', 'disgusted', 'appalling',
  'never again', 'waste of money', 'scam', 'fraud', 'cheated', 'lying',
  'complaint', 'complain', 'sue', 'legal action', 'consumer court',
  'third time', 'still waiting', 'no response', 'nobody', 'horrible',
];

const DAMAGE_TERMS = [
  'damaged', 'damage', 'broken', 'break', 'cracked', 'crack', 'shattered',
  'scratched', 'dented', 'faulty', 'defective', 'not working', 'doesnt work',
  "doesn't work", 'stopped working', 'dead on arrival', 'torn', 'leaking',
];

const REFUND_TERMS = [
  'refund', 'money back', 'reimburse', 'chargeback', 'compensation',
  'return my money', 'want my money',
];

const HUMAN_TERMS = [
  'speak to a human', 'talk to a human', 'real person', 'human agent',
  'speak to someone', 'talk to someone', 'customer service', 'representative',
  'manager', 'supervisor', 'agent please', 'transfer me',
];

const ORDER_TERMS = [
  'my order', 'order status', 'where is my', 'hasnt arrived', "hasn't arrived",
  'not arrived', 'not received', 'tracking', 'track my', 'delivery status',
  'when will it arrive', 'when will i get',
];

const PRICE_TERMS = ['price', 'cost', 'how much', 'rate', 'kitna', 'kitne'];
const AVAILABILITY_TERMS = ['available', 'availability', 'in stock', 'stock', 'do you have', 'got any'];
const POLICY_TERMS = [
  'return policy', 'can i return', 'warranty', 'guarantee', 'deliver to',
  'delivery time', 'how long', 'shipping', 'exchange', 'cancel', 'payment',
  'installment', 'instalment', 'policy', 'refund process',
];
const BUY_TERMS = [
  'want to buy', 'like to buy', 'i want', 'interested in', 'looking for',
  'planning to buy', 'thinking of buying', 'purchase', 'order it', 'book it',
  'ready to buy', 'buy it now', 'how do i order',
];
const GREETING_TERMS = ['hello', 'hi', 'hey', 'salam', 'assalam', 'good morning', 'good evening', 'aoa'];

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

function countMatches(text: string, terms: string[]): number {
  return terms.reduce((n, t) => (text.includes(t) ? n + 1 : n), 0);
}

/* -------------------------------------------------------------------------- */
/* Entity extraction                                                          */
/* -------------------------------------------------------------------------- */

/** UC-10452, uc 10452, UC10452 -> "UC-10452" */
export function extractOrderNumber(text: string): string | null {
  const match = text.match(ORDER_NUMBER_IN_TEXT);
  return match?.[1] ? `UC-${match[1]}` : null;
}

/**
 * Extract a stated budget.
 *
 * Cannot just take the first number in the sentence: "I want to buy iPhone 15,
 * my budget is Rs. 200,000" would yield 15. The amount is therefore anchored to
 * either an explicit budget word or a currency marker, and a bare number is
 * never treated as a budget.
 */
export function extractBudget(text: string): number | null {
  const anchored = text.match(
    /\b(?:budget|afford|spend|spending|price range|under|below|around|about|up\s?to|upto|max(?:imum)?)\b[^\d]{0,24}((?:rs\.?|pkr)?\s?[\d][\d,.\s]*\s*(?:k\b|lakh|lac|lakhs|crore)?)/i,
  );
  if (anchored?.[1]) {
    const value = parseBudget(anchored[1]);
    if (value !== null && value > 0) return value;
  }

  // A currency marker is itself a strong enough anchor: "Rs. 200,000".
  const currency = text.match(/\b(?:rs\.?|pkr)\s?([\d][\d,.\s]*\s*(?:k\b|lakh|lac|crore)?)/i);
  if (currency?.[1]) {
    const value = parseBudget(currency[1]);
    if (value !== null && value > 0) return value;
  }

  // "2 lakh" / "200k" carry their own scale, so they are unambiguous.
  const scaled = text.match(/\b([\d.]+)\s*(k|lakh|lac|lakhs|crore)\b/i);
  if (scaled?.[0]) {
    const value = parseBudget(scaled[0]);
    if (value !== null && value > 0) return value;
  }

  return null;
}

export function extractLocation(text: string): string | null {
  const lower = normaliseForMatch(text);
  for (const city of PAKISTANI_CITIES) {
    if (new RegExp(`\\b${city}\\b`).test(lower)) {
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  }
  return null;
}

/**
 * Pull a product reference out of a sentence.
 *
 * Returns a candidate string for productRepo.search() to resolve, not a
 * decision. Anything unmatched simply produces no product, which is the safe
 * outcome - the assistant then asks rather than guessing.
 */
/**
 * Phrases that the greedy "buy|about|have ..." pattern can capture but which
 * are certainly not products. Letting these through would send nonsense to the
 * catalogue search and, worse, make an order or policy question look like a
 * product lookup.
 */
const NOT_A_PRODUCT = [
  'warranty', 'guarantee', 'return', 'refund', 'policy', 'delivery', 'shipping',
  'human', 'agent', 'someone', 'manager', 'representative', 'order', 'status',
  'money', 'complaint', 'problem', 'issue', 'question', 'help', 'support',
];

export function extractProductQuery(text: string): string | null {
  const cleaned = text.replace(/[?!.]/g, ' ');

  // "the iPhone 15", "a Samsung Galaxy S24", "wireless headphones"
  const patterns = [
    /(?:buy|want|interested in|looking for|order|purchase|about|have|price of|cost of)\s+(?:a|an|the|any)?\s*([a-z0-9][a-z0-9\s+-]{2,40}?)(?:\s+(?:available|in stock|please|now|today|for|under|below|and|with|,)|$)/i,
    /\b(iphone\s*\d{0,2}|samsung\s+galaxy(?:\s+s\d{1,2})?|galaxy\s+s\d{1,2}|macbook(?:\s+\w+)?|thinkbook(?:\s+\d+)?|airpods(?:\s+\w+)?)\b/i,
    /\b((?:wireless\s+|bluetooth\s+|noise\s+cancelling\s+)?(?:headphones?|earbuds?|earphones?|smart\s*watch|laptop|charger|backpack|coffee\s+maker|tablet|phone))\b/i,
    /\b(UC-[A-Z]{3,4}-\d{3})\b/i,
  ];

  // Try the specific product patterns before the greedy verb-object one, so
  // "buy the iPhone 15" resolves to "iPhone 15" and not "the iPhone 15 for".
  for (const pattern of [patterns[1], patterns[2], patterns[3], patterns[0]]) {
    if (!pattern) continue;
    const match = cleaned.match(pattern);
    const captured = match?.[1]?.trim();
    if (!captured || captured.length < 3) continue;

    const candidate = captured.replace(/\s+(please|now|today|thanks|thank you)$/i, '').trim();
    const lower = candidate.toLowerCase();

    // Reject captures that are policy/support language or contain an order
    // number - those are not catalogue lookups.
    if (NOT_A_PRODUCT.some((w) => lower.includes(w))) continue;
    if (ORDER_NUMBER_IN_TEXT.test(candidate)) continue;
    if (candidate.split(/\s+/).length > 5) continue;

    return candidate;
  }
  return null;
}

/** "My name is Ahmed", "This is Ahmed", "I am Ahmed Raza" */
export function extractName(text: string): string | null {
  const patterns = [
    /(?:my name is|i am|i'm|this is|name:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/,
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s+(?:here|speaking)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]?.trim();
    // Reject sentence starts that only look like names.
    if (name && !/^(I|The|My|This|That|It|Yes|No|Ok)\b/.test(name)) return name;
  }
  return null;
}

export function extractPurchaseIntent(text: string): PurchaseIntent | null {
  const lower = text.toLowerCase();
  if (
    /\b(ready to (buy|purchase|order)|want to buy( it)? now|i'?ll take it|place the order|order it now|buy it today|confirm the order)\b/.test(
      lower,
    )
  ) {
    return 'ready_to_buy';
  }
  if (/\b(comparing|considering|thinking about|maybe|deciding|which one|vs|versus|planning to buy)\b/.test(lower)) {
    return 'considering';
  }
  if (/\b(just (asking|checking|browsing|looking)|curious|window shopping)\b/.test(lower)) {
    return 'browsing';
  }
  if (containsAny(lower, BUY_TERMS)) return 'considering';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

export function classify(message: string): ClassifiedMessage {
  const raw = message.trim();
  const lower = raw.toLowerCase();

  const orderNumber = extractOrderNumber(raw);
  const budget = extractBudget(raw);

  const damagedProduct = containsAny(lower, DAMAGE_TERMS);
  const refundRequest = containsAny(lower, REFUND_TERMS);
  const angryScore = countMatches(lower, ANGRY_TERMS);
  // ALL CAPS shouting is a genuine anger signal on chat, but only for a message
  // long enough that it is not just an acronym or a product code.
  const shouting = raw.length > 15 && raw === raw.toUpperCase() && /[A-Z]{4,}/.test(raw);
  const isAngry = angryScore >= 1 || shouting;
  const wantsHuman = containsAny(lower, HUMAN_TERMS);
  const isComplaint = damagedProduct || refundRequest || isAngry;

  const entities: ClassifiedMessage['entities'] = {
    orderNumber,
    productQuery: extractProductQuery(raw),
    phone: extractPhone(raw),
    budget,
    location: extractLocation(raw),
    name: extractName(raw),
    purchaseIntent: extractPurchaseIntent(raw),
  };

  const signals: ClassifiedMessage['signals'] = {
    isComplaint,
    isAngry,
    damagedProduct,
    refundRequest,
    wantsHuman,
  };

  // Priority order matters: a complaint about an order is a complaint first.
  let intent: Intent;
  let intentConfidence: number;

  if (wantsHuman) {
    intent = 'handoff';
    intentConfidence = 0.95;
  } else if (damagedProduct || (isAngry && (orderNumber || refundRequest))) {
    intent = 'complaint';
    intentConfidence = 0.9;
  } else if (refundRequest && !containsAny(lower, ['refund policy', 'refund process', 'how long'])) {
    intent = 'complaint';
    intentConfidence = 0.75;
  } else if (orderNumber || containsAny(lower, ORDER_TERMS)) {
    intent = 'order_status';
    intentConfidence = orderNumber ? 0.95 : 0.7;
  } else if (containsAny(lower, BUY_TERMS) && (entities.budget !== null || entities.productQuery)) {
    intent = 'lead_capture';
    intentConfidence = 0.85;
  } else if (containsAny(lower, POLICY_TERMS)) {
    intent = 'policy_question';
    intentConfidence = 0.8;
  } else if (containsAny(lower, PRICE_TERMS)) {
    intent = 'price_inquiry';
    intentConfidence = 0.85;
  } else if (containsAny(lower, AVAILABILITY_TERMS)) {
    intent = 'availability_inquiry';
    intentConfidence = 0.85;
  } else if (isAngry) {
    intent = 'complaint';
    intentConfidence = 0.7;
  } else if (entities.productQuery) {
    intent = 'product_inquiry';
    intentConfidence = 0.6;
  } else if (containsAny(lower, GREETING_TERMS) && raw.length < 40) {
    intent = 'greeting';
    intentConfidence = 0.9;
  } else {
    intent = 'unknown';
    intentConfidence = 0.3;
  }

  return { intent, intentConfidence, entities, signals };
}
