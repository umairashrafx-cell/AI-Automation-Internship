/**
 * Business constants and canonical copy.
 *
 * Customer-facing strings live here rather than being scattered through the
 * services, so that the "never expose a technical error to a customer" rule is
 * auditable in one file.
 */

/** Cities UrbanCart delivers to, with the delivery promise used for planning. */
export const DELIVERY_ZONES = {
  lahore: { zone: 'Zone A', minDays: 1, maxDays: 2 },
  karachi: { zone: 'Zone A', minDays: 2, maxDays: 3 },
  islamabad: { zone: 'Zone A', minDays: 2, maxDays: 3 },
  rawalpindi: { zone: 'Zone A', minDays: 2, maxDays: 3 },
  faisalabad: { zone: 'Zone B', minDays: 2, maxDays: 4 },
  multan: { zone: 'Zone B', minDays: 3, maxDays: 4 },
  peshawar: { zone: 'Zone B', minDays: 3, maxDays: 5 },
  quetta: { zone: 'Zone C', minDays: 4, maxDays: 6 },
} as const;

/**
 * Safe, customer-facing fallbacks. Every one of these is deliberately vague
 * about the internal cause: the real error goes to the logs and to Slack.
 */
export const SAFE_RESPONSES = {
  /** Generic failure of any kind. */
  GENERIC:
    "I'm sorry, I'm having trouble completing that right now. I've let our team know, and a human agent will follow up with you shortly.",
  /** RAG returned nothing usable, or confidence was below threshold. */
  NO_KNOWLEDGE:
    "I don't have confirmed information about that in our documentation, so I don't want to guess. I'm connecting you with a member of our team who can give you an accurate answer.",
  /** The order number did not match our format. */
  INVALID_ORDER_FORMAT:
    'That order number doesn\'t look like one of ours. UrbanCart order numbers look like UC-10452. Could you double-check it for me?',
  /** Format was valid but no such order exists. */
  ORDER_NOT_FOUND:
    "I couldn't find an order with that number. It may have been placed under a different number, so I'm passing this to our support team to check for you.",
  /** Order exists but the caller could not prove they own it. */
  ORDER_VERIFICATION_REQUIRED:
    'For your security I need to verify a detail before I can share order information. Could you confirm the phone number used when placing the order?',
  /** No product matched. */
  PRODUCT_NOT_FOUND:
    "I couldn't find that product in our catalogue. Could you tell me the exact model name, or would you like me to have someone from our team help you find it?",
  /** Complaint / escalation acknowledgement. */
  ESCALATED:
    "I'm really sorry about this. I've raised it as a high-priority issue and a member of our support team will contact you shortly.",
  /** Rate limited. */
  RATE_LIMITED:
    "You're sending messages a little faster than I can handle. Please give me a moment and try again.",
  /** Input failed validation. */
  INVALID_INPUT:
    "I didn't quite catch that. Could you rephrase it for me?",
} as const;

/** Signals that force a handoff to a human, per the client's requirements. */
export const ESCALATION_REASONS = {
  DAMAGED_PRODUCT: 'damaged_product',
  COMPLEX_REFUND: 'refund_request',
  ANGRY_CUSTOMER: 'angry_customer',
  MISSING_INFORMATION: 'missing_information',
  LOW_CONFIDENCE: 'low_confidence',
  EXPLICIT_REQUEST: 'other',
} as const;

/**
 * Slack notification policy.
 *
 * The client was explicit: "We don't want Slack to become noisy." Only these
 * four event classes may notify. Everything else is stored and visible in
 * Airtable/the admin API but never pushed to a channel.
 */
export const NOTIFIABLE_EVENTS = [
  'high_value_lead',
  'serious_complaint',
  'automation_failure',
  'order_issue',
] as const;

export type NotifiableEvent = (typeof NOTIFIABLE_EVENTS)[number];

/** Which Slack channel each notifiable event belongs to. */
export const EVENT_CHANNEL: Record<NotifiableEvent, 'sales' | 'support' | 'alerts'> = {
  high_value_lead: 'sales',
  serious_complaint: 'support',
  automation_failure: 'alerts',
  order_issue: 'support',
};

/** Maximum characters of a customer message we will store or log verbatim. */
export const MAX_MESSAGE_LENGTH = 4000;

/** Order numbers are strictly UC- followed by five digits. */
export const ORDER_NUMBER_PATTERN = /^UC-\d{5}$/;

/** Loose matcher used to *find* an order number inside free-form text. */
export const ORDER_NUMBER_IN_TEXT = /\bUC[-\s]?(\d{5})\b/i;

/** How many days after delivery a return may be requested (default policy). */
export const DEFAULT_RETURN_WINDOW_DAYS = 7;
