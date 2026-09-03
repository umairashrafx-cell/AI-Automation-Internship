/**
 * Request validation schemas.
 *
 * Every externally-reachable endpoint validates its body here before any
 * business code runs. Unknown keys are stripped rather than passed through, so
 * a caller cannot smuggle extra fields into a database write.
 */

import { z } from 'zod';
import { CHANNELS, DOCUMENT_TYPES, ISSUE_TYPES, PURCHASE_INTENTS } from './types.ts';
import { MAX_MESSAGE_LENGTH, ORDER_NUMBER_PATTERN } from '../config/constants.ts';
import { normalisePhone } from '../utils/phone.ts';

/** Accepts any local Pakistani format and normalises to E.164. */
const phoneSchema = z
  .string()
  .min(7)
  .max(20)
  .transform((value, ctx) => {
    const result = normalisePhone(value);
    if (!result.ok || !result.e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid phone number: ${result.reason}` });
      return z.NEVER;
    }
    return result.e164;
  });

const orderNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => v.replace(/\s+/g, ''))
  .refine((v) => ORDER_NUMBER_PATTERN.test(v), {
    message: 'order number must look like UC-10452',
  });

export const chatRequestSchema = z
  .object({
    message: z.string().trim().min(1, 'message is required').max(MAX_MESSAGE_LENGTH),
    sessionId: z.string().trim().min(1).max(128),
    channel: z.enum(CHANNELS).default('web_chat'),
    phone: phoneSchema.optional().nullable(),
    name: z.string().trim().min(1).max(120).optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const productSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const knowledgeSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    topK: z.number().int().min(1).max(20).optional(),
    documentTypes: z.array(z.enum(DOCUMENT_TYPES)).optional(),
    /** JSONB containment filter on chunk metadata. */
    metadataFilter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const orderStatusSchema = z
  .object({
    orderNumber: orderNumberSchema,
    phone: phoneSchema.optional().nullable(),
    name: z.string().trim().min(1).max(120).optional().nullable(),
  })
  .strict();

export const findCustomerSchema = z
  .object({
    phone: phoneSchema.optional().nullable(),
    email: z.string().trim().email().optional().nullable(),
  })
  .strict()
  .refine((v) => Boolean(v.phone || v.email), {
    message: 'either phone or email is required',
  });

export const createCustomerSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    phone: phoneSchema,
    email: z.string().trim().email().optional().nullable(),
    location: z.string().trim().max(120).optional().nullable(),
    channel: z.enum(CHANNELS).optional(),
  })
  .strict();

export const createLeadSchema = z
  .object({
    name: z.string().trim().min(2, 'name must be at least 2 characters').max(120),
    phone: phoneSchema,
    product: z.string().trim().min(2).max(200),
    // Accepts 200000, "Rs. 200,000" or "2 lakh" - normalised by the service.
    budget: z.union([z.number().nonnegative(), z.string()]).optional().nullable(),
    location: z.string().trim().max(120).optional().nullable(),
    purchaseIntent: z.enum(PURCHASE_INTENTS).optional(),
    source: z.enum([...CHANNELS, 'manual']).default('web_chat'),
    conversationId: z.string().uuid().optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

export const createTicketSchema = z
  .object({
    description: z.string().trim().min(3).max(2000),
    issueType: z.enum(ISSUE_TYPES).optional(),
    phone: phoneSchema.optional().nullable(),
    customerId: z.string().uuid().optional().nullable(),
    conversationId: z.string().uuid().optional().nullable(),
    orderNumber: orderNumberSchema.optional().nullable(),
  })
  .strict();

export const escalateSchema = z
  .object({
    reason: z
      .enum([
        'damaged_product',
        'complex_refund',
        'angry_customer',
        'missing_information',
        'low_confidence',
        'customer_requested_human',
      ])
      .default('customer_requested_human'),
    description: z.string().trim().min(3).max(2000),
    phone: phoneSchema.optional().nullable(),
    customerId: z.string().uuid().optional().nullable(),
    conversationId: z.string().uuid().optional().nullable(),
    orderNumber: orderNumberSchema.optional().nullable(),
  })
  .strict();

export const ingestRequestSchema = z
  .object({
    /** Re-embed even when the content hash is unchanged. */
    force: z.boolean().optional(),
    source: z.enum(['local', 'google_drive']).default('local'),
  })
  .strict();

/**
 * Vapi server webhook.
 *
 * Passthrough rather than strict: Vapi adds fields to its message envelope over
 * time, and rejecting an unrecognised key would break live calls. Only the
 * fields we actually read are typed.
 */
export const vapiWebhookSchema = z.object({
  message: z
    .object({
      type: z.string(),
      // Tool calls (current shape)
      toolCalls: z
        .array(
          z.object({
            id: z.string(),
            type: z.string().optional(),
            function: z.object({
              name: z.string(),
              // Vapi sends arguments as an object, or as a JSON string.
              arguments: z.union([z.record(z.string(), z.unknown()), z.string()]),
            }),
          }),
        )
        .optional(),
      // Legacy single-function shape, still emitted by older assistants.
      functionCall: z
        .object({
          name: z.string(),
          parameters: z.union([z.record(z.string(), z.unknown()), z.string()]),
        })
        .optional(),
      call: z
        .object({
          id: z.string().optional(),
          customer: z.object({ number: z.string().optional() }).passthrough().optional(),
        })
        .passthrough()
        .optional(),
      customer: z.object({ number: z.string().optional() }).passthrough().optional(),
      transcript: z.string().optional(),
      role: z.string().optional(),
      endedReason: z.string().optional(),
      artifact: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
});

export type VapiWebhook = z.infer<typeof vapiWebhookSchema>;
