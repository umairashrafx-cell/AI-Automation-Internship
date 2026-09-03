/**
 * Backfill Airtable from PostgreSQL.
 *
 *   npm run seed:airtable
 *
 * The live path mirrors each lead/ticket as it is created. This script exists
 * for the two cases that path does not cover: standing up a new Airtable base,
 * and replaying rows that failed to deliver while Airtable was unavailable.
 *
 * One-way only. Nothing is read back from Airtable as authoritative.
 */

import { env, integrationReadiness } from '../backend/src/config/env.ts';
import { closeDatabase, getDb } from '../backend/src/database/index.ts';
import { leadRepo } from '../backend/src/database/repositories/lead.repo.ts';
import { supportRepo } from '../backend/src/database/repositories/support.repo.ts';
import { orderRepo } from '../backend/src/database/repositories/order.repo.ts';
import { customerRepo } from '../backend/src/database/repositories/customer.repo.ts';
import { airtableConnector } from '../backend/src/connectors/airtable.connector.ts';
import { sleep } from '../backend/src/utils/misc.ts';

/** Airtable allows 5 requests/second per base. Stay comfortably under it. */
const REQUEST_INTERVAL_MS = 250;

async function main(): Promise<void> {
  await getDb();

  if (!integrationReadiness.airtable) {
    console.log(
      '\nAirtable has no credentials configured.\n' +
        'Running anyway in DRY-RUN: every record that would be created is being\n' +
        'written to data/outbox/airtable.jsonl instead of sent.\n' +
        'Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env to sync for real.\n',
    );
  }

  const counters = { leads: 0, tickets: 0, orders: 0, failed: 0 };

  /* ---- Leads ---------------------------------------------------------- */
  const leads = await leadRepo.listPipeline(200);
  console.log(`Syncing ${leads.length} leads -> "${env.airtable.tables.leads}"`);
  for (const lead of leads) {
    const result = await airtableConnector.createLead(lead, lead.customerName, lead.customerPhone);
    if (result.delivered || result.dryRun) counters.leads++;
    else {
      counters.failed++;
      console.error(`  ! ${lead.reference}: ${result.error}`);
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  /* ---- Support issues -------------------------------------------------- */
  const tickets = await supportRepo.listOpenTickets(200);
  console.log(`Syncing ${tickets.length} support issues -> "${env.airtable.tables.support}"`);
  for (const ticket of tickets) {
    const customer = ticket.customerId ? await customerRepo.findById(ticket.customerId) : null;
    const order = ticket.orderId
      ? (await orderRepo.listAll(500)).find((o) => o.id === ticket.orderId)
      : null;
    const result = await airtableConnector.createSupportIssue(
      ticket,
      customer?.name ?? 'Unknown customer',
      order?.orderNumber ?? null,
    );
    if (result.delivered || result.dryRun) counters.tickets++;
    else {
      counters.failed++;
      console.error(`  ! ${ticket.reference}: ${result.error}`);
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  /* ---- Orders needing attention ---------------------------------------- */
  // Only orders operations must act on. Mirroring every order would make the
  // table a worse copy of the database rather than a work queue.
  const allOrders = await orderRepo.listAll(200);
  const needsAttention = allOrders.filter(
    (o) =>
      o.status === 'delayed' ||
      (o.expectedDelivery && !o.deliveredAt && new Date(o.expectedDelivery) < new Date()),
  );
  console.log(
    `Syncing ${needsAttention.length} orders needing attention (of ${allOrders.length}) -> "${env.airtable.tables.orders}"`,
  );
  for (const order of needsAttention) {
    const result = await airtableConnector.upsertOrder(order);
    if (result.delivered || result.dryRun) counters.orders++;
    else {
      counters.failed++;
      console.error(`  ! ${order.orderNumber}: ${result.error}`);
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  console.log('\n=== Airtable sync complete ===');
  console.log(`  leads    : ${counters.leads}`);
  console.log(`  tickets  : ${counters.tickets}`);
  console.log(`  orders   : ${counters.orders}`);
  console.log(`  failed   : ${counters.failed}`);
  console.log(
    integrationReadiness.airtable
      ? ''
      : '\n  (dry run - see data/outbox/airtable.jsonl)\n',
  );

  await closeDatabase();
  if (counters.failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('Airtable sync failed:', err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
