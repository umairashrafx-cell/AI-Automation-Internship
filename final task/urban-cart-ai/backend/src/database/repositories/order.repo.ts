/**
 * Order repository.
 *
 * Security note: order lookups are the one place where the AI can leak personal
 * data (address, phone, purchase history) to whoever types a guessable order
 * number. `findForCustomerFacingLookup` therefore returns a verification
 * requirement unless the caller has already proven identity, and the mapped
 * result deliberately omits the full delivery address unless verified.
 */

import { getDb, type SqlClient } from '../index.ts';
import type { Order, OrderItem, OrderStatus } from '../../models/types.ts';
import { ORDER_NUMBER_PATTERN } from '../../config/constants.ts';
import { toE164 } from '../../utils/phone.ts';

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  total_amount: string;
  currency: string;
  order_date: string | Date;
  expected_delivery: string | Date | null;
  delivered_at: string | Date | null;
  delivery_address: string;
  delivery_city: string | null;
  courier: string | null;
  tracking_number: string | null;
  delay_reason: string | null;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  items: OrderItem[] | null;
}

function toIso(v: string | Date | null): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function map(row: OrderRow): Order {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    status: row.status as OrderStatus,
    paymentStatus: row.payment_status,
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    orderDate: toIso(row.order_date) ?? '',
    deliveryAddress: row.delivery_address,
    deliveryCity: row.delivery_city,
    expectedDelivery: row.expected_delivery
      ? (toIso(row.expected_delivery) ?? '').slice(0, 10)
      : null,
    deliveredAt: toIso(row.delivered_at),
    courier: row.courier,
    trackingNumber: row.tracking_number,
    delayReason: row.delay_reason,
    items: (row.items ?? []).map((i) => ({
      sku: i.sku,
      name: i.name,
      quantity: Number(i.quantity),
      price: Number(i.price),
    })),
  };
}

/** v_order_summary already joins customer + aggregates items as JSON. */
const SELECT = `SELECT id, order_number, status, payment_status, total_amount, currency,
                       order_date, expected_delivery, delivered_at, delivery_address,
                       delivery_city, courier, tracking_number, delay_reason,
                       customer_id, customer_name, customer_phone, items
                FROM v_order_summary`;

export type OrderLookupResult =
  | { outcome: 'found'; order: Order; verified: boolean }
  | { outcome: 'invalid_format'; raw: string }
  | { outcome: 'not_found'; orderNumber: string }
  | { outcome: 'verification_required'; orderNumber: string };

export const orderRepo = {
  async findByNumber(orderNumber: string, tx?: SqlClient): Promise<Order | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<OrderRow>(`${SELECT} WHERE order_number = $1`, [
      orderNumber.toUpperCase(),
    ]);
    return res.rows[0] ? map(res.rows[0]) : null;
  },

  async findByCustomer(customerId: string, limit = 10, tx?: SqlClient): Promise<Order[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<OrderRow>(
      `${SELECT} WHERE customer_id = $1 ORDER BY order_date DESC LIMIT $2`,
      [customerId, limit],
    );
    return res.rows.map(map);
  },

  /**
   * The lookup used by chat and voice.
   *
   * Verification rule: the caller must supply either the phone number on the
   * order (voice callers get this free from caller id) or the customer's name.
   * Without it we return `verification_required` and reveal nothing - not even
   * whether the order exists, so the endpoint cannot be used to enumerate
   * order numbers.
   */
  async findForCustomerFacingLookup(
    rawOrderNumber: string,
    identity: { phone?: string | null; name?: string | null; customerId?: string | null },
    tx?: SqlClient,
  ): Promise<OrderLookupResult> {
    const orderNumber = rawOrderNumber.trim().toUpperCase().replace(/\s+/g, '');

    if (!ORDER_NUMBER_PATTERN.test(orderNumber)) {
      return { outcome: 'invalid_format', raw: rawOrderNumber };
    }

    const order = await this.findByNumber(orderNumber, tx);
    if (!order) return { outcome: 'not_found', orderNumber };

    let verified = false;
    if (identity.customerId && identity.customerId === order.customerId) {
      verified = true;
    } else if (identity.phone) {
      try {
        verified = toE164(identity.phone) === order.customerPhone;
      } catch {
        verified = false;
      }
    }
    if (!verified && identity.name) {
      // Name match is a weaker second factor, accepted only as a full
      // case-insensitive match of the name on the order.
      verified = identity.name.trim().toLowerCase() === order.customerName.trim().toLowerCase();
    }

    if (!verified) return { outcome: 'verification_required', orderNumber };
    return { outcome: 'found', order, verified };
  },

  /**
   * Strip fields a customer should not have read back to them in full.
   * Used when composing the AI's spoken/written answer.
   */
  redactForCustomer(order: Order): Omit<Order, 'deliveryAddress'> & { deliveryAddress: string } {
    // Keep only the city and the last line, never the full street address.
    const parts = order.deliveryAddress.split(',').map((p) => p.trim());
    const shortened = parts.length > 1 ? parts.slice(-2).join(', ') : (parts[0] ?? '');
    return { ...order, deliveryAddress: shortened };
  },

  async countByStatus(tx?: SqlClient): Promise<Record<string, number>> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ status: string; count: string }>(
      'SELECT status, count(*)::text AS count FROM orders GROUP BY status ORDER BY status',
    );
    const out: Record<string, number> = {};
    for (const r of res.rows) out[r.status] = Number(r.count);
    return out;
  },

  async listAll(limit = 50, tx?: SqlClient): Promise<Order[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<OrderRow>(`${SELECT} ORDER BY order_date DESC LIMIT $1`, [limit]);
    return res.rows.map(map);
  },
};
