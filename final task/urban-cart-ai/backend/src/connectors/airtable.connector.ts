/**
 * Airtable connector - the operational, business-facing mirror.
 *
 * Why Airtable exists alongside PostgreSQL
 * ----------------------------------------
 * PostgreSQL is the system of record: constrained, relational, transactional,
 * and completely unusable by a salesperson who wants to filter today's leads
 * and tick one off. Airtable is the opposite: no schema guarantees worth
 * relying on, but grids, filters, grouping and mobile access that non-technical
 * staff can drive with no training and no SQL.
 *
 * So the flow is one-directional by design:
 *     PostgreSQL (truth)  ->  Airtable (working surface)
 * A lead is written to PostgreSQL first and only then mirrored here. If this
 * mirror fails, the business record still exists and the outbox retries it.
 * Airtable is never read back as authoritative.
 *
 * API shape: https://api.airtable.com/v0/{baseId}/{tableName}
 */

import { env, integrationReadiness } from '../config/env.ts';
import type { Lead, SupportTicket, Order } from '../models/types.ts';
import { dispatch, type OutboundResult } from './http.ts';

const API_BASE = 'https://api.airtable.com/v0';

/** Airtable table names are URL path segments and may contain spaces. */
function tableUrl(table: string): string {
  return `${API_BASE}/${env.airtable.baseId || 'appPLACEHOLDER'}/${encodeURIComponent(table)}`;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.airtable.apiKey}` };
}

/** Airtable rejects unknown fields unless typecast is on; it also rejects nulls. */
function clean(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

const INTENT_LABELS: Record<string, string> = {
  ready_to_buy: 'Ready to purchase',
  considering: 'Considering',
  browsing: 'Just asking',
};

export const airtableConnector = {
  get ready(): boolean {
    return integrationReadiness.airtable;
  },

  /** Field map for the Leads table - documented in airtable/base-schema.json. */
  leadFields(lead: Lead, customerName: string, customerPhone: string): Record<string, unknown> {
    return clean({
      'Lead ID': lead.reference,
      Name: customerName,
      Phone: customerPhone,
      Product: lead.product,
      Budget: lead.budget,
      Location: lead.location,
      'Purchase Intent': INTENT_LABELS[lead.purchaseIntent] ?? lead.purchaseIntent,
      'Lead Source': lead.source.replace(/_/g, ' '),
      Status: lead.status.charAt(0).toUpperCase() + lead.status.slice(1),
      'Lead Score': lead.leadScore,
      'High Value': lead.isHighValue,
      'Created At': lead.createdAt,
      Notes: lead.notes,
    });
  },

  supportFields(
    ticket: SupportTicket,
    customerName: string,
    orderNumber: string | null,
  ): Record<string, unknown> {
    return clean({
      'Ticket ID': ticket.reference,
      Customer: customerName,
      Issue: ticket.issueType.replace(/_/g, ' '),
      Description: ticket.description,
      Priority: ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1),
      Status: ticket.status.replace(/_/g, ' '),
      'Assigned Team': ticket.assignedTeam,
      'Order Number': orderNumber,
      'Created At': ticket.createdAt,
    });
  },

  orderFields(order: Order): Record<string, unknown> {
    const overdue =
      order.expectedDelivery && !order.deliveredAt
        ? new Date(order.expectedDelivery) < new Date()
        : false;
    return clean({
      'Order Number': order.orderNumber,
      Customer: order.customerName,
      Status: order.status.replace(/_/g, ' '),
      'Delivery Status': order.deliveredAt
        ? 'Delivered'
        : overdue
          ? 'Overdue'
          : 'In transit',
      Priority: order.status === 'delayed' || overdue ? 'High' : 'Normal',
      'Total Amount': order.totalAmount,
      City: order.deliveryCity,
      'Expected Delivery': order.expectedDelivery,
    });
  },

  /**
   * Create a record.
   *
   * `typecast: true` lets Airtable coerce a string into a select option and
   * create the option if it does not exist - without it, adding a new lead
   * status would 422 and lose the mirror.
   */
  async createRecord(
    table: string,
    fields: Record<string, unknown>,
    correlationId?: string,
  ): Promise<OutboundResult> {
    return dispatch(
      'airtable',
      {
        url: tableUrl(table),
        method: 'POST',
        headers: authHeaders(),
        body: { records: [{ fields }], typecast: true },
        operation: `create record in "${table}"`,
      },
      {
        ready: integrationReadiness.airtable,
        correlationId,
        extractRef: (data) => (data as { records?: Array<{ id: string }> })?.records?.[0]?.id,
      },
    );
  },

  async updateRecord(
    table: string,
    recordId: string,
    fields: Record<string, unknown>,
    correlationId?: string,
  ): Promise<OutboundResult> {
    return dispatch(
      'airtable',
      {
        url: tableUrl(table),
        method: 'PATCH',
        headers: authHeaders(),
        body: { records: [{ id: recordId, fields }], typecast: true },
        operation: `update record ${recordId} in "${table}"`,
      },
      { ready: integrationReadiness.airtable, correlationId },
    );
  },

  async createLead(
    lead: Lead,
    customerName: string,
    customerPhone: string,
    correlationId?: string,
  ): Promise<OutboundResult> {
    return this.createRecord(
      env.airtable.tables.leads,
      this.leadFields(lead, customerName, customerPhone),
      correlationId,
    );
  },

  async createSupportIssue(
    ticket: SupportTicket,
    customerName: string,
    orderNumber: string | null,
    correlationId?: string,
  ): Promise<OutboundResult> {
    return this.createRecord(
      env.airtable.tables.support,
      this.supportFields(ticket, customerName, orderNumber),
      correlationId,
    );
  },

  async upsertOrder(order: Order, correlationId?: string): Promise<OutboundResult> {
    return this.createRecord(env.airtable.tables.orders, this.orderFields(order), correlationId);
  },
};
