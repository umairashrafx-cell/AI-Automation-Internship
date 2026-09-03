/**
 * Voice orchestration (Workflow 2) - the Vapi server webhook.
 *
 * Vapi runs the speech stack (telephony, transcription, the LLM turn loop and
 * text-to-speech). This service is the TOOL BACKEND it calls: when the voice
 * assistant needs a fact or needs to write a record, Vapi issues a tool call
 * over HTTPS and we answer it.
 *
 * Two rules shape everything here:
 *   1. The assistant is never given free rein over business facts. Every
 *      number it can say comes from a tool result, which comes from the
 *      database or from retrieved documents.
 *   2. Replies must be speakable: short, no markdown, no lists, and figures
 *      rendered as words a person would say.
 */

import { customerRepo } from '../database/repositories/customer.repo.ts';
import { opsRepo } from '../database/repositories/ops.repo.ts';
import { conversationRepo } from '../database/repositories/conversation.repo.ts';
import { retrieve } from '../rag/retriever.ts';
import { generateGroundedAnswer } from '../rag/generator.ts';
import { escalationService, type EscalationTrigger } from './escalation.service.ts';
import { leadService } from './lead.service.ts';
import { orderService } from './order.service.ts';
import { productService } from './product.service.ts';
import { classify } from './intent.service.ts';
import { SAFE_RESPONSES } from '../config/constants.ts';
import type { PurchaseIntent } from '../models/types.ts';
import { toAppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { newCorrelationId, parseBudget } from '../utils/misc.ts';
import { normalisePhone } from '../utils/phone.ts';

/* -------------------------------------------------------------------------- */
/* Speech formatting                                                          */
/* -------------------------------------------------------------------------- */

const UNITS = ['zero','one','two','three','four','five','six','seven','eight','nine'];

/** "UC-10452" -> "U C, one zero four five two" so the caller hears each digit. */
export function speakOrderNumber(orderNumber: string): string {
  const digits = orderNumber.replace(/^UC-?/i, '');
  const spoken = digits.split('').map((d) => UNITS[Number(d)] ?? d).join(' ');
  return `U C, ${spoken}`;
}

/**
 * Speak a PKR amount the way a Pakistani shopkeeper would, and EXACTLY.
 *
 *   249999 -> "2 lakh 49 thousand 999 rupees"
 *   200000 -> "2 lakh rupees"
 *    24999 -> "24 thousand 999 rupees"
 *
 * Exactness matters more than brevity here: rounding Rs. 249,999 to "2.5 lakh"
 * would have the assistant state a price the business does not charge, which is
 * precisely the failure the whole system is built to prevent.
 */
export function speakAmount(amount: number): string {
  let n = Math.round(amount);
  if (n === 0) return 'zero rupees';

  const parts: string[] = [];
  const take = (unit: number, label: string) => {
    const count = Math.floor(n / unit);
    if (count > 0) {
      parts.push(`${count} ${label}`);
      n -= count * unit;
    }
  };

  take(10_000_000, 'crore');
  take(100_000, 'lakh');
  take(1_000, 'thousand');
  if (n > 0) parts.push(String(n));

  return `${parts.join(' ')} rupees`;
}

/**
 * Strip anything unspeakable from a reply built for chat.
 * Text-to-speech reads "*" and "-" aloud, and a URL is unusable on a call.
 */
export function toSpeech(text: string, maxWords = 60): string {
  let spoken = text
    .replace(/https?:\/\/\S+/g, 'our website')
    .replace(/[*_`#>]/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\bRs\.?\s?([\d,]+)/g, (_, digits: string) => speakAmount(Number(digits.replace(/,/g, ''))))
    .replace(/\b(UC-\d{5})\b/g, (_, order: string) => speakOrderNumber(order))
    .replace(/\s{2,}/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();

  const words = spoken.split(/\s+/);
  if (words.length > maxWords) {
    // Cut on a sentence boundary rather than mid-clause.
    const truncated = words.slice(0, maxWords).join(' ');
    const lastStop = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf('?'));
    spoken = lastStop > truncated.length * 0.5 ? truncated.slice(0, lastStop + 1) : `${truncated}...`;
  }
  return spoken;
}

/* -------------------------------------------------------------------------- */
/* Tool implementations                                                       */
/* -------------------------------------------------------------------------- */

export interface VoiceToolContext {
  /** Caller id from Vapi, already normalised. Acts as identity verification. */
  callerPhone: string | null;
  callId: string | null;
  correlationId: string;
}

export interface ToolResult {
  /** What Vapi hands back to the assistant. Kept small and literal. */
  result: string;
  /** Structured data for logging and for the demo UI. */
  data?: Record<string, unknown>;
  endCall?: boolean;
  transferToHuman?: boolean;
}

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (input as Record<string, unknown>) ?? {};
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

export const voiceTools = {
  /** searchProduct - price and availability from the live catalogue. */
  async searchProduct(args: Record<string, unknown>): Promise<ToolResult> {
    const query = str(args['query'] ?? args['product'] ?? args['name']);
    if (!query) return { result: 'No product name was provided. Ask the caller which product they mean.' };

    const lookup = await productService.lookup(query);
    if (!lookup.found || !lookup.product) {
      return {
        result: `No product matching "${query}" exists in the catalogue. Tell the caller you could not find it and offer to have someone call them back. Do NOT invent a product.`,
        data: { found: false, query },
      };
    }

    const p = lookup.product;
    const availability =
      p.availability === 'in_stock'
        ? 'in stock'
        : p.availability === 'low_stock'
          ? `in stock with only ${p.stockQuantity} left`
          : p.availability.replace(/_/g, ' ');

    return {
      result: `${p.name}: price ${speakAmount(p.price)}, ${availability}${
        p.warrantyMonths ? `, ${p.warrantyMonths} month warranty` : ''
      }.`,
      data: { found: true, sku: p.sku, price: p.price, availability: p.availability },
    };
  },

  /** searchKnowledge - grounded policy answer, or an explicit "not found". */
  async searchKnowledge(
    args: Record<string, unknown>,
    ctx: VoiceToolContext,
  ): Promise<ToolResult> {
    const question = str(args['question'] ?? args['query']);
    if (!question) return { result: 'No question was provided.' };

    const classified = classify(question);
    const retrieval = await retrieve(question, {
      intent: classified.intent,
      correlationId: ctx.correlationId,
    });
    const answer = await generateGroundedAnswer({
      question,
      retrieval,
      voice: true,
      correlationId: ctx.correlationId,
    });

    if (!answer.grounded) {
      return {
        result:
          'NOT_FOUND. The knowledge base does not contain a confident answer. Tell the caller you need to check with a colleague and offer to have someone call them back. Do NOT guess.',
        data: { grounded: false, confidence: answer.confidence },
      };
    }

    return {
      result: toSpeech(answer.answer, 55),
      data: {
        grounded: true,
        confidence: answer.confidence,
        sources: answer.sources.map((s) => s.filename),
      },
    };
  },

  /** getOrderStatus - caller id is the verification factor on a phone call. */
  async getOrderStatus(args: Record<string, unknown>, ctx: VoiceToolContext): Promise<ToolResult> {
    const orderNumber = str(args['orderNumber'] ?? args['order_number'] ?? args['order']);
    if (!orderNumber) {
      return { result: 'No order number was provided. Ask the caller to read out their order number.' };
    }

    const lookup = await orderService.lookup(
      orderNumber,
      { phone: ctx.callerPhone, name: str(args['name']) },
      ctx.correlationId,
    );

    if (lookup.outcome === 'found' && lookup.order) {
      if (lookup.needsAttention) {
        await orderService.flagOrderIssue(
          lookup.order,
          `Caller asked about ${lookup.order.orderNumber} which is ${lookup.order.status}.`,
          lookup.daysOverdue,
          ctx.correlationId,
        );
      }
      return {
        result: toSpeech(lookup.message, 55),
        data: { status: lookup.order.status, orderNumber: lookup.order.orderNumber },
      };
    }

    return {
      result: toSpeech(lookup.message, 45),
      data: { outcome: lookup.outcome },
    };
  },

  /** findCustomer - lets the assistant greet a known caller by name. */
  async findCustomer(args: Record<string, unknown>, ctx: VoiceToolContext): Promise<ToolResult> {
    const phone = str(args['phone']) ?? ctx.callerPhone;
    if (!phone) return { result: 'No phone number available to look up.' };

    const customer = await customerRepo.findByPhone(phone);
    if (!customer) {
      return { result: 'NOT_FOUND. This is a new caller.', data: { found: false } };
    }

    const history = await customerRepo.getHistorySummary(customer.id);
    return {
      result: `Existing customer: ${customer.name}${
        customer.location ? ` from ${customer.location}` : ''
      }, ${history.orderCount} previous order${history.orderCount === 1 ? '' : 's'}${
        history.lastOrderNumber ? `, most recent ${speakOrderNumber(history.lastOrderNumber)} which is ${history.lastOrderStatus}` : ''
      }.`,
      data: { found: true, customerId: customer.id, name: customer.name },
    };
  },

  /** createCustomer - explicit creation, used before createLead when needed. */
  async createCustomer(args: Record<string, unknown>, ctx: VoiceToolContext): Promise<ToolResult> {
    const name = str(args['name']);
    const phone = str(args['phone']) ?? ctx.callerPhone;
    if (!name || !phone) {
      return { result: 'Both a name and a phone number are required. Ask the caller for whichever is missing.' };
    }
    const normalised = normalisePhone(phone);
    if (!normalised.ok || !normalised.e164) {
      return { result: `That phone number was not valid (${normalised.reason}). Ask the caller to repeat it.` };
    }

    const { customer, created } = await customerRepo.upsertByPhone({
      name,
      phone: normalised.e164,
      location: str(args['location']),
      preferredChannel: 'voice',
    });

    return {
      result: created
        ? `Customer record created for ${customer.name}.`
        : `Customer ${customer.name} already existed and has been updated.`,
      data: { customerId: customer.id, created },
    };
  },

  /** createLead - the full capture pipeline, identical to the chat path. */
  async createLead(args: Record<string, unknown>, ctx: VoiceToolContext): Promise<ToolResult> {
    const name = str(args['name']);
    const phone = str(args['phone']) ?? ctx.callerPhone;
    const product = str(args['product'] ?? args['productInterest']);

    const missing: string[] = [];
    if (!name) missing.push('name');
    if (!phone) missing.push('phone number');
    if (!product) missing.push('product');
    if (missing.length > 0) {
      return {
        result: `Cannot create the lead yet - still missing: ${missing.join(', ')}. Ask the caller for these, one question at a time.`,
        data: { missing },
      };
    }

    const intentRaw = str(args['purchaseIntent'] ?? args['intent']);
    const purchaseIntent: PurchaseIntent =
      intentRaw && ['ready_to_buy', 'considering', 'browsing'].includes(intentRaw)
        ? (intentRaw as PurchaseIntent)
        : /ready|now|today|yes/i.test(intentRaw ?? '')
          ? 'ready_to_buy'
          : 'considering';

    const result = await leadService.capture({
      name: name as string,
      phone: phone as string,
      product: product as string,
      budget: parseBudget(str(args['budget'])),
      location: str(args['location']),
      purchaseIntent,
      source: 'voice',
      correlationId: ctx.correlationId,
    });

    return {
      result: result.duplicate
        ? `This enquiry is already on file as ${result.lead.reference}. Reassure the caller that sales will follow up; do not take the details again.`
        : `Lead ${result.lead.reference} created${
            result.scoring.isHighValue ? ' and flagged to the sales team as high priority' : ''
          }. Confirm to the caller that sales will call them back.`,
      data: {
        reference: result.lead.reference,
        score: result.scoring.score,
        highValue: result.scoring.isHighValue,
        duplicate: result.duplicate,
      },
    };
  },

  /** createSupportTicket - a logged issue that does not end the call. */
  async createSupportTicket(
    args: Record<string, unknown>,
    ctx: VoiceToolContext,
  ): Promise<ToolResult> {
    const description = str(args['description'] ?? args['issue']);
    if (!description) return { result: 'A description of the problem is required.' };

    const phone = str(args['phone']) ?? ctx.callerPhone;
    const customer = phone ? await customerRepo.findByPhone(phone) : null;
    const reasonRaw = str(args['issueType'] ?? args['reason']) ?? '';
    const trigger: EscalationTrigger = /damag|broken|crack/i.test(`${reasonRaw} ${description}`)
      ? 'damaged_product'
      : /refund|money back/i.test(`${reasonRaw} ${description}`)
        ? 'complex_refund'
        : 'missing_information';

    const result = await escalationService.escalate({
      trigger,
      description,
      customerId: customer?.id ?? null,
      orderNumber: str(args['orderNumber']),
      correlationId: ctx.correlationId,
    });

    return {
      result: `Ticket ${result.ticket.reference} created with ${result.priority} priority. Tell the caller their reference and that support will contact them.`,
      data: { ticket: result.ticket.reference, priority: result.priority },
    };
  },

  /** escalateToHuman - hand the call over. */
  async escalateToHuman(args: Record<string, unknown>, ctx: VoiceToolContext): Promise<ToolResult> {
    const description = str(args['description'] ?? args['reason']) ?? 'Caller asked to speak to a person.';
    const phone = str(args['phone']) ?? ctx.callerPhone;
    const customer = phone ? await customerRepo.findByPhone(phone) : null;

    const reasonRaw = str(args['reason']) ?? '';
    const trigger: EscalationTrigger = /damag/i.test(reasonRaw)
      ? 'damaged_product'
      : /angry|upset|abusive/i.test(reasonRaw)
        ? 'angry_customer'
        : /refund/i.test(reasonRaw)
          ? 'complex_refund'
          : 'customer_requested_human';

    const result = await escalationService.escalate({
      trigger,
      description,
      customerId: customer?.id ?? null,
      orderNumber: str(args['orderNumber']),
      correlationId: ctx.correlationId,
    });

    return {
      result: toSpeech(result.customerMessage, 50),
      data: { ticket: result.ticket.reference, priority: result.priority },
      transferToHuman: true,
    };
  },
};

export type VoiceToolName = keyof typeof voiceTools;

/* -------------------------------------------------------------------------- */
/* Webhook dispatch                                                           */
/* -------------------------------------------------------------------------- */

export interface VapiToolCallResult {
  toolCallId: string;
  result: string;
}

export const voiceService = {
  /**
   * Handle one Vapi server webhook.
   * Returns the body Vapi expects for the given message type.
   */
  async handleWebhook(
    message: {
      type: string;
      toolCalls?: Array<{ id: string; function: { name: string; arguments: unknown } }>;
      functionCall?: { name: string; parameters: unknown };
      call?: { id?: string; customer?: { number?: string } };
      customer?: { number?: string };
      transcript?: string;
      role?: string;
      endedReason?: string;
    },
    correlationId = newCorrelationId(),
  ): Promise<Record<string, unknown>> {
    const rawPhone = message.call?.customer?.number ?? message.customer?.number ?? null;
    const normalised = rawPhone ? normalisePhone(rawPhone) : null;
    const ctx: VoiceToolContext = {
      callerPhone: normalised?.ok ? (normalised.e164 ?? null) : null,
      callId: message.call?.id ?? null,
      correlationId,
    };

    const log = logger.child({ correlationId, workflow: 'voice_request', vapiType: message.type });

    switch (message.type) {
      case 'tool-calls':
      case 'function-call':
        return this.handleToolCalls(message, ctx, log);

      case 'status-update':
      case 'speech-update':
      case 'conversation-update':
        // Acknowledged and ignored: high-frequency, no business meaning.
        return { received: true };

      case 'transcript':
        if (message.transcript && message.role === 'user' && ctx.callId) {
          await this.recordTranscript(ctx, message.transcript).catch(() => undefined);
        }
        return { received: true };

      case 'end-of-call-report':
        log.info('call ended', { endedReason: message.endedReason, callId: ctx.callId });
        await opsRepo
          .recordExecution({
            workflowName: 'voice_call',
            source: 'vapi',
            status: 'success',
            correlationId,
            executionId: ctx.callId,
            inputSummary: { endedReason: message.endedReason ?? null },
          })
          .catch(() => undefined);
        return { received: true };

      case 'assistant-request':
        // Vapi is asking which assistant to use for an inbound call. We answer
        // with the configured assistant id rather than an inline definition.
        return { received: true };

      default:
        log.debug('unhandled vapi message type');
        return { received: true };
    }
  },

  async handleToolCalls(
    message: {
      toolCalls?: Array<{ id: string; function: { name: string; arguments: unknown } }>;
      functionCall?: { name: string; parameters: unknown };
    },
    ctx: VoiceToolContext,
    log: ReturnType<typeof logger.child>,
  ): Promise<Record<string, unknown>> {
    const calls =
      message.toolCalls ??
      (message.functionCall
        ? [{ id: 'legacy', function: { name: message.functionCall.name, arguments: message.functionCall.parameters } }]
        : []);

    if (calls.length === 0) return { results: [] };

    const results: VapiToolCallResult[] = [];

    for (const call of calls) {
      const name = call.function.name as VoiceToolName;
      const args = asObject(call.function.arguments);
      const started = Date.now();

      const tool = voiceTools[name];
      if (typeof tool !== 'function') {
        log.warn('unknown voice tool requested', { tool: name });
        results.push({
          toolCallId: call.id,
          result: `Unknown tool "${name}". Tell the caller you will pass this to a colleague.`,
        });
        continue;
      }

      try {
        const outcome = await tool(args, ctx);
        results.push({ toolCallId: call.id, result: outcome.result });
        log.info('voice tool executed', {
          tool: name,
          durationMs: Date.now() - started,
          data: outcome.data,
        });
        await opsRepo
          .recordExecution({
            workflowName: `voice_tool:${name}`,
            source: 'vapi',
            status: 'success',
            correlationId: ctx.correlationId,
            executionId: ctx.callId,
            inputSummary: outcome.data ?? {},
            durationMs: Date.now() - started,
          })
          .catch(() => undefined);
      } catch (err) {
        const appErr = toAppError(err);
        log.error('voice tool failed', { tool: name, error: appErr.message });
        await opsRepo
          .recordExecution({
            workflowName: `voice_tool:${name}`,
            source: 'vapi',
            status: 'failed',
            correlationId: ctx.correlationId,
            errorCode: appErr.code,
            errorMessage: appErr.message,
          })
          .catch(() => undefined);
        // The assistant receives a speakable fallback, never the real error.
        results.push({ toolCallId: call.id, result: toSpeech(SAFE_RESPONSES.GENERIC, 40) });
      }
    }

    return { results };
  },

  /** Persist a caller utterance against the call's conversation. */
  async recordTranscript(ctx: VoiceToolContext, transcript: string): Promise<void> {
    if (!ctx.callId) return;
    const customer = ctx.callerPhone ? await customerRepo.findByPhone(ctx.callerPhone) : null;
    const conversation = await conversationRepo.getOrCreate({
      channel: 'voice',
      sessionId: ctx.callId,
      customerId: customer?.id ?? null,
      metadata: { correlationId: ctx.correlationId, callerPhone: ctx.callerPhone },
    });
    await conversationRepo.addMessage(conversation.id, { role: 'customer', content: transcript });
  },
};
