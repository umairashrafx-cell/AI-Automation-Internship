/**
 * Order lookup (Workflow 4).
 *
 * "Do not expose sensitive information without appropriate validation."
 *
 * The caller must prove they own the order before anything is revealed. On a
 * phone call the Vapi caller id satisfies this automatically; in web chat the
 * customer is asked to confirm the phone number or the name on the order. An
 * unverified caller is told nothing - not even whether the order exists - so
 * the endpoint cannot be used to enumerate order numbers.
 */

import { orderRepo } from '../database/repositories/order.repo.ts';
import { customerRepo } from '../database/repositories/customer.repo.ts';
import { opsRepo } from '../database/repositories/ops.repo.ts';
import { notificationService } from './notification.service.ts';
import { SAFE_RESPONSES } from '../config/constants.ts';
import type { Order } from '../models/types.ts';
import { daysBetween, formatPkr } from '../utils/misc.ts';
import { logger } from '../utils/logger.ts';

export interface OrderStatusResult {
  outcome: 'found' | 'invalid_format' | 'not_found' | 'verification_required';
  order: Order | null;
  /** Customer-facing sentence, safe in every outcome. */
  message: string;
  /** True when this order looks like it needs operations to intervene. */
  needsAttention: boolean;
  daysOverdue: number | null;
}

const STATUS_SENTENCE: Record<string, (o: Order) => string> = {
  pending: (o) =>
    `Order ${o.orderNumber} has been received and is awaiting confirmation. We'll dispatch it once confirmed.`,
  confirmed: (o) => `Order ${o.orderNumber} is confirmed and is being prepared for dispatch.`,
  processing: (o) => `Order ${o.orderNumber} is being packed at our warehouse.`,
  shipped: (o) =>
    `Order ${o.orderNumber} has been shipped${o.courier ? ` with ${o.courier}` : ''}${
      o.trackingNumber ? ` (tracking ${o.trackingNumber})` : ''
    }.`,
  out_for_delivery: (o) =>
    `Good news - order ${o.orderNumber} is out for delivery today${o.courier ? ` with ${o.courier}` : ''}.`,
  delivered: (o) =>
    `Order ${o.orderNumber} was delivered on ${(o.deliveredAt ?? '').slice(0, 10)}.`,
  // The stored delay_reason is a full sentence, so strip its trailing stop
  // before appending our own rather than emitting "...backlog..".
  delayed: (o) =>
    `Order ${o.orderNumber} is delayed${o.delayReason ? `: ${o.delayReason.replace(/\.\s*$/, '')}` : ''}.`,
  cancelled: (o) => `Order ${o.orderNumber} was cancelled.`,
  returned: (o) => `Order ${o.orderNumber} has been returned to us.`,
};

export const orderService = {
  /**
   * Look up an order for a customer-facing channel.
   * `identity` carries whatever the channel already knows about the caller.
   */
  async lookup(
    rawOrderNumber: string,
    identity: { phone?: string | null; name?: string | null; customerId?: string | null } = {},
    correlationId?: string,
  ): Promise<OrderStatusResult> {
    const result = await orderRepo.findForCustomerFacingLookup(rawOrderNumber, identity);

    if (result.outcome === 'invalid_format') {
      return {
        outcome: 'invalid_format',
        order: null,
        message: SAFE_RESPONSES.INVALID_ORDER_FORMAT,
        needsAttention: false,
        daysOverdue: null,
      };
    }

    if (result.outcome === 'not_found') {
      logger.info('order lookup: not found', { correlationId, orderNumber: result.orderNumber });
      return {
        outcome: 'not_found',
        order: null,
        message: SAFE_RESPONSES.ORDER_NOT_FOUND,
        needsAttention: false,
        daysOverdue: null,
      };
    }

    if (result.outcome === 'verification_required') {
      logger.warn('order lookup: verification failed', {
        correlationId,
        orderNumber: result.orderNumber,
      });
      return {
        outcome: 'verification_required',
        order: null,
        message: SAFE_RESPONSES.ORDER_VERIFICATION_REQUIRED,
        needsAttention: false,
        daysOverdue: null,
      };
    }

    const order = result.order;
    const daysOverdue = this.daysOverdue(order);
    const needsAttention =
      order.status === 'delayed' || (daysOverdue !== null && daysOverdue > 3);

    return {
      outcome: 'found',
      order,
      message: this.describe(order, daysOverdue),
      needsAttention,
      daysOverdue,
    };
  },

  /** Working days past the expected delivery date, for undelivered orders. */
  daysOverdue(order: Order): number | null {
    if (!order.expectedDelivery || order.deliveredAt) return null;
    if (['cancelled', 'returned'].includes(order.status)) return null;
    const days = daysBetween(new Date(order.expectedDelivery), new Date());
    return days > 0 ? days : null;
  },

  /** A complete, human sentence about the order. Built from data, not a model. */
  describe(order: Order, daysOverdue: number | null): string {
    const base = STATUS_SENTENCE[order.status]?.(order) ?? `Order ${order.orderNumber} is ${order.status}.`;
    const parts = [base];

    if (order.status !== 'delivered' && order.expectedDelivery) {
      parts.push(
        daysOverdue !== null && daysOverdue > 0
          ? `It was expected by ${order.expectedDelivery} and is now ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue, so I've flagged it for our team.`
          : `It is expected by ${order.expectedDelivery}.`,
      );
    }

    if (order.items.length > 0) {
      const items = order.items.map((i) => `${i.quantity} x ${i.name}`).join(', ');
      parts.push(`The order contains ${items}, totalling ${formatPkr(order.totalAmount)}.`);
    }

    return parts.join(' ');
  },

  /**
   * Raise an order issue with operations. Called when a lookup reveals an order
   * that is materially overdue - one of the four notifiable event classes.
   */
  async flagOrderIssue(
    order: Order,
    issue: string,
    daysOverdue: number | null,
    correlationId?: string,
  ): Promise<void> {
    await notificationService.notifyOrderIssue(
      {
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        status: order.status,
        issue,
        ...(daysOverdue !== null ? { daysOverdue } : {}),
      },
      { correlationId },
    );
    await opsRepo.recordExecution({
      workflowName: 'order_issue_flagged',
      status: 'success',
      correlationId: correlationId ?? null,
      inputSummary: { orderNumber: order.orderNumber, daysOverdue },
    });
  },

  /** Facts block handed to the grounded generator. */
  toFacts(order: Order) {
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      orderDate: order.orderDate,
      expectedDelivery: order.expectedDelivery,
      deliveredAt: order.deliveredAt,
      courier: order.courier,
      trackingNumber: order.trackingNumber,
      delayReason: order.delayReason,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      deliveryCity: order.deliveryCity,
    };
  },

  async ordersForCustomer(customerId: string): Promise<Order[]> {
    return orderRepo.findByCustomer(customerId);
  },

  async findCustomerByPhone(phone: string) {
    return customerRepo.findByPhone(phone);
  },
};
