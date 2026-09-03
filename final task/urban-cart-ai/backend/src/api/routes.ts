/**
 * HTTP surface.
 *
 * Three audiences, three levels of protection:
 *
 *   /api/chat, /health          public (rate limited, CORS)
 *   /api/tools/*                internal - X-API-Key. These are the endpoints
 *                               n8n and Vapi call; each maps 1:1 to a Vapi tool.
 *   /api/admin/*, /api/knowledge internal - X-API-Key.
 *   /api/voice/vapi             Vapi only - X-Vapi-Secret.
 *   /api/webhooks/*             signed with HMAC-SHA256.
 */

import { Router, type Request, type Response } from 'express';
import { env, integrationReadiness, resolvedEmbeddingProvider, resolvedLlmProvider, resolvedVectorStore, ragThresholds } from '../config/env.ts';
import { pingDatabase } from '../database/index.ts';
import { customerRepo } from '../database/repositories/customer.repo.ts';
import { leadRepo } from '../database/repositories/lead.repo.ts';
import { orderRepo } from '../database/repositories/order.repo.ts';
import { supportRepo } from '../database/repositories/support.repo.ts';
import { opsRepo } from '../database/repositories/ops.repo.ts';
import { conversationRepo } from '../database/repositories/conversation.repo.ts';
import { knowledgeRepo } from '../database/repositories/knowledge.repo.ts';
import { getEmbeddingProvider } from '../rag/embeddings.ts';
import { getVectorStore } from '../rag/vector-store.ts';
import { retrieve } from '../rag/retriever.ts';
import { generateGroundedAnswer } from '../rag/generator.ts';
import { ingestLocalKnowledgeBase } from '../rag/ingest.ts';
import { chatService } from '../services/chat.service.ts';
import { voiceService } from '../services/voice.service.ts';
import { leadService } from '../services/lead.service.ts';
import { orderService } from '../services/order.service.ts';
import { productService } from '../services/product.service.ts';
import { escalationService } from '../services/escalation.service.ts';
import { notificationService } from '../services/notification.service.ts';
import { classify } from '../services/intent.service.ts';
import {
  chatRequestSchema,
  createCustomerSchema,
  createLeadSchema,
  createTicketSchema,
  escalateSchema,
  findCustomerSchema,
  ingestRequestSchema,
  knowledgeSearchSchema,
  orderStatusSchema,
  productSearchSchema,
  vapiWebhookSchema,
} from '../models/schemas.ts';
import { requireApiKey, validateBody, verifySignature, verifyVapiSecret } from './middleware/index.ts';
import { parseBudget } from '../utils/misc.ts';
import { logger } from '../utils/logger.ts';

/** Wrap an async handler so a rejected promise reaches the error middleware. */
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: (err?: unknown) => void) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ success: true, data });

export function buildRouter(): Router {
  const router = Router();

  /* ====================================================================== */
  /* Health                                                                 */
  /* ====================================================================== */

  router.get(
    '/health',
    asyncRoute(async (_req, res) => {
      const db = await pingDatabase();
      const embedding = getEmbeddingProvider();
      const llm = resolvedLlmProvider();

      // "degraded" is honest: the service works, but on demo-grade components.
      const degraded = !embedding.isSemantic || llm === 'extractive' || env.db.driver === 'pglite';

      res.status(db.ok ? 200 : 503).json({
        status: db.ok ? (degraded ? 'degraded' : 'ok') : 'unhealthy',
        version: '1.0.0',
        checks: {
          database: { ...db, driver: env.db.driver },
          vectorStore: { kind: resolvedVectorStore() },
          embeddings: {
            provider: embedding.name,
            semantic: embedding.isSemantic,
            dimensions: embedding.dimensions,
          },
          llm: { provider: llm, model: env.llm.anthropicModel },
          ragThresholds: ragThresholds(),
        },
        integrations: integrationReadiness,
        notes: degraded
          ? 'Running with one or more demo-grade components. See /api/admin/readiness.'
          : undefined,
      });
    }),
  );

  /* ====================================================================== */
  /* Public chat                                                            */
  /* ====================================================================== */

  router.post(
    '/api/chat',
    validateBody(chatRequestSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as import('../models/schemas.ts').ChatRequest;
      const result = await chatService.handleTurn({
        message: body.message,
        sessionId: body.sessionId,
        channel: body.channel,
        phone: body.phone ?? null,
        name: body.name ?? null,
        metadata: body.metadata ?? {},
        correlationId: req.correlationId,
      });
      return ok(res, result);
    }),
  );

  router.get(
    '/api/conversations/:id',
    requireApiKey,
    asyncRoute(async (req, res) => {
      const conversation = await conversationRepo.getWithMessages(String(req.params['id']));
      if (!conversation) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
        return;
      }
      return ok(res, conversation);
    }),
  );

  /* ====================================================================== */
  /* Voice - Vapi server webhook                                            */
  /* ====================================================================== */

  router.post(
    '/api/voice/vapi',
    verifyVapiSecret,
    asyncRoute(async (req, res) => {
      const parsed = vapiWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        // Never 4xx a live call over an envelope change - log and acknowledge.
        logger.warn('unrecognised vapi payload', {
          correlationId: req.correlationId,
          issues: parsed.error.issues.slice(0, 3).map((i) => i.message),
        });
        res.json({ received: true });
        return;
      }
      const result = await voiceService.handleWebhook(parsed.data.message, req.correlationId);
      res.json(result);
    }),
  );

  /* ====================================================================== */
  /* Tool endpoints - called by n8n and by Vapi tools                       */
  /* ====================================================================== */

  const tools = Router();
  tools.use(requireApiKey);

  tools.post(
    '/searchProduct',
    validateBody(productSearchSchema),
    asyncRoute(async (req, res) => {
      const { query } = req.body as { query: string };
      const lookup = await productService.lookup(query);
      return ok(res, {
        found: lookup.found,
        ambiguous: lookup.ambiguous,
        matchType: lookup.matchType,
        product: lookup.product,
        alternatives: lookup.alternatives.slice(0, 3),
        sentence: lookup.product ? productService.availabilitySentence(lookup.product) : null,
      });
    }),
  );

  tools.post(
    '/searchKnowledge',
    validateBody(knowledgeSearchSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as { query: string; topK?: number; documentTypes?: []; metadataFilter?: Record<string, unknown> };
      const classified = classify(body.query);
      const retrieval = await retrieve(body.query, {
        intent: classified.intent,
        ...(body.topK ? { topK: body.topK } : {}),
        ...(body.documentTypes?.length ? { documentTypes: body.documentTypes } : {}),
        ...(body.metadataFilter ? { metadataFilter: body.metadataFilter } : {}),
        correlationId: req.correlationId,
      });
      const answer = await generateGroundedAnswer({
        question: body.query,
        retrieval,
        correlationId: req.correlationId,
      });
      return ok(res, {
        grounded: answer.grounded,
        answer: answer.answer,
        refusalReason: answer.refusalReason ?? null,
        confidence: answer.confidence,
        sources: answer.sources,
        retrievalStatus: retrieval.status,
        appliedFilters: retrieval.appliedFilters,
      });
    }),
  );

  tools.post(
    '/getOrderStatus',
    validateBody(orderStatusSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as { orderNumber: string; phone?: string | null; name?: string | null };
      const lookup = await orderService.lookup(
        body.orderNumber,
        { phone: body.phone ?? null, name: body.name ?? null },
        req.correlationId,
      );
      if (lookup.outcome === 'found' && lookup.order && lookup.needsAttention) {
        await orderService.flagOrderIssue(
          lookup.order,
          `Order is ${lookup.order.status} and a customer has asked about it.`,
          lookup.daysOverdue,
          req.correlationId,
        );
      }
      return ok(res, {
        outcome: lookup.outcome,
        message: lookup.message,
        order: lookup.order ? orderRepo.redactForCustomer(lookup.order) : null,
        needsAttention: lookup.needsAttention,
        daysOverdue: lookup.daysOverdue,
      });
    }),
  );

  tools.post(
    '/findCustomer',
    validateBody(findCustomerSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as { phone?: string | null; email?: string | null };
      const customer = body.phone
        ? await customerRepo.findByPhone(body.phone)
        : body.email
          ? await customerRepo.findByEmail(body.email)
          : null;
      if (!customer) return ok(res, { found: false, customer: null, history: null });
      const history = await customerRepo.getHistorySummary(customer.id);
      return ok(res, { found: true, customer, history });
    }),
  );

  tools.post(
    '/createCustomer',
    validateBody(createCustomerSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as {
        name: string;
        phone: string;
        email?: string | null;
        location?: string | null;
        channel?: 'web_chat' | 'whatsapp' | 'instagram' | 'voice' | 'email';
      };
      const result = await customerRepo.upsertByPhone({
        name: body.name,
        phone: body.phone,
        email: body.email ?? null,
        location: body.location ?? null,
        preferredChannel: body.channel ?? null,
      });
      return ok(res, result, result.created ? 201 : 200);
    }),
  );

  tools.post(
    '/createLead',
    validateBody(createLeadSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as {
        name: string;
        phone: string;
        product: string;
        budget?: number | string | null;
        location?: string | null;
        purchaseIntent?: 'ready_to_buy' | 'considering' | 'browsing';
        source: 'web_chat' | 'whatsapp' | 'instagram' | 'voice' | 'email' | 'manual';
        conversationId?: string | null;
        notes?: string | null;
      };
      try {
        const result = await leadService.capture({
          name: body.name,
          phone: body.phone,
          product: body.product,
          budget: parseBudget(body.budget ?? null),
          location: body.location ?? null,
          ...(body.purchaseIntent ? { purchaseIntent: body.purchaseIntent } : {}),
          source: body.source,
          conversationId: body.conversationId ?? null,
          notes: body.notes ?? null,
          correlationId: req.correlationId,
        });
        return ok(res, result, result.duplicate ? 200 : 201);
      } catch (err) {
        await leadService.recordFailure(err, req.correlationId);
        throw err;
      }
    }),
  );

  tools.post(
    '/createSupportTicket',
    validateBody(createTicketSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as {
        description: string;
        issueType?: string;
        phone?: string | null;
        customerId?: string | null;
        conversationId?: string | null;
        orderNumber?: string | null;
      };
      const customer = body.customerId
        ? await customerRepo.findById(body.customerId)
        : body.phone
          ? await customerRepo.findByPhone(body.phone)
          : null;

      const trigger =
        body.issueType === 'damaged_product'
          ? 'damaged_product'
          : body.issueType === 'refund_request'
            ? 'complex_refund'
            : body.issueType === 'angry_customer'
              ? 'angry_customer'
              : 'missing_information';

      const result = await escalationService.escalate({
        trigger,
        description: body.description,
        customerId: customer?.id ?? null,
        conversationId: body.conversationId ?? null,
        orderNumber: body.orderNumber ?? null,
        correlationId: req.correlationId,
      });
      return ok(res, result, 201);
    }),
  );

  tools.post(
    '/escalateToHuman',
    validateBody(escalateSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as {
        reason: 'damaged_product' | 'complex_refund' | 'angry_customer' | 'missing_information' | 'low_confidence' | 'customer_requested_human';
        description: string;
        phone?: string | null;
        customerId?: string | null;
        conversationId?: string | null;
        orderNumber?: string | null;
      };
      const customer = body.customerId
        ? await customerRepo.findById(body.customerId)
        : body.phone
          ? await customerRepo.findByPhone(body.phone)
          : null;

      const result = await escalationService.escalate({
        trigger: body.reason,
        description: body.description,
        customerId: customer?.id ?? null,
        conversationId: body.conversationId ?? null,
        orderNumber: body.orderNumber ?? null,
        correlationId: req.correlationId,
      });
      return ok(res, result, 201);
    }),
  );

  router.use('/api/tools', tools);

  /* ====================================================================== */
  /* Knowledge / RAG management                                             */
  /* ====================================================================== */

  const knowledge = Router();
  knowledge.use(requireApiKey);

  knowledge.get(
    '/documents',
    asyncRoute(async (_req, res) => {
      const [documents, stats, history] = await Promise.all([
        getVectorStore().listDocuments(),
        knowledgeRepo.stats(),
        knowledgeRepo.ingestionHistory(10),
      ]);
      return ok(res, { documents, stats, recentIngestions: history });
    }),
  );

  knowledge.post(
    '/search',
    validateBody(knowledgeSearchSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as { query: string; topK?: number; documentTypes?: [] };
      const retrieval = await retrieve(body.query, {
        ...(body.topK ? { topK: body.topK } : {}),
        ...(body.documentTypes?.length ? { documentTypes: body.documentTypes } : {}),
        correlationId: req.correlationId,
      });
      return ok(res, {
        status: retrieval.status,
        confidence: retrieval.confidence,
        bestSimilarity: retrieval.bestSimilarity,
        appliedFilters: retrieval.appliedFilters,
        timings: retrieval.timings,
        chunks: retrieval.chunks.map((c) => ({
          similarity: c.similarity,
          filename: c.filename,
          documentType: c.documentType,
          section: c.metadata['section'] ?? null,
          version: c.version,
          preview: c.chunkText.slice(0, 400),
        })),
      });
    }),
  );

  knowledge.post(
    '/ingest',
    validateBody(ingestRequestSchema),
    asyncRoute(async (req, res) => {
      const body = req.body as { force?: boolean; source: 'local' | 'google_drive' };
      if (body.source === 'google_drive') {
        // Implemented in scripts/sync-google-drive.ts; needs credentials.
        if (!integrationReadiness.googleDrive) {
          res.status(503).json({
            success: false,
            error: {
              code: 'CONFIGURATION_ERROR',
              message:
                'Google Drive is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_DRIVE_FOLDER_ID, or use source=local.',
            },
          });
          return;
        }
      }
      const result = await ingestLocalKnowledgeBase({
        force: body.force ?? false,
        correlationId: req.correlationId,
      });
      return ok(res, result);
    }),
  );

  router.use('/api/knowledge', knowledge);

  /* ====================================================================== */
  /* Admin / operations dashboard                                           */
  /* ====================================================================== */

  const admin = Router();
  admin.use(requireApiKey);

  admin.get(
    '/overview',
    asyncRoute(async (_req, res) => {
      const [orders, leads, tickets, executions, integrations, knowledge, channels] = await Promise.all([
        orderRepo.countByStatus(),
        leadRepo.countByStatus(),
        supportRepo.listOpenTickets(100),
        opsRepo.executionStats(),
        opsRepo.countByDestination(),
        knowledgeRepo.stats(),
        conversationRepo.countByChannel(),
      ]);
      return ok(res, {
        orders,
        leads,
        openTickets: tickets.length,
        ticketsByPriority: tickets.reduce<Record<string, number>>((acc, t) => {
          acc[t.priority] = (acc[t.priority] ?? 0) + 1;
          return acc;
        }, {}),
        workflowExecutions: executions,
        integrationDeliveries: integrations,
        knowledgeBase: knowledge,
        conversationsByChannel: channels,
      });
    }),
  );

  admin.get('/leads', asyncRoute(async (_req, res) => ok(res, await leadRepo.listPipeline(50))));
  admin.get('/tickets', asyncRoute(async (_req, res) => ok(res, await supportRepo.listOpenTickets(50))));
  admin.get('/tasks', asyncRoute(async (_req, res) => ok(res, await supportRepo.listTasks(50))));
  admin.get('/orders', asyncRoute(async (_req, res) => ok(res, await orderRepo.listAll(50))));
  admin.get('/customers', asyncRoute(async (_req, res) => ok(res, await customerRepo.list(50))));
  admin.get('/executions', asyncRoute(async (_req, res) => ok(res, await opsRepo.recentFailures(50))));
  admin.get('/integrations', asyncRoute(async (_req, res) => ok(res, await opsRepo.listEvents(50))));

  admin.get(
    '/readiness',
    asyncRoute(async (_req, res) =>
      ok(res, {
        integrations: integrationReadiness,
        resolved: {
          database: env.db.driver,
          vectorStore: resolvedVectorStore(),
          embeddings: resolvedEmbeddingProvider(),
          llm: resolvedLlmProvider(),
        },
        dryRunServices: Object.entries(integrationReadiness)
          .filter(([, ready]) => !ready)
          .map(([name]) => name),
      }),
    ),
  );

  router.use('/api/admin', admin);

  /* ====================================================================== */
  /* Webhooks (signed)                                                      */
  /* ====================================================================== */

  /**
   * Workflow 7: n8n reports a failed execution here.
   * n8n's own Error Trigger workflow POSTs to this endpoint, which records the
   * failure and alerts engineering with a single consistent Slack format.
   */
  router.post(
    '/api/webhooks/workflow-error',
    verifySignature,
    asyncRoute(async (req, res) => {
      const body = req.body as {
        workflow?: string;
        execution?: { id?: string; error?: { message?: string } };
        errorCode?: string;
        errorMessage?: string;
        subject?: string;
      };

      const workflow = body.workflow ?? 'unknown n8n workflow';
      const errorMessage =
        body.errorMessage ?? body.execution?.error?.message ?? 'no error message supplied';
      const errorCode = body.errorCode ?? 'N8N_EXECUTION_FAILED';

      await opsRepo.recordExecution({
        workflowName: workflow,
        source: 'n8n',
        status: 'failed',
        executionId: body.execution?.id ?? null,
        correlationId: req.correlationId,
        errorCode,
        errorMessage,
      });

      const outcome = await notificationService.notifyAutomationFailure(
        {
          workflow,
          errorCode,
          errorMessage,
          ...(body.subject ? { subject: body.subject } : {}),
          correlationId: req.correlationId,
        },
        { correlationId: req.correlationId },
      );

      return ok(res, { recorded: true, notified: outcome.sent, dryRun: outcome.dryRun });
    }),
  );

  return router;
}
