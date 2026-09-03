/**
 * Zapier connector.
 *
 * Why Zapier at all, when n8n already orchestrates everything
 * ----------------------------------------------------------
 * n8n owns the OPERATIONAL pipeline: it runs inside our infrastructure, it can
 * reach the private database, it handles the customer-facing latency path, and
 * every workflow is version-controlled JSON that we deploy.
 *
 * Zapier owns the COMMERCIAL long tail: the tools the sales and marketing teams
 * choose and change without engineering involvement - CRM, email sequencer,
 * calendar, WhatsApp Business templates, Google Sheets forecasts. Those tools
 * change quarterly and each has an OAuth integration that would otherwise be
 * ours to build and maintain.
 *
 * The boundary is therefore one webhook: the backend emits a single
 * `high_value_lead` event to a Zapier Catch Hook, and the sales team wires up
 * whatever downstream actions they need. Adding "also create a HubSpot deal" is
 * a change a non-engineer makes in Zapier in two minutes; it never becomes a
 * deployment. Nothing on the customer's critical path depends on Zapier, so its
 * latency and rate limits cannot affect a customer waiting for a reply.
 *
 * See zapier/README.md for the exact Zap configuration.
 */

import { env, integrationReadiness } from '../config/env.ts';
import type { Lead } from '../models/types.ts';
import { dispatch, type OutboundResult } from './http.ts';

/**
 * Flat payload. Zapier's field mapper works best with a flat, stably-named
 * object - nested structures force users to hand-write code steps.
 */
export interface ZapierLeadPayload {
  event: 'high_value_lead';
  lead_id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  product: string;
  budget_pkr: number | null;
  budget_formatted: string;
  location: string;
  purchase_intent: string;
  lead_source: string;
  lead_score: number;
  is_existing_customer: boolean;
  previous_orders: number;
  lifetime_value_pkr: number;
  created_at: string;
  crm_owner_hint: string;
  /** Shared secret so the Zap can reject anything that is not from us. */
  signature_token: string;
}

/** Route the lead to a sales owner by city - matches how the team is split. */
function ownerHint(location: string | null): string {
  const city = (location ?? '').toLowerCase();
  if (city.includes('lahore') || city.includes('faisalabad') || city.includes('multan')) {
    return 'sales-punjab';
  }
  if (city.includes('karachi') || city.includes('hyderabad')) return 'sales-sindh';
  if (city.includes('islamabad') || city.includes('rawalpindi') || city.includes('peshawar')) {
    return 'sales-north';
  }
  return 'sales-unassigned';
}

export const zapierConnector = {
  get ready(): boolean {
    return integrationReadiness.zapier;
  },

  buildPayload(
    lead: Lead,
    customer: { name: string; phone: string; email: string | null },
    history: { previousOrders: number; lifetimeValue: number },
  ): ZapierLeadPayload {
    return {
      event: 'high_value_lead',
      lead_id: lead.reference,
      customer_name: customer.name,
      customer_phone: customer.phone,
      customer_email: customer.email ?? '',
      product: lead.product,
      budget_pkr: lead.budget,
      budget_formatted: lead.budget === null ? 'Not stated' : `Rs. ${lead.budget.toLocaleString('en-US')}`,
      location: lead.location ?? '',
      purchase_intent: lead.purchaseIntent,
      lead_source: lead.source,
      lead_score: lead.leadScore,
      is_existing_customer: history.previousOrders > 0,
      previous_orders: history.previousOrders,
      lifetime_value_pkr: history.lifetimeValue,
      created_at: lead.createdAt,
      crm_owner_hint: ownerHint(lead.location),
      signature_token: env.zapier.sharedSecret,
    };
  },

  async sendHighValueLead(
    payload: ZapierLeadPayload,
    correlationId?: string,
  ): Promise<OutboundResult> {
    return dispatch(
      'zapier',
      {
        url: env.zapier.catchHookUrl || 'https://hooks.zapier.com/hooks/catch/PLACEHOLDER/',
        method: 'POST',
        body: payload,
        operation: 'catch-hook: high_value_lead',
      },
      {
        ready: integrationReadiness.zapier,
        correlationId,
        extractRef: (data) => (data as { id?: string })?.id,
      },
    );
  },
};
