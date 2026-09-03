/**
 * Internal notification policy.
 *
 * The client was explicit: "We don't want Slack to become noisy. Only important
 * things should generate notifications... Normal customer questions don't need
 * to notify the entire team."
 *
 * This module is the ONLY way a Slack message can be sent. It accepts exactly
 * four event types and refuses everything else, so the noise rule is enforced
 * by the type system and by a runtime guard rather than by developer discipline.
 *
 * Delivery is via the transactional outbox: the event row is written first, the
 * send is attempted, and the row records the outcome. A Slack outage therefore
 * degrades to "delivered late", never to "silently lost".
 */

import { EVENT_CHANNEL, NOTIFIABLE_EVENTS, type NotifiableEvent } from '../config/constants.ts';
import { opsRepo } from '../database/repositories/ops.repo.ts';
import type { SqlClient } from '../database/index.ts';
import { logger } from '../utils/logger.ts';
import {
  slackConnector,
  type AutomationFailureNotification,
  type ComplaintNotification,
  type HighValueLeadNotification,
  type OrderIssueNotification,
} from '../connectors/slack.connector.ts';

export interface NotificationOutcome {
  sent: boolean;
  dryRun: boolean;
  eventId: string;
  channel: string;
  error?: string;
}

/** Runtime guard mirroring the compile-time union. */
export function isNotifiableEvent(event: string): event is NotifiableEvent {
  return (NOTIFIABLE_EVENTS as readonly string[]).includes(event);
}

interface SendArgs {
  event: NotifiableEvent;
  blocks: ReturnType<typeof slackConnector.buildHighValueLead>;
  fallbackText: string;
  entityType: string;
  entityId?: string | null;
  payloadSummary: Record<string, unknown>;
  correlationId?: string;
  /** Transaction to enqueue the outbox row in, so it commits with the entity. */
  tx?: SqlClient;
}

async function send(args: SendArgs): Promise<NotificationOutcome> {
  const channelKey = EVENT_CHANNEL[args.event];

  // 1. Record the intent to notify, inside the caller's transaction when given.
  const eventId = await opsRepo.enqueue(
    {
      destination: 'slack',
      eventType: args.event,
      entityType: args.entityType,
      entityId: args.entityId ?? null,
      payload: { channel: channelKey, ...args.payloadSummary },
    },
    args.tx,
  );

  // 2. Attempt delivery outside the transaction's critical path.
  const result = await slackConnector.send(
    channelKey,
    args.blocks,
    args.fallbackText,
    args.correlationId,
  );

  const status = result.dryRun ? 'dry_run' : result.delivered ? 'delivered' : 'failed';
  await opsRepo
    .markDelivered(eventId, status, result.externalRef ?? null, result.error ?? null)
    .catch((err) => logger.error('failed to record notification outcome', { error: (err as Error).message }));

  return {
    sent: result.delivered,
    dryRun: result.dryRun,
    eventId,
    channel: channelKey,
    ...(result.error ? { error: result.error } : {}),
  };
}

export const notificationService = {
  /**
   * A lead worth interrupting the sales team for.
   * The decision of WHETHER a lead is high value is made in lead.service.ts;
   * by the time it reaches here that judgement is already made.
   */
  async notifyHighValueLead(
    lead: HighValueLeadNotification,
    options: { correlationId?: string; tx?: SqlClient } = {},
  ): Promise<NotificationOutcome> {
    return send({
      event: 'high_value_lead',
      blocks: slackConnector.buildHighValueLead(lead),
      fallbackText: `High value lead ${lead.reference}: ${lead.customerName} - ${lead.product}`,
      entityType: 'lead',
      entityId: null,
      payloadSummary: {
        reference: lead.reference,
        product: lead.product,
        budget: lead.budget,
        score: lead.leadScore,
      },
      ...options,
    });
  },

  async notifySeriousComplaint(
    complaint: ComplaintNotification,
    options: { correlationId?: string; tx?: SqlClient } = {},
  ): Promise<NotificationOutcome> {
    return send({
      event: 'serious_complaint',
      blocks: slackConnector.buildComplaint(complaint),
      fallbackText: `High priority support issue ${complaint.ticketReference}: ${complaint.issueType}`,
      entityType: 'support_ticket',
      entityId: null,
      payloadSummary: {
        ticket: complaint.ticketReference,
        issueType: complaint.issueType,
        priority: complaint.priority,
      },
      ...options,
    });
  },

  async notifyAutomationFailure(
    failure: AutomationFailureNotification,
    options: { correlationId?: string; tx?: SqlClient } = {},
  ): Promise<NotificationOutcome> {
    return send({
      event: 'automation_failure',
      blocks: slackConnector.buildAutomationFailure(failure),
      fallbackText: `Automation failed: ${failure.workflow} (${failure.errorCode})`,
      entityType: 'workflow_execution',
      entityId: null,
      payloadSummary: {
        workflow: failure.workflow,
        errorCode: failure.errorCode,
        correlationId: failure.correlationId,
      },
      ...options,
    });
  },

  async notifyOrderIssue(
    issue: OrderIssueNotification,
    options: { correlationId?: string; tx?: SqlClient } = {},
  ): Promise<NotificationOutcome> {
    return send({
      event: 'order_issue',
      blocks: slackConnector.buildOrderIssue(issue),
      fallbackText: `Order issue on ${issue.orderNumber}: ${issue.issue}`,
      entityType: 'order',
      entityId: null,
      payloadSummary: { orderNumber: issue.orderNumber, status: issue.status },
      ...options,
    });
  },

  /**
   * Explicitly record that an event was considered and deliberately NOT sent.
   *
   * Called on the ordinary-question path. It costs one cheap insert and gives
   * the team an auditable answer to "why didn't we hear about this?" - the row
   * says `skipped` with the reason, which is far better than silence.
   */
  async recordSuppressed(
    eventType: string,
    reason: string,
    payload: Record<string, unknown>,
    tx?: SqlClient,
  ): Promise<void> {
    const id = await opsRepo.enqueue(
      {
        destination: 'slack',
        eventType,
        entityType: 'suppressed',
        payload: { reason, ...payload },
      },
      tx,
    );
    await opsRepo.markDelivered(id, 'skipped', null, reason, tx);
  },
};
