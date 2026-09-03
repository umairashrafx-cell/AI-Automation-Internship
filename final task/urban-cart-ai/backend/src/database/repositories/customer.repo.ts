/**
 * Customer repository.
 *
 * Every statement is parameterised ($1, $2 …). No SQL is ever built by string
 * concatenation with user input.
 */

import { getDb, type SqlClient } from '../index.ts';
import type { Channel, Customer } from '../../models/types.ts';
import { toE164 } from '../../utils/phone.ts';

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  location: string | null;
  preferred_channel: string | null;
  notes: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(v: string | Date | null): string {
  if (v === null) return '';
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function map(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    location: row.location,
    preferredChannel: row.preferred_channel as Channel | null,
    notes: row.notes,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT = `SELECT id, name, phone, email, location, preferred_channel, notes,
                       created_at, updated_at
                FROM customers`;

export const customerRepo = {
  async findById(id: string, tx?: SqlClient): Promise<Customer | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<CustomerRow>(`${SELECT} WHERE id = $1`, [id]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  /** Primary lookup path: phone is the cross-channel natural key. */
  async findByPhone(phone: string, tx?: SqlClient): Promise<Customer | null> {
    const db = tx ?? (await getDb());
    let normalised: string;
    try {
      normalised = toE164(phone);
    } catch {
      return null; // an unparseable phone simply matches nobody
    }
    const res = await db.query<CustomerRow>(`${SELECT} WHERE phone = $1`, [normalised]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  async findByEmail(email: string, tx?: SqlClient): Promise<Customer | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<CustomerRow>(`${SELECT} WHERE email = $1`, [email.toLowerCase()]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  /**
   * Create the customer, or return the existing one and fill in any blanks.
   *
   * Implemented as a single INSERT … ON CONFLICT so two concurrent webhooks for
   * the same caller cannot create duplicate rows. COALESCE means an update
   * never erases known data with a null from a partial voice transcript.
   */
  async upsertByPhone(
    input: {
      name: string;
      phone: string;
      email?: string | null;
      location?: string | null;
      preferredChannel?: Channel | null;
      notes?: string | null;
    },
    tx?: SqlClient,
  ): Promise<{ customer: Customer; created: boolean }> {
    const db = tx ?? (await getDb());
    const phone = toE164(input.phone);

    const before = await db.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM customers WHERE phone = $1) AS exists',
      [phone],
    );
    const existed = before.rows[0]?.exists === true;

    const res = await db.query<CustomerRow>(
      `INSERT INTO customers (name, phone, email, location, preferred_channel, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (phone) DO UPDATE SET
         name              = COALESCE(NULLIF(EXCLUDED.name, ''), customers.name),
         email             = COALESCE(EXCLUDED.email, customers.email),
         location          = COALESCE(EXCLUDED.location, customers.location),
         preferred_channel = COALESCE(EXCLUDED.preferred_channel, customers.preferred_channel),
         notes             = COALESCE(EXCLUDED.notes, customers.notes)
       RETURNING id, name, phone, email, location, preferred_channel, notes,
                 created_at, updated_at`,
      [
        input.name.trim(),
        phone,
        input.email?.toLowerCase() ?? null,
        input.location ?? null,
        input.preferredChannel ?? null,
        input.notes ?? null,
      ],
    );

    const row = res.rows[0];
    if (!row) throw new Error('upsertByPhone returned no row');
    return { customer: map(row), created: !existed };
  },

  /**
   * Context a human agent or the AI needs when a known customer gets in touch:
   * "they should be able to see the customer's previous information instead of
   * starting from zero."
   */
  async getHistorySummary(
    customerId: string,
    tx?: SqlClient,
  ): Promise<{
    orderCount: number;
    lastOrderNumber: string | null;
    lastOrderStatus: string | null;
    openTicketCount: number;
    leadCount: number;
    lifetimeValue: number;
  }> {
    const db = tx ?? (await getDb());
    const res = await db.query<{
      order_count: string;
      last_order_number: string | null;
      last_order_status: string | null;
      open_ticket_count: string;
      lead_count: string;
      lifetime_value: string | null;
    }>(
      `SELECT
         (SELECT count(*)      FROM orders          WHERE customer_id = $1)                       AS order_count,
         (SELECT order_number  FROM orders          WHERE customer_id = $1
                                ORDER BY order_date DESC LIMIT 1)                                 AS last_order_number,
         (SELECT status        FROM orders          WHERE customer_id = $1
                                ORDER BY order_date DESC LIMIT 1)                                 AS last_order_status,
         (SELECT count(*)      FROM support_tickets WHERE customer_id = $1
                                AND status IN ('open','in_progress'))                             AS open_ticket_count,
         (SELECT count(*)      FROM leads           WHERE customer_id = $1)                       AS lead_count,
         (SELECT COALESCE(sum(total_amount), 0) FROM orders
                                WHERE customer_id = $1 AND status <> 'cancelled')                  AS lifetime_value`,
      [customerId],
    );
    const r = res.rows[0];
    return {
      orderCount: Number(r?.order_count ?? 0),
      lastOrderNumber: r?.last_order_number ?? null,
      lastOrderStatus: r?.last_order_status ?? null,
      openTicketCount: Number(r?.open_ticket_count ?? 0),
      leadCount: Number(r?.lead_count ?? 0),
      lifetimeValue: Number(r?.lifetime_value ?? 0),
    };
  },

  async list(limit = 50, tx?: SqlClient): Promise<Customer[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<CustomerRow>(`${SELECT} ORDER BY created_at DESC LIMIT $1`, [limit]);
    return res.rows.map(map);
  },
};
