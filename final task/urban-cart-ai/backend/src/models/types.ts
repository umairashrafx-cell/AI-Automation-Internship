/**
 * Domain types. These mirror database/schema.sql exactly; the repositories are
 * responsible for converting PostgreSQL NUMERIC (returned as a string by both
 * node-postgres and PGlite) into JavaScript numbers at the boundary.
 */

/* -------------------------------------------------------------------------- */
/* Enumerated values (const objects, not TS enums, so the source stays         */
/* erasable and runs under Node's native type stripping)                       */
/* -------------------------------------------------------------------------- */

export const CHANNELS = ['web_chat', 'whatsapp', 'instagram', 'voice', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

export const INTENTS = [
  'product_inquiry',
  'price_inquiry',
  'availability_inquiry',
  'policy_question',
  'order_status',
  'lead_capture',
  'complaint',
  'greeting',
  'smalltalk',
  'handoff',
  'unknown',
] as const;
export type Intent = (typeof INTENTS)[number];

export const PURCHASE_INTENTS = ['ready_to_buy', 'considering', 'browsing'] as const;
export type PurchaseIntent = (typeof PURCHASE_INTENTS)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TEAMS = ['support', 'sales', 'operations', 'logistics', 'engineering'] as const;
export type Team = (typeof TEAMS)[number];

export const ISSUE_TYPES = [
  'damaged_product',
  'refund_request',
  'delivery_delay',
  'wrong_item',
  'warranty_claim',
  'angry_customer',
  'missing_information',
  'low_confidence',
  'other',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const DOCUMENT_TYPES = [
  'product_catalog',
  'shipping_policy',
  'return_policy',
  'warranty_policy',
  'support_guidelines',
  'training',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const AVAILABILITY = [
  'in_stock',
  'low_stock',
  'out_of_stock',
  'preorder',
  'discontinued',
] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'out_for_delivery',
  'delivered',
  'delayed',
  'cancelled',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Entities                                                                   */
/* -------------------------------------------------------------------------- */

export interface Customer {
  id: string;
  name: string;
  /** E.164, e.g. +923001234567 */
  phone: string;
  email: string | null;
  location: string | null;
  preferredChannel: Channel | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: 'Electronics' | 'Accessories' | 'Home' | 'Lifestyle';
  brand: string | null;
  price: number;
  currency: string;
  availability: Availability;
  stockQuantity: number;
  warrantyMonths: number | null;
  description: string | null;
  searchAliases: string[];
  isActive: boolean;
}

export interface Lead {
  id: string;
  reference: string;
  customerId: string;
  productId: string | null;
  product: string;
  budget: number | null;
  currency: string;
  location: string | null;
  purchaseIntent: PurchaseIntent;
  source: Channel | 'manual';
  status: 'new' | 'contacted' | 'qualified' | 'won' | 'lost' | 'duplicate';
  leadScore: number;
  isHighValue: boolean;
  conversationId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  status: OrderStatus;
  paymentStatus: string;
  totalAmount: number;
  currency: string;
  orderDate: string;
  deliveryAddress: string;
  deliveryCity: string | null;
  expectedDelivery: string | null;
  deliveredAt: string | null;
  courier: string | null;
  trackingNumber: string | null;
  delayReason: string | null;
  items: OrderItem[];
}

export interface ConversationMessage {
  role: 'customer' | 'assistant' | 'system' | 'agent';
  content: string;
  intent?: Intent | null;
  confidence?: number | null;
  sources?: RetrievedSource[];
  createdAt?: string;
}

export interface Conversation {
  id: string;
  customerId: string | null;
  channel: Channel;
  sessionId: string;
  intent: Intent | null;
  status: 'active' | 'resolved' | 'escalated' | 'abandoned';
  escalated: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  reference: string;
  customerId: string | null;
  conversationId: string | null;
  orderId: string | null;
  issueType: IssueType;
  priority: Priority;
  description: string;
  status: 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
  assignedTo: string | null;
  assignedTeam: Team;
  escalationReason: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  reference: string;
  ticketId: string | null;
  leadId: string | null;
  title: string;
  description: string | null;
  priority: Priority;
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  assignedTeam: Team;
  dueAt: string | null;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Knowledge / RAG                                                            */
/* -------------------------------------------------------------------------- */

export interface KnowledgeDocument {
  id: string;
  filename: string;
  title: string | null;
  documentType: DocumentType;
  source: 'google_drive' | 'local' | 'upload' | 'notion';
  sourceRef: string | null;
  mimeType: string | null;
  contentHash: string;
  version: number;
  status: 'active' | 'superseded' | 'failed' | 'processing';
  chunkCount: number;
  charCount: number;
  effectiveFrom: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

/** A chunk returned by similarity search, with its provenance. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  chunkText: string;
  chunkIndex: number;
  similarity: number;
  filename: string;
  title: string | null;
  documentType: DocumentType;
  version: number;
  effectiveFrom: string | null;
  metadata: Record<string, unknown>;
}

/** Compact provenance stored alongside an assistant message. */
export interface RetrievedSource {
  documentId: string;
  filename: string;
  documentType: DocumentType;
  section?: string;
  version: number;
  similarity: number;
}

/* -------------------------------------------------------------------------- */
/* Conversation orchestration                                                 */
/* -------------------------------------------------------------------------- */

export interface ChatTurnInput {
  message: string;
  sessionId: string;
  channel: Channel;
  /** Known caller/customer identity, when the channel supplies one. */
  phone?: string | null;
  name?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export interface AgentAction {
  type:
    | 'product_lookup'
    | 'knowledge_search'
    | 'order_lookup'
    | 'lead_created'
    | 'ticket_created'
    | 'task_created'
    | 'escalated'
    | 'notification_sent'
    | 'customer_created';
  detail: string;
  reference?: string;
}

export interface ChatTurnResult {
  /** The text shown or spoken to the customer. Always safe. */
  reply: string;
  intent: Intent;
  conversationId: string;
  /** 0-1. Below the configured threshold the system escalates instead of answering. */
  confidence: number;
  escalated: boolean;
  sources: RetrievedSource[];
  /** What the system actually did, for the demo UI and the test assertions. */
  actions: AgentAction[];
  correlationId: string;
  /** True when a human must now take over. */
  requiresHuman: boolean;
}
