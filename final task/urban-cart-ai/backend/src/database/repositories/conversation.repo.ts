/**
 * Conversation repository.
 *
 * A conversation is keyed by (channel, session_id) so the same customer can
 * have a live web chat and a phone call at once without the two transcripts
 * merging. Messages are append-only.
 */

import { getDb, type SqlClient } from '../index.ts';
import type {
  Channel,
  Conversation,
  ConversationMessage,
  Intent,
  RetrievedSource,
} from '../../models/types.ts';
import { MAX_MESSAGE_LENGTH } from '../../config/constants.ts';

interface ConversationRow {
  id: string;
  customer_id: string | null;
  channel: string;
  session_id: string;
  intent: string | null;
  status: string;
  escalated: boolean;
  metadata: Record<string, unknown> | string;
  created_at: string | Date;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function map(row: ConversationRow): Conversation {
  return {
    id: row.id,
    customerId: row.customer_id,
    channel: row.channel as Channel,
    sessionId: row.session_id,
    intent: row.intent as Intent | null,
    status: row.status as Conversation['status'],
    escalated: row.escalated,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const COLUMNS = `id, customer_id, channel, session_id, intent, status, escalated,
                 metadata, created_at`;

export const conversationRepo = {
  /**
   * Fetch the conversation for this (channel, session), creating it if new.
   * ON CONFLICT makes concurrent turns from the same session safe.
   */
  async getOrCreate(
    input: {
      channel: Channel;
      sessionId: string;
      customerId?: string | null;
      metadata?: Record<string, unknown>;
    },
    tx?: SqlClient,
  ): Promise<Conversation> {
    const db = tx ?? (await getDb());
    const res = await db.query<ConversationRow>(
      `INSERT INTO conversations (channel, session_id, customer_id, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (channel, session_id) DO UPDATE SET
         customer_id = COALESCE(EXCLUDED.customer_id, conversations.customer_id),
         metadata    = conversations.metadata || EXCLUDED.metadata
       RETURNING ${COLUMNS}`,
      [
        input.channel,
        input.sessionId,
        input.customerId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('conversation upsert returned no row');
    return map(row);
  },

  async addMessage(
    conversationId: string,
    message: ConversationMessage,
    tx?: SqlClient,
  ): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query(
      `INSERT INTO conversation_messages (conversation_id, role, content, intent, confidence, sources)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        conversationId,
        message.role,
        message.content.slice(0, MAX_MESSAGE_LENGTH),
        message.intent ?? null,
        message.confidence ?? null,
        JSON.stringify(message.sources ?? []),
      ],
    );
  },

  /** Recent turns, oldest first, for building LLM context. */
  async getMessages(
    conversationId: string,
    limit = 20,
    tx?: SqlClient,
  ): Promise<ConversationMessage[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<{
      role: string;
      content: string;
      intent: string | null;
      confidence: string | null;
      sources: unknown;
      created_at: string | Date;
    }>(
      `SELECT role, content, intent, confidence, sources, created_at
       FROM (
         SELECT role, content, intent, confidence, sources, created_at
         FROM conversation_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [conversationId, limit],
    );
    return res.rows.map((r) => ({
      role: r.role as ConversationMessage['role'],
      content: r.content,
      intent: r.intent as Intent | null,
      confidence: r.confidence === null ? null : Number(r.confidence),
      sources: parseJson<RetrievedSource[]>(r.sources, []),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  },

  async setIntent(conversationId: string, intent: Intent, tx?: SqlClient): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query('UPDATE conversations SET intent = $2 WHERE id = $1', [conversationId, intent]);
  },

  async markEscalated(conversationId: string, tx?: SqlClient): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query(
      `UPDATE conversations SET escalated = TRUE, status = 'escalated' WHERE id = $1`,
      [conversationId],
    );
  },

  async attachCustomer(conversationId: string, customerId: string, tx?: SqlClient): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query('UPDATE conversations SET customer_id = $2 WHERE id = $1', [
      conversationId,
      customerId,
    ]);
  },

  /** Full transcript in the shape the requirement described. */
  async getWithMessages(
    conversationId: string,
    tx?: SqlClient,
  ): Promise<(Conversation & { messages: ConversationMessage[] }) | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<ConversationRow & { messages: unknown }>(
      `SELECT ${COLUMNS}, messages FROM conversations_with_messages WHERE id = $1`,
      [conversationId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...map(row), messages: parseJson<ConversationMessage[]>(row.messages, []) };
  },

  async countByChannel(tx?: SqlClient): Promise<Record<string, number>> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ channel: string; count: string }>(
      'SELECT channel, count(*)::text AS count FROM conversations GROUP BY channel',
    );
    const out: Record<string, number> = {};
    for (const r of res.rows) out[r.channel] = Number(r.count);
    return out;
  },
};
