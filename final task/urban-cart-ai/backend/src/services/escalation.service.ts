/**
 * Complaint handling and human escalation (Workflow 5).
 *
 * Triggers, exactly as the client specified:
 *   * product arrived damaged
 *   * complicated refund request
 *   * customer is angry
 *   * required information is unavailable
 *   * the AI cannot confidently answer from the knowledge base
 *   * the customer explicitly asks for a person
 *
 * Every escalation creates a support ticket AND a task, in one transaction, so
 * a ticket can never exist without an owner. The customer always receives a
 * polite acknowledgement - never a technical error.
 */

import { getDb } from '../database/index.ts';
import { customerRepo } from '../database/repositories/customer.repo.ts';
import { orderRepo } from '../database/repositories/order.repo.ts';
import { supportRepo } from '../database/repositories/support.repo.ts';
import { opsRepo } from '../database/repositories/ops.repo.ts';
import { conversationRepo } from '../database/repositories/conversation.repo.ts';
import { airtableConnector } from '../connectors/airtable.connector.ts';
import { notificationService } from './notification.service.ts';
import { SAFE_RESPONSES } from '../config/constants.ts';
import type { IssueType, Priority, SupportTicket, Task, Team } from '../models/types.ts';
import { logger } from '../utils/logger.ts';
import { addDays } from '../utils/misc.ts';

export type EscalationTrigger =
  | 'damaged_product'
  | 'complex_refund'
  | 'angry_customer'
  | 'missing_information'
  | 'low_confidence'
  | 'customer_requested_human';

export interface EscalateInput {
  trigger: EscalationTrigger;
  /** The customer's own words. Stored on the ticket for the agent to read. */
  description: string;
  customerId?: string | null;
  conversationId?: string | null;
  orderNumber?: string | null;
  correlationId?: string;
}

export interface EscalationResult {
  ticket: SupportTicket;
  task: Task;
  /** The message to show/speak to the customer. Always safe. */
  customerMessage: string;
  notified: { slack: boolean; dryRun: boolean; airtable: boolean };
  priority: Priority;
}

/**
 * Trigger -> issue type, priority, owning team and SLA.
 *
 * Damaged goods and angry customers are urgent because both have a short
 * window in which the relationship can still be saved. Low confidence is
 * medium: nothing has gone wrong for the customer yet, the AI simply declined
 * to guess, and treating that as urgent would flood the support queue.
 */
const ESCALATION_POLICY: Record<
  EscalationTrigger,
  { issueType: IssueType; priority: Priority; team: Team; slaHours: number; title: string }
> = {
  damaged_product: {
    issueType: 'damaged_product',
    priority: 'urgent',
    team: 'support',
    slaHours: 1,
    title: 'Damaged product reported',
  },
  complex_refund: {
    issueType: 'refund_request',
    priority: 'high',
    team: 'support',
    slaHours: 4,
    title: 'Refund request needs review',
  },
  angry_customer: {
    issueType: 'angry_customer',
    priority: 'urgent',
    team: 'support',
    slaHours: 1,
    title: 'Upset customer needs a callback',
  },
  missing_information: {
    issueType: 'missing_information',
    priority: 'medium',
    team: 'support',
    slaHours: 24,
    title: 'Customer question needs information we do not hold',
  },
  low_confidence: {
    issueType: 'low_confidence',
    priority: 'medium',
    team: 'support',
    slaHours: 24,
    title: 'AI could not answer confidently',
  },
  customer_requested_human: {
    issueType: 'other',
    priority: 'high',
    team: 'support',
    slaHours: 4,
    title: 'Customer asked to speak to a person',
  },
};

/** Only these page the support channel. */
const SLACK_WORTHY: ReadonlySet<EscalationTrigger> = new Set<EscalationTrigger>([
  'damaged_product',
  'complex_refund',
  'angry_customer',
  'customer_requested_human',
]);

export const escalationService = {
  policyFor: (trigger: EscalationTrigger) => ESCALATION_POLICY[trigger],

  async escalate(input: EscalateInput): Promise<EscalationResult> {
    const started = Date.now();
    const log = logger.child({ correlationId: input.correlationId, workflow: 'escalation' });
    const policy = ESCALATION_POLICY[input.trigger];
    const db = await getDb();

    // Resolve the order first so the ticket can be linked to it.
    const order = input.orderNumber ? await orderRepo.findByNumber(input.orderNumber) : null;

    /* ---- Ticket + task, atomically -------------------------------------- */
    const { ticket, task } = await db.transaction(async (tx) => {
      const createdTicket = await supportRepo.createTicket(
        {
          customerId: input.customerId ?? null,
          conversationId: input.conversationId ?? null,
          orderId: order?.id ?? null,
          issueType: policy.issueType,
          priority: policy.priority,
          description: input.description.slice(0, 2000),
          assignedTeam: policy.team,
          escalationReason: input.trigger,
        },
        tx,
      );

      const createdTask = await supportRepo.createTask(
        {
          ticketId: createdTicket.id,
          title: `${policy.title}${order ? ` (${order.orderNumber})` : ''}`,
          description: input.description.slice(0, 1000),
          priority: policy.priority,
          assignedTeam: policy.team,
          dueAt: addDays(new Date(), policy.slaHours / 24),
        },
        tx,
      );

      if (input.conversationId) {
        await conversationRepo.markEscalated(input.conversationId, tx);
      }

      return { ticket: createdTicket, task: createdTask };
    });

    log.info('escalation created', {
      trigger: input.trigger,
      ticket: ticket.reference,
      task: task.reference,
      priority: policy.priority,
      orderNumber: order?.orderNumber ?? null,
    });

    /* ---- Customer context for the notification -------------------------- */
    const customer = input.customerId ? await customerRepo.findById(input.customerId) : null;
    const customerName = customer?.name ?? order?.customerName ?? 'Unknown customer';
    const customerPhone = customer?.phone ?? order?.customerPhone ?? '';

    /* ---- Mirror to Airtable --------------------------------------------- */
    const airtableEventId = await opsRepo.enqueue({
      destination: 'airtable',
      eventType: 'support_issue_created',
      entityType: 'support_ticket',
      entityId: ticket.id,
      payload: airtableConnector.supportFields(ticket, customerName, order?.orderNumber ?? null),
    });
    const airtableResult = await airtableConnector.createSupportIssue(
      ticket,
      customerName,
      order?.orderNumber ?? null,
      input.correlationId,
    );
    await opsRepo.markDelivered(
      airtableEventId,
      airtableResult.dryRun ? 'dry_run' : airtableResult.delivered ? 'delivered' : 'failed',
      airtableResult.externalRef ?? null,
      airtableResult.error ?? null,
    );

    /* ---- Notify support, selectively ------------------------------------ */
    let slackSent = false;
    let slackDryRun = false;

    if (SLACK_WORTHY.has(input.trigger)) {
      const outcome = await notificationService.notifySeriousComplaint(
        {
          ticketReference: ticket.reference,
          taskReference: task.reference,
          customerName,
          customerPhone,
          issueType: ticket.issueType,
          priority: ticket.priority,
          description: input.description,
          orderNumber: order?.orderNumber ?? null,
          assignedTeam: ticket.assignedTeam,
          escalationReason: input.trigger,
        },
        { correlationId: input.correlationId },
      );
      slackSent = outcome.sent;
      slackDryRun = outcome.dryRun;
    } else {
      // low_confidence / missing_information: queued for review, not paged.
      const reason = `trigger "${input.trigger}" is queued for review, not paged`;
      await notificationService.recordSuppressed('serious_complaint', reason, {
        ticket: ticket.reference,
      });
      log.info('escalation notification suppressed', { ticket: ticket.reference, reason });
    }

    await opsRepo.recordExecution({
      workflowName: 'escalation',
      status: 'success',
      correlationId: input.correlationId ?? null,
      inputSummary: { trigger: input.trigger, ticket: ticket.reference, priority: policy.priority },
      durationMs: Date.now() - started,
    });

    return {
      ticket,
      task,
      customerMessage: this.customerMessageFor(input.trigger, ticket.reference),
      notified: { slack: slackSent, dryRun: slackDryRun, airtable: airtableResult.delivered },
      priority: policy.priority,
    };
  },

  /**
   * What the customer hears. Never mentions confidence scores, ticket internals
   * or anything technical - only that a person is taking over.
   */
  customerMessageFor(trigger: EscalationTrigger, ticketReference: string): string {
    switch (trigger) {
      case 'damaged_product':
        return `I'm really sorry your order arrived damaged - that shouldn't happen. I've raised this as an urgent issue (reference ${ticketReference}) and a member of our support team will contact you shortly to arrange a replacement or refund. Please keep the item and its packaging, and photographs will help us process it faster.`;
      case 'complex_refund':
        return `I understand you'd like a refund. Because refunds need to be reviewed by a person, I've passed this to our support team (reference ${ticketReference}). They'll be in touch shortly to sort it out for you.`;
      case 'angry_customer':
        return `I'm sorry - this clearly hasn't been good enough, and I don't want to make it worse by giving you a partial answer. I've escalated this as a priority issue (reference ${ticketReference}) and a member of our team will contact you shortly.`;
      case 'customer_requested_human':
        return `Of course. I've passed this conversation to our support team (reference ${ticketReference}), and someone will get back to you shortly. Our agents are available from 9 AM to 9 PM, Monday to Saturday.`;
      case 'missing_information':
      case 'low_confidence':
      default:
        return `${SAFE_RESPONSES.NO_KNOWLEDGE} Your reference is ${ticketReference}.`;
    }
  },
};
