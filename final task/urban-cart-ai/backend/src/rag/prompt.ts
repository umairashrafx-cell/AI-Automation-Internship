/**
 * The grounding prompt.
 *
 * This is the single most important file for the client's hardest requirement:
 * "we don't want the AI making up information". The rules below are stated as
 * prohibitions with a defined escape hatch, because a model that is told only
 * "don't guess" and given no alternative will still guess. Telling it exactly
 * what to output when it cannot answer (ESCALATE) makes refusal the easy path.
 */

import type { RetrievedChunk } from '../models/types.ts';
import { formatPkr } from '../utils/misc.ts';

export const GROUNDING_SYSTEM_PROMPT = `You are the customer assistant for UrbanCart, an online retailer in Pakistan selling electronics, accessories, home and lifestyle products.

## Your single source of truth

You answer ONLY from the KNOWLEDGE section supplied with each question, and from the BUSINESS DATA block when one is present. These are extracts from UrbanCart's own policy documents and live database.

## Absolute rules

1. NEVER state a price, delivery time, return window, warranty term, stock level or product specification that does not appear verbatim in the KNOWLEDGE or BUSINESS DATA you were given.
2. NEVER use general knowledge about other retailers, other countries, or how e-commerce "usually" works. If UrbanCart's documents do not say it, you do not know it.
3. If the supplied material does not fully answer the question, do NOT partially guess. Reply with exactly:
   ESCALATE: <one short sentence describing what information is missing>
   The system turns that into a polite handover to a human agent.
4. If the material is ambiguous or two documents conflict, prefer the document with the most recent effective date, and say which policy you used.
5. Never invent an order number, ticket number, tracking number, date or customer name.
6. Do not promise refunds, replacements, discounts, exceptions or delivery dates. You may only describe what the documented policy says.

## Style

- Warm, brief and direct. Two to four sentences for most answers.
- Pakistani Rupees are written as "Rs. 200,000".
- Cite the policy you used naturally, e.g. "according to our return policy". Do not print file names, chunk numbers or similarity scores.
- Do not open with "Based on the provided context". Just answer.
- If the customer sounds upset, acknowledge it in one short sentence before the facts.

## Output format

Reply with the customer-facing message only. No preamble, no markdown headings, no bullet lists unless the customer asked for a list.
If, and only if, you cannot answer from the supplied material, reply with the single line beginning "ESCALATE:".`;

/**
 * Voice needs a different shape: no lists, no long sentences, one question at
 * a time, and numbers spoken the way a person would say them.
 */
export const VOICE_SYSTEM_PROMPT = `${GROUNDING_SYSTEM_PROMPT}

## Voice-specific rules (this conversation is a phone call)

- Keep every reply under 40 words. Long replies are unusable on a call.
- Never use bullet points, numbered lists, markdown, emoji or symbols.
- Ask only ONE question per turn, then stop and wait.
- Say amounts as words a person would speak: "two hundred thousand rupees", not "Rs. 200,000".
- Read an order number back digit by digit when confirming it.
- Confirm any detail you collected (name, phone, budget) before moving on.`;

/** Render retrieved chunks into the KNOWLEDGE block. */
export function buildKnowledgeBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return 'KNOWLEDGE: (none available)';

  const parts = chunks.map((c, i) => {
    const section = (c.metadata['section'] as string | undefined) ?? null;
    const heading = [c.title ?? c.filename, section].filter(Boolean).join(' - ');
    const effective = c.effectiveFrom ? ` | effective ${c.effectiveFrom}` : '';
    return [
      `[${i + 1}] ${heading} (${c.documentType}, v${c.version}${effective})`,
      c.chunkText,
    ].join('\n');
  });

  return `KNOWLEDGE (UrbanCart's own documents - the ONLY source you may use):\n\n${parts.join('\n\n---\n\n')}`;
}

export interface BusinessFacts {
  product?: {
    name: string;
    sku: string;
    price: number;
    availability: string;
    stockQuantity: number;
    warrantyMonths: number | null;
    category: string;
    description: string | null;
  } | null;
  order?: {
    orderNumber: string;
    status: string;
    orderDate: string;
    expectedDelivery: string | null;
    deliveredAt: string | null;
    courier: string | null;
    trackingNumber: string | null;
    delayReason: string | null;
    items: Array<{ name: string; quantity: number }>;
    deliveryCity: string | null;
  } | null;
  customer?: { name: string; knownSince: string; previousOrders: number } | null;
}

const AVAILABILITY_WORDS: Record<string, string> = {
  in_stock: 'In stock and available to order',
  low_stock: 'In stock but only a few units left',
  out_of_stock: 'Out of stock',
  preorder: 'Available for pre-order only',
  discontinued: 'Discontinued - no longer sold',
};

/**
 * Live database facts, rendered as plain statements.
 *
 * Kept separate from KNOWLEDGE because these are authoritative and current,
 * whereas documents can be out of date. Price and stock ALWAYS come from here.
 */
export function buildBusinessDataBlock(facts: BusinessFacts): string {
  const lines: string[] = [];

  if (facts.product) {
    const p = facts.product;
    lines.push(
      'PRODUCT (live catalogue - authoritative for price and availability):',
      `- Name: ${p.name} (SKU ${p.sku}, ${p.category})`,
      `- Price: ${formatPkr(p.price)}`,
      `- Availability: ${AVAILABILITY_WORDS[p.availability] ?? p.availability}`,
      ...(p.availability === 'low_stock' ? [`- Units remaining: ${p.stockQuantity}`] : []),
      ...(p.warrantyMonths !== null ? [`- Warranty registered on this product: ${p.warrantyMonths} months`] : []),
      ...(p.description ? [`- Description: ${p.description}`] : []),
    );
  }

  if (facts.order) {
    const o = facts.order;
    lines.push(
      '',
      'ORDER (live database - authoritative):',
      `- Order number: ${o.orderNumber}`,
      `- Status: ${o.status.replace(/_/g, ' ')}`,
      `- Placed on: ${o.orderDate.slice(0, 10)}`,
      ...(o.items.length > 0
        ? [`- Items: ${o.items.map((i) => `${i.quantity} x ${i.name}`).join(', ')}`]
        : []),
      ...(o.deliveryCity ? [`- Delivering to: ${o.deliveryCity}`] : []),
      ...(o.expectedDelivery ? [`- Expected delivery: ${o.expectedDelivery}`] : []),
      ...(o.deliveredAt ? [`- Delivered on: ${o.deliveredAt.slice(0, 10)}`] : []),
      ...(o.courier ? [`- Courier: ${o.courier}`] : []),
      ...(o.trackingNumber ? [`- Tracking number: ${o.trackingNumber}`] : []),
      ...(o.delayReason ? [`- Reason for delay: ${o.delayReason}`] : []),
    );
  }

  if (facts.customer) {
    lines.push(
      '',
      'CUSTOMER:',
      `- Name: ${facts.customer.name}`,
      `- Existing customer since ${facts.customer.knownSince.slice(0, 10)} with ${facts.customer.previousOrders} previous order(s)`,
    );
  }

  return lines.length > 0 ? `BUSINESS DATA:\n${lines.join('\n')}` : '';
}

/** Assemble the full user-turn content sent to the model. */
export function buildUserPrompt(
  question: string,
  chunks: RetrievedChunk[],
  facts: BusinessFacts = {},
): string {
  const business = buildBusinessDataBlock(facts);
  return [
    buildKnowledgeBlock(chunks),
    ...(business ? ['', business] : []),
    '',
    `CUSTOMER QUESTION: ${question}`,
  ].join('\n');
}
