/**
 * Lead repository.
 */

import { getDb, type SqlClient } from '../index.ts';
import { env } from '../../config/env.ts';
import type { Lead, PurchaseIntent, Channel } from '../../models/types.ts';

interface LeadRow {
  id: string;
  reference: string;
  customer_id: string;
  product_id: string | null;
  product: string;
  budget: string | null;
  currency: string;
  location: string | null;
  purchase_intent: string;
  source: string;
  status: string;
  lead_score: number;
  is_high_value: boolean;
  conversation_id: string | null;
  notes: string | null;
  created_at: string | Date;
}

function map(row: LeadRow): Lead {
  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customer_id,
    productId: row.product_id,
    product: row.product,
    budget: row.budget === null ? null : Number(row.budget),
    currency: row.currency,
    location: row.location,
    purchaseIntent: row.purchase_intent as PurchaseIntent,
    source: row.source as Channel | 'manual',
    status: row.status as Lead['status'],
    leadScore: Number(row.lead_score),
    isHighValue: row.is_high_value,
    conversationId: row.conversation_id,
    notes: row.notes,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const COLUMNS = `id, reference, customer_id, product_id, product, budget, currency, location,
                 purchase_intent, source, status, lead_score, is_high_value,
                 conversation_id, notes, created_at`;

export interface CreateLeadInput {
  customerId: string;
  productId?: string | null;
  product: string;
  budget?: number | null;
  location?: string | null;
  purchaseIntent: PurchaseIntent;
  source: Channel | 'manual';
  leadScore: number;
  isHighValue: boolean;
  conversationId?: string | null;
  notes?: string | null;
}

export const leadRepo = {
  async findById(id: string, tx?: SqlClient): Promise<Lead | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<LeadRow>(`SELECT ${COLUMNS} FROM leads WHERE id = $1`, [id]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  async findByReference(reference: string, tx?: SqlClient): Promise<Lead | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<LeadRow>(`SELECT ${COLUMNS} FROM leads WHERE reference = $1`, [
      reference,
    ]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  /**
   * Duplicate detection: the same customer asking about the same product inside
   * DUPLICATE_LEAD_WINDOW_HOURS is one lead, not two. Without this a customer
   * who calls and then also messages on WhatsApp pages the sales team twice.
   */
  async findRecentDuplicate(
    customerId: string,
    product: string,
    tx?: SqlClient,
  ): Promise<Lead | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<LeadRow>(
      `SELECT ${COLUMNS} FROM leads
       WHERE customer_id = $1
         AND lower(product) = lower($2)
         AND status NOT IN ('lost','won')
         AND created_at > now() - ($3 || ' hours')::interval
       ORDER BY created_at DESC
       LIMIT 1`,
      [customerId, product, String(env.business.duplicateLeadWindowHours)],
    );
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  async create(input: CreateLeadInput, tx?: SqlClient): Promise<Lead> {
    const db = tx ?? (await getDb());
    const res = await db.query<LeadRow>(
      `INSERT INTO leads (reference, customer_id, product_id, product, budget, location,
                          purchase_intent, source, lead_score, is_high_value,
                          conversation_id, notes)
       VALUES (next_reference('lead'), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${COLUMNS}`,
      [
        input.customerId,
        input.productId ?? null,
        input.product,
        input.budget ?? null,
        input.location ?? null,
        input.purchaseIntent,
        input.source,
        input.leadScore,
        input.isHighValue,
        input.conversationId ?? null,
        input.notes ?? null,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('lead insert returned no row');
    return map(row);
  },

  async updateStatus(id: string, status: Lead['status'], tx?: SqlClient): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query('UPDATE leads SET status = $2 WHERE id = $1', [id, status]);
  },

  async listPipeline(limit = 50, tx?: SqlClient): Promise<Array<Lead & { customerName: string; customerPhone: string }>> {
    const db = tx ?? (await getDb());
    const res = await db.query<LeadRow & { customer_name: string; customer_phone: string }>(
      `SELECT l.id, l.reference, l.customer_id, l.product_id, l.product, l.budget,
              l.currency, l.location, l.purchase_intent, l.source, l.status,
              l.lead_score, l.is_high_value, l.conversation_id, l.notes, l.created_at,
              c.name AS customer_name, c.phone AS customer_phone
       FROM leads l JOIN customers c ON c.id = l.customer_id
       ORDER BY l.created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      ...map(r),
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
    }));
  },

  async countByStatus(tx?: SqlClient): Promise<Record<string, number>> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ status: string; count: string }>(
      'SELECT status, count(*)::text AS count FROM leads GROUP BY status',
    );
    const out: Record<string, number> = {};
    for (const r of res.rows) out[r.status] = Number(r.count);
    return out;
  },
};
