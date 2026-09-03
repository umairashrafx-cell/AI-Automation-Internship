/**
 * Lead capture (Workflow 3).
 *
 *   validate -> find or create customer -> de-duplicate -> score
 *   -> write to PostgreSQL -> mirror to Airtable -> notify sales if warranted
 *   -> hand high-value leads to Zapier for the commercial stack
 *
 * The PostgreSQL write is the commit point. Everything after it is a
 * best-effort side effect recorded in the outbox: a lead is never lost because
 * Slack or Airtable was briefly unavailable.
 */

import { env } from '../config/env.ts';
import { getDb } from '../database/index.ts';
import { customerRepo } from '../database/repositories/customer.repo.ts';
import { leadRepo } from '../database/repositories/lead.repo.ts';
import { productRepo } from '../database/repositories/product.repo.ts';
import { opsRepo } from '../database/repositories/ops.repo.ts';
import { airtableConnector } from '../connectors/airtable.connector.ts';
import { zapierConnector } from '../connectors/zapier.connector.ts';
import { notificationService } from './notification.service.ts';
import type { Channel, Lead, PurchaseIntent } from '../models/types.ts';
import { AppError, errors } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { normalisePhone } from '../utils/phone.ts';

export interface CaptureLeadInput {
  name: string;
  phone: string;
  product: string;
  budget?: number | null;
  location?: string | null;
  purchaseIntent?: PurchaseIntent;
  source: Channel | 'manual';
  conversationId?: string | null;
  notes?: string | null;
  correlationId?: string;
}

export interface CaptureLeadResult {
  lead: Lead;
  customerId: string;
  customerCreated: boolean;
  duplicate: boolean;
  /** Present when duplicate=true: the existing lead we matched. */
  existingReference?: string;
  scoring: LeadScore;
  notifications: {
    slack: { sent: boolean; dryRun: boolean; suppressed: boolean; reason?: string };
    airtable: { sent: boolean; dryRun: boolean; recordId?: string };
    zapier: { sent: boolean; dryRun: boolean; skipped: boolean };
  };
}

export interface LeadScore {
  score: number;
  isHighValue: boolean;
  reasons: string[];
}

/**
 * Lead scoring.
 *
 * The client's own example - "New customer interested in iPhone 15, budget
 * Rs. 200,000, located in Lahore" - is the calibration target: it must come out
 * as high value. Budget dominates because it is the strongest purchase signal
 * the business has; intent and an existing relationship refine it.
 */
export function scoreLead(input: {
  budget: number | null;
  purchaseIntent: PurchaseIntent;
  location: string | null;
  productMatched: boolean;
  previousOrders: number;
  hasPhone: boolean;
}): LeadScore {
  let score = 0;
  const reasons: string[] = [];

  // Budget: up to 45 points.
  const threshold = env.business.highValueLeadBudgetPkr;
  if (input.budget !== null) {
    if (input.budget >= threshold * 2) {
      score += 45;
      reasons.push(`budget at or above ${threshold * 2} PKR (+45)`);
    } else if (input.budget >= threshold) {
      score += 38;
      reasons.push(`budget at or above the high-value threshold of ${threshold} PKR (+38)`);
    } else if (input.budget >= threshold / 3) {
      score += 22;
      reasons.push('mid-range budget (+22)');
    } else {
      score += 10;
      reasons.push('budget below the mid range (+10)');
    }
  } else {
    reasons.push('no budget stated (+0)');
  }

  // Purchase intent: up to 30 points.
  const intentPoints: Record<PurchaseIntent, number> = {
    ready_to_buy: 30,
    considering: 18,
    browsing: 5,
  };
  score += intentPoints[input.purchaseIntent];
  reasons.push(`intent "${input.purchaseIntent}" (+${intentPoints[input.purchaseIntent]})`);

  // A resolved catalogue product means we can actually sell this: 10 points.
  if (input.productMatched) {
    score += 10;
    reasons.push('product matched in catalogue (+10)');
  }

  // Known deliverable location: 5 points.
  if (input.location) {
    score += 5;
    reasons.push('location provided (+5)');
  }

  // Existing customer: proven willingness to pay, 10 points.
  if (input.previousOrders > 0) {
    score += 10;
    reasons.push(`existing customer with ${input.previousOrders} order(s) (+10)`);
  }

  // Reachability. Without a phone the sales team cannot act at all.
  if (!input.hasPhone) {
    score = Math.floor(score * 0.5);
    reasons.push('no reachable phone number (score halved)');
  }

  score = Math.max(0, Math.min(100, score));

  // A lead is high value on EITHER a large budget or a high composite score.
  // Budget alone qualifies because a stated Rs. 200,000 budget is worth a
  // salesperson's attention even if nothing else about the lead is known.
  const budgetQualifies = input.budget !== null && input.budget >= threshold;
  const scoreQualifies = score >= env.business.highValueLeadScore;
  const isHighValue = (budgetQualifies || scoreQualifies) && input.hasPhone;

  if (isHighValue) {
    reasons.push(
      budgetQualifies
        ? 'HIGH VALUE: budget meets the notification threshold'
        : 'HIGH VALUE: composite score meets the notification threshold',
    );
  }

  return { score, isHighValue, reasons };
}

export const leadService = {
  scoreLead,

  /**
   * Capture a lead end-to-end.
   * Throws AppError('VALIDATION_ERROR') on bad input; every downstream
   * integration failure is captured rather than thrown.
   */
  async capture(input: CaptureLeadInput): Promise<CaptureLeadResult> {
    const log = logger.child({ correlationId: input.correlationId, workflow: 'lead_creation' });
    const started = Date.now();

    /* ---- 1. Validate ---------------------------------------------------- */
    const name = input.name?.trim();
    if (!name || name.length < 2) {
      throw errors.validation('A customer name of at least 2 characters is required.', {
        field: 'name',
      });
    }
    const phone = normalisePhone(input.phone);
    if (!phone.ok || !phone.e164) {
      throw errors.validation(`A valid phone number is required (${phone.reason}).`, {
        field: 'phone',
      });
    }
    const product = input.product?.trim();
    if (!product) {
      throw errors.validation('The product the customer is interested in is required.', {
        field: 'product',
      });
    }
    if (input.budget !== null && input.budget !== undefined && input.budget < 0) {
      throw errors.validation('Budget cannot be negative.', { field: 'budget' });
    }

    const purchaseIntent: PurchaseIntent = input.purchaseIntent ?? 'browsing';
    const db = await getDb();

    /* ---- 2. Resolve the product against the catalogue -------------------- */
    const matches = await productRepo.search(product, 1);
    const matchedProduct = matches[0]?.product ?? null;

    /* ---- 3. Customer + duplicate check + insert, in one transaction ------ */
    const outcome = await db.transaction(async (tx) => {
      const { customer, created } = await customerRepo.upsertByPhone(
        {
          name,
          phone: phone.e164 as string,
          location: input.location ?? null,
          preferredChannel: input.source === 'manual' ? null : (input.source as Channel),
        },
        tx,
      );

      const history = await customerRepo.getHistorySummary(customer.id, tx);

      // De-duplicate before scoring: an identical recent lead must not page
      // sales a second time just because the customer switched channel.
      const duplicate = await leadRepo.findRecentDuplicate(customer.id, product, tx);
      if (duplicate) {
        return {
          lead: duplicate,
          customer,
          created,
          history,
          duplicate: true as const,
          scoring: {
            score: duplicate.leadScore,
            isHighValue: duplicate.isHighValue,
            reasons: ['duplicate of an existing open lead - not re-scored'],
          },
        };
      }

      const scoring = scoreLead({
        budget: input.budget ?? null,
        purchaseIntent,
        location: input.location ?? null,
        productMatched: matchedProduct !== null,
        previousOrders: history.orderCount,
        hasPhone: true,
      });

      const lead = await leadRepo.create(
        {
          customerId: customer.id,
          productId: matchedProduct?.id ?? null,
          product,
          budget: input.budget ?? null,
          location: input.location ?? null,
          purchaseIntent,
          source: input.source,
          leadScore: scoring.score,
          isHighValue: scoring.isHighValue,
          conversationId: input.conversationId ?? null,
          notes: input.notes ?? null,
        },
        tx,
      );

      return { lead, customer, created, history, duplicate: false as const, scoring };
    });

    const { lead, customer, created, history, scoring } = outcome;

    if (outcome.duplicate) {
      log.info('duplicate lead suppressed', {
        existing: lead.reference,
        product,
        windowHours: env.business.duplicateLeadWindowHours,
      });
      await notificationService.recordSuppressed(
        'high_value_lead',
        `duplicate of ${lead.reference} within ${env.business.duplicateLeadWindowHours}h`,
        { product, customerId: customer.id },
      );
      return {
        lead,
        customerId: customer.id,
        customerCreated: created,
        duplicate: true,
        existingReference: lead.reference,
        scoring,
        notifications: {
          slack: { sent: false, dryRun: false, suppressed: true, reason: 'duplicate lead' },
          airtable: { sent: false, dryRun: false },
          zapier: { sent: false, dryRun: false, skipped: true },
        },
      };
    }

    log.info('lead created', {
      reference: lead.reference,
      score: scoring.score,
      isHighValue: scoring.isHighValue,
      productMatched: matchedProduct !== null,
    });

    /* ---- 4. Mirror to Airtable (operational surface) --------------------- */
    const airtableEventId = await opsRepo.enqueue({
      destination: 'airtable',
      eventType: 'lead_created',
      entityType: 'lead',
      entityId: lead.id,
      payload: airtableConnector.leadFields(lead, customer.name, customer.phone),
    });
    const airtableResult = await airtableConnector.createLead(
      lead,
      customer.name,
      customer.phone,
      input.correlationId,
    );
    await opsRepo.markDelivered(
      airtableEventId,
      airtableResult.dryRun ? 'dry_run' : airtableResult.delivered ? 'delivered' : 'failed',
      airtableResult.externalRef ?? null,
      airtableResult.error ?? null,
    );

    /* ---- 5. Notify sales, but only when it is worth it ------------------- */
    let slack = { sent: false, dryRun: false, suppressed: true as boolean, reason: '' as string | undefined };
    if (scoring.isHighValue) {
      const outcomeSlack = await notificationService.notifyHighValueLead(
        {
          reference: lead.reference,
          customerName: customer.name,
          customerPhone: customer.phone,
          product: lead.product,
          budget: lead.budget,
          location: lead.location,
          purchaseIntent: lead.purchaseIntent,
          source: lead.source,
          leadScore: lead.leadScore,
          previousOrders: history.orderCount,
          lifetimeValue: history.lifetimeValue,
        },
        { correlationId: input.correlationId },
      );
      slack = {
        sent: outcomeSlack.sent,
        dryRun: outcomeSlack.dryRun,
        suppressed: false,
        reason: outcomeSlack.error,
      };
    } else {
      const reason = `lead score ${scoring.score} below ${env.business.highValueLeadScore} and budget below ${env.business.highValueLeadBudgetPkr}`;
      await notificationService.recordSuppressed('high_value_lead', reason, {
        reference: lead.reference,
      });
      log.info('lead notification suppressed (normal lead)', { reference: lead.reference, reason });
      slack = { sent: false, dryRun: false, suppressed: true, reason };
    }

    /* ---- 6. Hand high-value leads to the commercial stack via Zapier ----- */
    let zapier = { sent: false, dryRun: false, skipped: true };
    if (scoring.isHighValue) {
      const payload = zapierConnector.buildPayload(lead, customer, {
        previousOrders: history.orderCount,
        lifetimeValue: history.lifetimeValue,
      });
      const zapEventId = await opsRepo.enqueue({
        destination: 'zapier',
        eventType: 'high_value_lead',
        entityType: 'lead',
        entityId: lead.id,
        payload: payload as unknown as Record<string, unknown>,
      });
      const zapResult = await zapierConnector.sendHighValueLead(payload, input.correlationId);
      await opsRepo.markDelivered(
        zapEventId,
        zapResult.dryRun ? 'dry_run' : zapResult.delivered ? 'delivered' : 'failed',
        zapResult.externalRef ?? null,
        zapResult.error ?? null,
      );
      zapier = { sent: zapResult.delivered, dryRun: zapResult.dryRun, skipped: false };
    }

    await opsRepo.recordExecution({
      workflowName: 'lead_creation',
      status: 'success',
      correlationId: input.correlationId ?? null,
      inputSummary: {
        reference: lead.reference,
        source: lead.source,
        score: scoring.score,
        highValue: scoring.isHighValue,
      },
      durationMs: Date.now() - started,
    });

    return {
      lead,
      customerId: customer.id,
      customerCreated: created,
      duplicate: false,
      scoring,
      notifications: {
        slack,
        airtable: {
          sent: airtableResult.delivered,
          dryRun: airtableResult.dryRun,
          ...(airtableResult.externalRef ? { recordId: airtableResult.externalRef } : {}),
        },
        zapier,
      },
    };
  },

  /** Record a failed lead attempt and alert engineering. */
  async recordFailure(error: unknown, correlationId?: string): Promise<void> {
    const appErr = error instanceof AppError ? error : errors.validation(String(error));
    await opsRepo.recordExecution({
      workflowName: 'lead_creation',
      status: 'failed',
      correlationId: correlationId ?? null,
      errorCode: appErr.code,
      errorMessage: appErr.message,
    });
    if (appErr.notify) {
      await notificationService.notifyAutomationFailure({
        workflow: 'Lead Creation',
        errorCode: appErr.code,
        errorMessage: appErr.message,
        ...(correlationId ? { correlationId } : {}),
      });
    }
  },
};
