/**
 * Support ticket + task repository.
 *
 * A ticket records the customer's problem; a task is the internal unit of work
 * that a team picks up. The escalation workflow always creates both, in one
 * transaction, so a ticket can never exist without an owner.
 */

import { getDb, type SqlClient } from '../index.ts';
import type { IssueType, Priority, SupportTicket, Task, Team } from '../../models/types.ts';

interface TicketRow {
  id: string;
  reference: string;
  customer_id: string | null;
  conversation_id: string | null;
  order_id: string | null;
  issue_type: string;
  priority: string;
  description: string;
  status: string;
  assigned_to: string | null;
  assigned_team: string;
  escalation_reason: string | null;
  created_at: string | Date;
}

interface TaskRow {
  id: string;
  reference: string;
  ticket_id: string | null;
  lead_id: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  assigned_team: string;
  due_at: string | Date | null;
  created_at: string | Date;
}

const iso = (v: string | Date | null): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function mapTicket(row: TicketRow): SupportTicket {
  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    orderId: row.order_id,
    issueType: row.issue_type as IssueType,
    priority: row.priority as Priority,
    description: row.description,
    status: row.status as SupportTicket['status'],
    assignedTo: row.assigned_to,
    assignedTeam: row.assigned_team as Team,
    escalationReason: row.escalation_reason,
    createdAt: iso(row.created_at) ?? '',
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    reference: row.reference,
    ticketId: row.ticket_id,
    leadId: row.lead_id,
    title: row.title,
    description: row.description,
    priority: row.priority as Priority,
    status: row.status as Task['status'],
    assignedTeam: row.assigned_team as Team,
    dueAt: iso(row.due_at),
    createdAt: iso(row.created_at) ?? '',
  };
}

const TICKET_COLUMNS = `id, reference, customer_id, conversation_id, order_id, issue_type,
                        priority, description, status, assigned_to, assigned_team,
                        escalation_reason, created_at`;

const TASK_COLUMNS = `id, reference, ticket_id, lead_id, title, description, priority,
                      status, assigned_team, due_at, created_at`;

export interface CreateTicketInput {
  customerId?: string | null;
  conversationId?: string | null;
  orderId?: string | null;
  issueType: IssueType;
  priority: Priority;
  description: string;
  assignedTeam: Team;
  escalationReason?: string | null;
}

export interface CreateTaskInput {
  ticketId?: string | null;
  leadId?: string | null;
  title: string;
  description?: string | null;
  priority: Priority;
  assignedTeam: Team;
  dueAt?: Date | null;
}

export const supportRepo = {
  async createTicket(input: CreateTicketInput, tx?: SqlClient): Promise<SupportTicket> {
    const db = tx ?? (await getDb());
    const res = await db.query<TicketRow>(
      `INSERT INTO support_tickets
         (reference, customer_id, conversation_id, order_id, issue_type, priority,
          description, assigned_team, escalation_reason)
       VALUES (next_reference('ticket'), $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${TICKET_COLUMNS}`,
      [
        input.customerId ?? null,
        input.conversationId ?? null,
        input.orderId ?? null,
        input.issueType,
        input.priority,
        input.description,
        input.assignedTeam,
        input.escalationReason ?? null,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('ticket insert returned no row');
    return mapTicket(row);
  },

  async createTask(input: CreateTaskInput, tx?: SqlClient): Promise<Task> {
    const db = tx ?? (await getDb());
    const res = await db.query<TaskRow>(
      `INSERT INTO tasks (reference, ticket_id, lead_id, title, description, priority,
                          assigned_team, due_at)
       VALUES (next_reference('task'), $1, $2, $3, $4, $5, $6, $7)
       RETURNING ${TASK_COLUMNS}`,
      [
        input.ticketId ?? null,
        input.leadId ?? null,
        input.title,
        input.description ?? null,
        input.priority,
        input.assignedTeam,
        input.dueAt ?? null,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('task insert returned no row');
    return mapTask(row);
  },

  async findTicketByReference(reference: string, tx?: SqlClient): Promise<SupportTicket | null> {
    const db = tx ?? (await getDb());
    const res = await db.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE reference = $1`,
      [reference],
    );
    return res.rows[0] ? mapTicket(res.rows[0]) : null;
  },

  async findTicketsByCustomer(customerId: string, tx?: SqlClient): Promise<SupportTicket[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM support_tickets
       WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [customerId],
    );
    return res.rows.map(mapTicket);
  },

  async listOpenTickets(limit = 50, tx?: SqlClient): Promise<SupportTicket[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM support_tickets
       WHERE status IN ('open','in_progress')
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                              WHEN 'medium' THEN 2 ELSE 3 END,
                created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map(mapTicket);
  },

  async listTasks(limit = 50, tx?: SqlClient): Promise<Task[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(mapTask);
  },

  async updateTicketStatus(
    id: string,
    status: SupportTicket['status'],
    tx?: SqlClient,
  ): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query(
      `UPDATE support_tickets
       SET status = $2,
           resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE NULL END
       WHERE id = $1`,
      [id, status],
    );
  },
};
