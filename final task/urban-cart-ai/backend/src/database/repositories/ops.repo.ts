/**
 * Operations repository: workflow execution log + the integration outbox.
 *
 * These two tables are what make the system debuggable and what make delivery
 * to Slack/Airtable/Zapier reliable. Workflow 7 (centralised error handling)
 * reads and writes both.
 */

import { getDb, type SqlClient } from '../index.ts';

export type IntegrationDestination =
  | 'slack'
  | 'airtable'
  | 'notion'
  | 'zapier'
  | 'google_drive'
  | 'vapi';

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped' | 'dry_run';

export interface WorkflowExecutionInput {
  workflowName: string;
  executionId?: string | null;
  source?: 'backend' | 'n8n' | 'zapier' | 'vapi' | 'scheduler';
  status: 'started' | 'success' | 'failed' | 'partial';
  correlationId?: string | null;
  inputSummary?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

export interface IntegrationEventRow {
  id: string;
  destination: IntegrationDestination;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: unknown;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  external_ref: string | null;
  created_at: string | Date;
}

export const opsRepo = {
  /* ---------------------------------------------------------------------- */
  /* Workflow executions                                                    */
  /* ---------------------------------------------------------------------- */

  async recordExecution(input: WorkflowExecutionInput, tx?: SqlClient): Promise<string> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ id: string }>(
      `INSERT INTO workflow_executions
         (workflow_name, execution_id, source, status, correlation_id,
          input_summary, error_code, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [
        input.workflowName,
        input.executionId ?? null,
        input.source ?? 'backend',
        input.status,
        input.correlationId ?? null,
        JSON.stringify(input.inputSummary ?? {}),
        input.errorCode ?? null,
        // Truncated: this is an internal diagnostic, not a place for a stack dump.
        input.errorMessage ? input.errorMessage.slice(0, 2000) : null,
        input.durationMs ?? null,
      ],
    );
    return res.rows[0]?.id ?? '';
  },

  async recentFailures(limit = 20, tx?: SqlClient) {
    const db = tx ?? (await getDb());
    const res = await db.query<{
      workflow_name: string;
      error_code: string | null;
      error_message: string | null;
      correlation_id: string | null;
      created_at: string | Date;
    }>(
      `SELECT workflow_name, error_code, error_message, correlation_id, created_at
       FROM workflow_executions
       WHERE status = 'failed'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows;
  },

  async executionStats(tx?: SqlClient): Promise<Record<string, number>> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM workflow_executions GROUP BY status`,
    );
    const out: Record<string, number> = {};
    for (const r of res.rows) out[r.status] = Number(r.count);
    return out;
  },

  /* ---------------------------------------------------------------------- */
  /* Integration outbox                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Queue an outbound integration call. Written in the SAME transaction as the
   * business row that caused it, so we can never create a lead and then lose
   * its Slack notification because the process died in between.
   */
  async enqueue(
    input: {
      destination: IntegrationDestination;
      eventType: string;
      entityType?: string | null;
      entityId?: string | null;
      payload: Record<string, unknown>;
    },
    tx?: SqlClient,
  ): Promise<string> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ id: string }>(
      `INSERT INTO integration_events (destination, event_type, entity_type, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        input.destination,
        input.eventType,
        input.entityType ?? null,
        input.entityId ?? null,
        JSON.stringify(input.payload),
      ],
    );
    return res.rows[0]?.id ?? '';
  },

  async markDelivered(
    id: string,
    status: DeliveryStatus,
    externalRef?: string | null,
    error?: string | null,
    tx?: SqlClient,
  ): Promise<void> {
    const db = tx ?? (await getDb());
    await db.query(
      `UPDATE integration_events
       SET status = $2,
           attempts = attempts + 1,
           external_ref = COALESCE($3, external_ref),
           last_error = $4,
           delivered_at = CASE WHEN $2 IN ('delivered','dry_run') THEN now() ELSE delivered_at END
       WHERE id = $1`,
      [id, status, externalRef ?? null, error ? error.slice(0, 1000) : null],
    );
  },

  /** Undelivered events, oldest first, for the retry dispatcher. */
  async pending(limit = 50, tx?: SqlClient): Promise<IntegrationEventRow[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<IntegrationEventRow>(
      `SELECT id, destination, event_type, entity_type, entity_id, payload, status,
              attempts, last_error, external_ref, created_at
       FROM integration_events
       WHERE status IN ('pending','failed') AND attempts < 5
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return res.rows;
  },

  async listEvents(limit = 50, tx?: SqlClient): Promise<IntegrationEventRow[]> {
    const db = tx ?? (await getDb());
    const res = await db.query<IntegrationEventRow>(
      `SELECT id, destination, event_type, entity_type, entity_id, payload, status,
              attempts, last_error, external_ref, created_at
       FROM integration_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows;
  },

  async countByDestination(tx?: SqlClient): Promise<Array<{ destination: string; status: string; count: number }>> {
    const db = tx ?? (await getDb());
    const res = await db.query<{ destination: string; status: string; count: string }>(
      `SELECT destination, status, count(*)::text AS count
       FROM integration_events GROUP BY destination, status ORDER BY destination`,
    );
    return res.rows.map((r) => ({
      destination: r.destination,
      status: r.status,
      count: Number(r.count),
    }));
  },
};
