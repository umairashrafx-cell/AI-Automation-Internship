/**
 * Slack connector.
 *
 * Builds real Block Kit payloads for chat.postMessage (bot token) or for an
 * incoming webhook. Only the four notifiable event classes ever reach here -
 * the routing decision itself lives in services/notification.service.ts, which
 * is what enforces "we don't want Slack to become noisy".
 */

import { env, integrationReadiness } from '../config/env.ts';
import { formatPkr } from '../utils/misc.ts';
import { formatPhoneForDisplay } from '../utils/phone.ts';
import { dispatch, type OutboundResult } from './http.ts';

type ChannelKey = 'sales' | 'support' | 'alerts';

interface Block {
  type: string;
  [key: string]: unknown;
}

function section(text: string): Block {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function fields(pairs: Array<[string, string]>): Block {
  return {
    type: 'section',
    fields: pairs.map(([label, value]) => ({
      type: 'mrkdwn',
      text: `*${label}*\n${value || '-'}`,
    })),
  };
}

function contextLine(text: string): Block {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

export interface HighValueLeadNotification {
  reference: string;
  customerName: string;
  customerPhone: string;
  product: string;
  budget: number | null;
  location: string | null;
  purchaseIntent: string;
  source: string;
  leadScore: number;
  previousOrders: number;
  lifetimeValue: number;
}

export interface ComplaintNotification {
  ticketReference: string;
  taskReference: string;
  customerName: string;
  customerPhone: string;
  issueType: string;
  priority: string;
  description: string;
  orderNumber: string | null;
  assignedTeam: string;
  escalationReason: string;
}

export interface AutomationFailureNotification {
  workflow: string;
  errorCode: string;
  errorMessage: string;
  subject?: string;
  correlationId?: string;
}

export interface OrderIssueNotification {
  orderNumber: string;
  customerName: string;
  status: string;
  issue: string;
  daysOverdue?: number;
}

const INTENT_LABELS: Record<string, string> = {
  ready_to_buy: 'Ready to purchase',
  considering: 'Considering / comparing',
  browsing: 'Just asking questions',
};

export const slackConnector = {
  get ready(): boolean {
    return integrationReadiness.slack;
  },

  /** "🔥 High Value Lead" - goes to the sales channel. */
  buildHighValueLead(lead: HighValueLeadNotification): Block[] {
    return [
      { type: 'header', text: { type: 'plain_text', text: '🔥 High Value Lead', emoji: true } },
      fields([
        ['Customer', lead.customerName],
        ['Phone', formatPhoneForDisplay(lead.customerPhone)],
        ['Product', lead.product],
        ['Budget', lead.budget === null ? 'Not stated' : formatPkr(lead.budget)],
        ['Location', lead.location ?? 'Not stated'],
        ['Intent', INTENT_LABELS[lead.purchaseIntent] ?? lead.purchaseIntent],
      ]),
      section(
        lead.previousOrders > 0
          ? `*Existing customer* - ${lead.previousOrders} previous order(s), lifetime value ${formatPkr(lead.lifetimeValue)}.`
          : '*New customer* - no previous orders on record.',
      ),
      contextLine(
        `Lead ID: *${lead.reference}*  |  Score: *${lead.leadScore}/100*  |  Source: ${lead.source.replace(/_/g, ' ')}`,
      ),
    ];
  },

  /** "🚨 High Priority Support Issue" - goes to the support channel. */
  buildComplaint(c: ComplaintNotification): Block[] {
    return [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🚨 High Priority Support Issue', emoji: true },
      },
      fields([
        ['Customer', c.customerName],
        ['Phone', formatPhoneForDisplay(c.customerPhone)],
        ['Issue', c.issueType.replace(/_/g, ' ')],
        ['Priority', c.priority.toUpperCase()],
        ['Order', c.orderNumber ?? 'Not linked to an order'],
        ['Assigned to', c.assignedTeam],
      ]),
      section(`*What the customer said*\n>${c.description.replace(/\n/g, '\n>').slice(0, 600)}`),
      section('*Human intervention required.* The AI has told the customer an agent will follow up.'),
      contextLine(`Ticket: *${c.ticketReference}*  |  Task: *${c.taskReference}*  |  Reason: ${c.escalationReason}`),
    ];
  },

  /** "⚠️ Automation Failed" - goes to the alerts channel. */
  buildAutomationFailure(f: AutomationFailureNotification): Block[] {
    return [
      { type: 'header', text: { type: 'plain_text', text: '⚠️ Automation Failed', emoji: true } },
      fields([
        ['Workflow', f.workflow],
        ['Error code', f.errorCode],
        ...(f.subject ? ([['Subject', f.subject]] as Array<[string, string]>) : []),
      ]),
      section(`*Error*\n\`\`\`${f.errorMessage.slice(0, 800)}\`\`\``),
      section('Please investigate. Customers received a safe fallback message, not this error.'),
      ...(f.correlationId ? [contextLine(`Correlation ID: \`${f.correlationId}\``)] : []),
    ];
  },

  /** "📦 Order Issue" - goes to the support channel. */
  buildOrderIssue(o: OrderIssueNotification): Block[] {
    return [
      { type: 'header', text: { type: 'plain_text', text: '📦 Order Issue', emoji: true } },
      fields([
        ['Order', o.orderNumber],
        ['Customer', o.customerName],
        ['Status', o.status.replace(/_/g, ' ')],
        ...(o.daysOverdue !== undefined
          ? ([['Days overdue', String(o.daysOverdue)]] as Array<[string, string]>)
          : []),
      ]),
      section(`*Issue*\n${o.issue}`),
    ];
  },

  /**
   * Send blocks to a channel.
   *
   * Prefers chat.postMessage with a bot token (lets us target a channel and get
   * a message ts back for threading); falls back to an incoming webhook, which
   * has a fixed channel and returns only "ok".
   */
  async send(
    channelKey: ChannelKey,
    blocks: Block[],
    fallbackText: string,
    correlationId?: string,
  ): Promise<OutboundResult> {
    const channel = env.slack.channels[channelKey];

    if (env.slack.botToken) {
      return dispatch(
        'slack',
        {
          url: 'https://slack.com/api/chat.postMessage',
          method: 'POST',
          headers: { Authorization: `Bearer ${env.slack.botToken}` },
          body: { channel, blocks, text: fallbackText, unfurl_links: false },
          operation: `chat.postMessage -> ${channel}`,
        },
        {
          ready: true,
          correlationId,
          extractRef: (data) => (data as { ts?: string })?.ts,
        },
      ).then(async (result) => {
        // Slack returns HTTP 200 with { ok: false, error: "..." } on failure.
        const body = result.data as { ok?: boolean; error?: string } | undefined;
        if (result.delivered && body && body.ok === false) {
          return {
            ...result,
            delivered: false,
            error: `slack API error: ${body.error ?? 'unknown'}`,
          };
        }
        return result;
      });
    }

    return dispatch(
      'slack',
      {
        url: env.slack.webhookUrl || 'https://hooks.slack.com/services/PLACEHOLDER',
        method: 'POST',
        body: { blocks, text: fallbackText },
        operation: `incoming-webhook -> ${channel}`,
      },
      { ready: integrationReadiness.slack, correlationId },
    );
  },
};
