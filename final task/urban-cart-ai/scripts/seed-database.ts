/**
 * Apply database/seed.sql to the configured database.
 *
 *   npm run db:seed
 *
 * Idempotent - every statement in seed.sql has an ON CONFLICT clause, so this
 * can be run against an existing database without duplicating anything.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../backend/src/config/env.ts';
import { closeDatabase, getDb } from '../backend/src/database/index.ts';

async function main(): Promise<void> {
  const db = await getDb();
  const sql = readFileSync(join(PROJECT_ROOT, 'database', 'seed.sql'), 'utf8');

  await db.exec(sql);

  const counts = await db.query<{
    products: string;
    customers: string;
    orders: string;
    order_items: string;
    leads: string;
  }>(
    `SELECT (SELECT count(*)::text FROM products)    AS products,
            (SELECT count(*)::text FROM customers)   AS customers,
            (SELECT count(*)::text FROM orders)      AS orders,
            (SELECT count(*)::text FROM order_items) AS order_items,
            (SELECT count(*)::text FROM leads)       AS leads`,
  );

  const orders = await db.query<{ order_number: string; status: string; customer_name: string }>(
    `SELECT order_number, status, customer_name FROM v_order_summary ORDER BY order_number`,
  );

  console.log('\n=== Seed complete ===');
  console.table(counts.rows[0]);
  console.log('\nOrders:');
  for (const o of orders.rows) {
    console.log(`  ${o.order_number}  ${o.status.padEnd(17)} ${o.customer_name}`);
  }
  console.log('');

  await closeDatabase();
}

main().catch(async (err) => {
  console.error('Seeding failed:', err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
