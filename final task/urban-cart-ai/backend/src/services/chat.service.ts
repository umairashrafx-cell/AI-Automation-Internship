/**
 * Chat orchestration (Workflow 1) - one customer turn, end to end.
 *
 *   validate -> classify intent -> identify customer -> gather facts
 *   -> retrieve knowledge when needed -> generate a grounded answer
 *   -> escalate instead of guessing -> persist the turn -> respond
 *
 * Shared by every channel. The voice service wraps this with speech-specific
 * formatting rather than reimplementing the logic, so a policy change applies
 * to chat and phone at the same time.
 *
 * Failure policy: any unexpected error is caught, logged, alerted to
 * engineering, and returned to the customer as a safe fallback. A customer
 * never sees a stack trace or a database message.
 */

import { conversationRepo } from '../database/repositories/conversation.repo.ts';
import { customerRepo } from '../database/repositories/customer.repo.ts';
import { opsRepo } from '../database/repositories/ops.repo.ts';
import { MAX_MESSAGE_LENGTH, SAFE_RESPONSES } from '../config/constants.ts';
import { generateGroundedAnswer } from '../rag/generator.ts';
import { retrieve } from '../rag/retriever.ts';
import type { BusinessFacts } from '../rag/prompt.ts';
import type {
  AgentAction,
  ChatTurnInput,
  ChatTurnResult,
  Conversation,
  Customer,
  Intent,
} from '../models/types.ts';
import { AppError, toAppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { newCorrelationId } from '../utils/misc.ts';
import { classify, type ClassifiedMessage } from './intent.service.ts';
import { escalationService, type EscalationTrigger } from './escalation.service.ts';
import { leadService } from './lead.service.ts';
import { notificationService } from './notification.service.ts';
import { orderService } from './order.service.ts';
import { productService } from './product.service.ts';

/** Map an intent + signals to an escalation trigger, or null to continue. */
function escalationTriggerFor(classified: ClassifiedMessage): EscalationTrigger | null {
  if (classified.signals.wantsHuman) return 'customer_requested_human';
  if (classified.signals.damagedProduct) return 'damaged_product';
  if (classified.signals.isAngry) return 'angry_customer';
  if (classified.signals.refundRequest && classified.intent === 'complaint') return 'complex_refund';
  return null;
}

export const chatService = {
  async handleTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const correlationId = input.correlationId ?? newCorrelationId();
    const started = Date.now();
    const log = logger.child({ correlationId, channel: input.channel, workflow: 'customer_chat' });
    const actions: AgentAction[] = [];

    let conversation: Conversation | null = null;

    try {
      /* ---- 1. Validate ------------------------------------------------- */
      const message = (input.message ?? '').trim();
      if (!message) {
        throw new AppError('VALIDATION_ERROR', 'empty message', {
          safeMessage: SAFE_RESPONSES.INVALID_INPUT,
        });
      }
      if (message.length > MAX_MESSAGE_LENGTH) {
        throw new AppError('VALIDATION_ERROR', `message exceeds ${MAX_MESSAGE_LENGTH} characters`, {
          safeMessage:
            "That message is a bit long for me to process. Could you shorten it, or would you like me to connect you with an agent?",
        });
      }

      /* ---- 2. Classify -------------------------------------------------- */
      const classified = classify(message);
      log.info('turn classified', {
        intent: classified.intent,
        intentConfidence: classified.intentConfidence,
        signals: classified.signals,
      });

      /* ---- 3. Identify the customer ------------------------------------- */
      const phone = input.phone ?? classified.entities.phone;
      let customer: Customer | null = phone ? await customerRepo.findByPhone(phone) : null;

      conversation = await conversationRepo.getOrCreate({
        channel: input.channel,
        sessionId: input.sessionId,
        customerId: customer?.id ?? null,
        metadata: { ...(input.metadata ?? {}), correlationId },
      });
      await conversationRepo.setIntent(conversation.id, classified.intent);
      await conversationRepo.addMessage(conversation.id, {
        role: 'customer',
        content: message,
        intent: classified.intent,
      });

      const history = await conversationRepo.getMessages(conversation.id, 10);

      /* ---- 4. Escalation signals short-circuit everything ---------------- */
      const trigger = escalationTriggerFor(classified);
      if (trigger) {
        const result = await this.escalateTurn({
          trigger,
          message,
          customerId: customer?.id ?? null,
          conversationId: conversation.id,
          orderNumber: classified.entities.orderNumber,
          correlationId,
        });
        actions.push(
          { type: 'ticket_created', detail: `${trigger} ticket raised`, reference: result.ticket.reference },
          { type: 'task_created', detail: `assigned to ${result.task.assignedTeam}`, reference: result.task.reference },
          { type: 'escalated', detail: `priority ${result.priority}` },
        );
        if (result.notified.slack || result.notified.dryRun) {
          actions.push({
            type: 'notification_sent',
            detail: result.notified.dryRun
              ? 'Slack alert recorded to outbox (no credentials)'
              : 'Slack alert delivered to #support',
          });
        }
        return this.finish(conversation.id, {
          reply: result.customerMessage,
          intent: 'complaint',
          conversationId: conversation.id,
          confidence: 1,
          escalated: true,
          sources: [],
          actions,
          correlationId,
          requiresHuman: true,
        }, started, log);
      }

      /* ---- 5. Gather authoritative facts --------------------------------- */
      const facts: BusinessFacts = {};

      // 5a. Order lookup
      if (classified.entities.orderNumber || classified.intent === 'order_status') {
        if (!classified.entities.orderNumber) {
          return this.finish(conversation.id, {
            reply:
              "I can check that for you. Could you give me your order number? It looks like UC-10452 and is on your confirmation message.",
            intent: 'order_status',
            conversationId: conversation.id,
            confidence: 1,
            escalated: false,
            sources: [],
            actions,
            correlationId,
            requiresHuman: false,
          }, started, log);
        }

        const lookup = await orderService.lookup(
          classified.entities.orderNumber,
          {
            phone: phone ?? null,
            name: input.name ?? classified.entities.name,
            customerId: customer?.id ?? null,
          },
          correlationId,
        );
        actions.push({
          type: 'order_lookup',
          detail: `${classified.entities.orderNumber}: ${lookup.outcome}`,
          reference: classified.entities.orderNumber,
        });

        if (lookup.outcome !== 'found') {
          return this.finish(conversation.id, {
            reply: lookup.message,
            intent: 'order_status',
            conversationId: conversation.id,
            confidence: lookup.outcome === 'verification_required' ? 1 : 0.5,
            escalated: false,
            sources: [],
            actions,
            correlationId,
            requiresHuman: false,
          }, started, log);
        }

        const order = lookup.order as NonNullable<typeof lookup.order>;
        facts.order = orderService.toFacts(order);
        if (!customer) customer = await customerRepo.findById(order.customerId);

        // A materially overdue order is an "important order issue".
        if (lookup.needsAttention) {
          await orderService.flagOrderIssue(
            order,
            lookup.daysOverdue !== null
              ? `Order is ${lookup.daysOverdue} day(s) past its expected delivery date and the customer has asked about it.`
              : `Order is marked ${order.status} and the customer has asked about it.`,
            lookup.daysOverdue,
            correlationId,
          );
          actions.push({ type: 'notification_sent', detail: 'order issue raised with operations' });
        }

        // Order status is fully answerable from the database - no RAG needed.
        return this.finish(conversation.id, {
          reply: lookup.message,
          intent: 'order_status',
          conversationId: conversation.id,
          confidence: 1,
          escalated: false,
          sources: [],
          actions,
          correlationId,
          requiresHuman: false,
        }, started, log);
      }

      // 5b. Product lookup
      let productAnswer: string | null = null;
      if (classified.entities.productQuery) {
        const lookup = await productService.lookup(classified.entities.productQuery);
        actions.push({
          type: 'product_lookup',
          detail: lookup.found
            ? `matched ${lookup.product?.sku} by ${lookup.matchType}`
            : `no match for "${classified.entities.productQuery}"`,
        });

        if (lookup.found && lookup.product) {
          facts.product = productService.toFacts(lookup.product);
          if (classified.intent === 'availability_inquiry') {
            productAnswer = productService.availabilitySentence(lookup.product);
          } else if (classified.intent === 'price_inquiry') {
            productAnswer = productService.priceSentence(lookup.product);
          }
        } else if (
          classified.intent === 'availability_inquiry' ||
          classified.intent === 'price_inquiry'
        ) {
          return this.finish(conversation.id, {
            reply: SAFE_RESPONSES.PRODUCT_NOT_FOUND,
            intent: classified.intent,
            conversationId: conversation.id,
            confidence: 0.4,
            escalated: false,
            sources: [],
            actions,
            correlationId,
            requiresHuman: false,
          }, started, log);
        }
      }

      // Availability and price are answered from the database verbatim. Routing
      // them through the model would add latency and a hallucination surface
      // for a sentence that is already exact.
      if (productAnswer) {
        return this.finish(conversation.id, {
          reply: productAnswer,
          intent: classified.intent,
          conversationId: conversation.id,
          confidence: 1,
          escalated: false,
          sources: [],
          actions,
          correlationId,
          requiresHuman: false,
        }, started, log);
      }

      // 5c. Customer context for a known caller
      if (customer) {
        const summary = await customerRepo.getHistorySummary(customer.id);
        facts.customer = {
          name: customer.name,
          knownSince: customer.createdAt,
          previousOrders: summary.orderCount,
        };
        if (conversation.customerId !== customer.id) {
          await conversationRepo.attachCustomer(conversation.id, customer.id);
        }
      }

      /* ---- 6. Lead capture ---------------------------------------------- */
      if (classified.intent === 'lead_capture') {
        const leadResult = await this.tryCaptureLead(classified, input, customer, conversation.id, correlationId);
        if (leadResult) {
          actions.push(...leadResult.actions);
          return this.finish(conversation.id, {
            reply: leadResult.reply,
            intent: 'lead_capture',
            conversationId: conversation.id,
            confidence: 1,
            escalated: false,
            sources: [],
            actions,
            correlationId,
            requiresHuman: false,
          }, started, log);
        }
        // Not enough detail yet - fall through and ask for what is missing.
        const missing = this.missingLeadFields(classified, input, customer);
        if (missing.length > 0) {
          return this.finish(conversation.id, {
            reply: this.askForLeadDetails(missing, classified.entities.productQuery),
            intent: 'lead_capture',
            conversationId: conversation.id,
            confidence: 1,
            escalated: false,
            sources: [],
            actions,
            correlationId,
            requiresHuman: false,
          }, started, log);
        }
      }

      /* ---- 7. Greeting --------------------------------------------------- */
      if (classified.intent === 'greeting') {
        const who = customer ? ` ${customer.name.split(' ')[0]}` : '';
        return this.finish(conversation.id, {
          reply: `Hello${who}! I'm UrbanCart's assistant. I can check product availability and prices, look up an order, or answer questions about delivery, returns and warranty. How can I help?`,
          intent: 'greeting',
          conversationId: conversation.id,
          confidence: 1,
          escalated: false,
          sources: [],
          actions,
          correlationId,
          requiresHuman: false,
        }, started, log);
      }

      /* ---- 8. RAG ------------------------------------------------------- */
      const retrieval = await retrieve(message, { intent: classified.intent, correlationId });
      actions.push({
        type: 'knowledge_search',
        detail: `${retrieval.status}: ${retrieval.chunks.length} chunk(s), confidence ${retrieval.confidence}`,
      });

      const answer = await generateGroundedAnswer({
        question: message,
        retrieval,
        facts,
        history,
        correlationId,
      });

      /* ---- 9. Refuse rather than guess ----------------------------------- */
      if (!answer.grounded) {
        const escalation = await this.escalateTurn({
          trigger: retrieval.status === 'empty' ? 'missing_information' : 'low_confidence',
          message,
          customerId: customer?.id ?? null,
          conversationId: conversation.id,
          orderNumber: null,
          correlationId,
        });
        actions.push(
          { type: 'ticket_created', detail: `unanswered question logged (${answer.refusalReason})`, reference: escalation.ticket.reference },
          { type: 'escalated', detail: 'AI declined to answer without evidence' },
        );
        return this.finish(conversation.id, {
          reply: escalation.customerMessage,
          intent: classified.intent,
          conversationId: conversation.id,
          confidence: answer.confidence,
          escalated: true,
          sources: answer.sources,
          actions,
          correlationId,
          requiresHuman: true,
        }, started, log);
      }

      return this.finish(conversation.id, {
        reply: answer.answer,
        intent: classified.intent,
        conversationId: conversation.id,
        confidence: answer.confidence,
        escalated: false,
        sources: answer.sources,
        actions,
        correlationId,
        requiresHuman: false,
      }, started, log);
    } catch (err) {
      return this.handleFailure(err, conversation?.id ?? null, correlationId, actions, started, log);
    }
  },

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  async escalateTurn(args: {
    trigger: EscalationTrigger;
    message: string;
    customerId: string | null;
    conversationId: string;
    orderNumber: string | null;
    correlationId: string;
  }) {
    return escalationService.escalate({
      trigger: args.trigger,
      description: args.message,
      customerId: args.customerId,
      conversationId: args.conversationId,
      orderNumber: args.orderNumber,
      correlationId: args.correlationId,
    });
  },

  /** Which of the six required lead fields we still lack. */
  missingLeadFields(
    classified: ClassifiedMessage,
    input: ChatTurnInput,
    customer: Customer | null,
  ): string[] {
    const missing: string[] = [];
    if (!(input.name ?? classified.entities.name ?? customer?.name)) missing.push('name');
    if (!(input.phone ?? classified.entities.phone ?? customer?.phone)) missing.push('phone');
    if (!classified.entities.productQuery) missing.push('product');
    return missing;
  },

  askForLeadDetails(missing: string[], product: string | null): string {
    // One question at a time, in the order a person would ask them.
    if (missing.includes('product')) {
      return 'I can help with that. Which product are you interested in?';
    }
    if (missing.includes('name')) {
      return `Great choice${product ? ` - the ${product} is popular` : ''}. Could I take your name so our sales team can follow up?`;
    }
    return 'Thanks. What is the best phone number for our sales team to reach you on?';
  },

  /** Attempt lead capture; returns null when required fields are missing. */
  async tryCaptureLead(
    classified: ClassifiedMessage,
    input: ChatTurnInput,
    customer: Customer | null,
    conversationId: string,
    correlationId: string,
  ): Promise<{ reply: string; actions: AgentAction[] } | null> {
    const name = input.name ?? classified.entities.name ?? customer?.name ?? null;
    const phone = input.phone ?? classified.entities.phone ?? customer?.phone ?? null;
    const product = classified.entities.productQuery;

    if (!name || !phone || !product) return null;

    const result = await leadService.capture({
      name,
      phone,
      product,
      budget: classified.entities.budget,
      location: classified.entities.location ?? customer?.location ?? null,
      purchaseIntent: classified.entities.purchaseIntent ?? 'considering',
      source: input.channel,
      conversationId,
      correlationId,
    });

    const actions: AgentAction[] = [];
    if (result.customerCreated) {
      actions.push({ type: 'customer_created', detail: `new customer record for ${name}` });
    }
    actions.push({
      type: 'lead_created',
      detail: result.duplicate
        ? `matched existing lead (score ${result.scoring.score})`
        : `score ${result.scoring.score}, ${result.scoring.isHighValue ? 'HIGH VALUE' : 'standard'}`,
      reference: result.lead.reference,
    });
    if (result.notifications.slack.sent || result.notifications.slack.dryRun) {
      actions.push({
        type: 'notification_sent',
        detail: result.notifications.slack.dryRun
          ? 'Slack sales alert recorded to outbox (no credentials)'
          : 'Slack sales alert delivered to #sales',
      });
    }
    if (!result.notifications.zapier.skipped) {
      actions.push({
        type: 'notification_sent',
        detail: result.notifications.zapier.dryRun
          ? 'Zapier high-value-lead event recorded to outbox (no credentials)'
          : 'Zapier high-value-lead event delivered',
      });
    }

    const firstName = name.split(' ')[0];
    const reply = result.duplicate
      ? `Thanks ${firstName} - I already have your enquiry about the ${product} on file (reference ${result.lead.reference}), and our sales team will be in touch shortly.`
      : result.scoring.isHighValue
        ? `Thank you ${firstName}. I've passed your interest in the ${product} to our sales team as a priority enquiry (reference ${result.lead.reference}). Someone will call you on the number you gave shortly.`
        : `Thanks ${firstName}. I've recorded your interest in the ${product} (reference ${result.lead.reference}) and our sales team will follow up with you.`;

    return { reply, actions };
  },

  /** Persist the assistant turn and return the result. */
  async finish(
    conversationId: string,
    result: ChatTurnResult,
    started: number,
    log: ReturnType<typeof logger.child>,
  ): Promise<ChatTurnResult> {
    await conversationRepo.addMessage(conversationId, {
      role: 'assistant',
      content: result.reply,
      intent: result.intent,
      confidence: result.confidence,
      sources: result.sources,
    });

    await opsRepo.recordExecution({
      workflowName: 'customer_chat',
      status: 'success',
      correlationId: result.correlationId,
      inputSummary: {
        intent: result.intent,
        escalated: result.escalated,
        confidence: result.confidence,
        sourceCount: result.sources.length,
      },
      durationMs: Date.now() - started,
    });

    log.info('turn complete', {
      intent: result.intent,
      escalated: result.escalated,
      confidence: result.confidence,
      durationMs: Date.now() - started,
    });

    return result;
  },

  /**
   * Central failure handling for a chat turn.
   * The customer gets a safe message; engineering gets the detail.
   */
  async handleFailure(
    err: unknown,
    conversationId: string | null,
    correlationId: string,
    actions: AgentAction[],
    started: number,
    log: ReturnType<typeof logger.child>,
  ): Promise<ChatTurnResult> {
    const appErr = toAppError(err);
    log.error('turn failed', { code: appErr.code, error: appErr.message });

    await opsRepo
      .recordExecution({
        workflowName: 'customer_chat',
        status: 'failed',
        correlationId,
        errorCode: appErr.code,
        errorMessage: appErr.message,
        durationMs: Date.now() - started,
      })
      .catch(() => undefined);

    if (appErr.notify) {
      await notificationService
        .notifyAutomationFailure({
          workflow: 'Customer Chat Request',
          errorCode: appErr.code,
          errorMessage: appErr.message,
          correlationId,
        })
        .catch(() => undefined);
    }

    if (conversationId) {
      await conversationRepo
        .addMessage(conversationId, { role: 'assistant', content: appErr.safeMessage })
        .catch(() => undefined);
    }

    return {
      reply: appErr.safeMessage,
      intent: 'unknown' as Intent,
      conversationId: conversationId ?? '',
      confidence: 0,
      escalated: false,
      sources: [],
      actions,
      correlationId,
      requiresHuman: appErr.code !== 'VALIDATION_ERROR',
    };
  },
};
