/**
 * Publish the internal handbook from docs/ into Notion.
 *
 *   npm run notion:publish
 *
 * Documentation lives in git as the source of truth and is pushed to Notion,
 * not written in Notion and copied back. That direction matters: it is the only
 * way the runbook cannot drift away from the code that implements it, because
 * both change in the same commit and the same review.
 *
 * Notion holds documentation only. No customer, lead or order data is ever
 * written here - that belongs in PostgreSQL (record) and Airtable (operations).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, env, integrationReadiness } from '../backend/src/config/env.ts';
import { markdownToBlocks, notionBlocks, notionConnector } from '../backend/src/connectors/notion.connector.ts';
import { sleep } from '../backend/src/utils/misc.ts';

interface HandbookPage {
  title: string;
  icon: string;
  /** Path relative to the repository root. */
  source: string;
  summary: string;
}

/**
 * The internal handbook structure.
 * Each page is a document that already exists in the repository, so there is
 * exactly one copy of every fact.
 */
const HANDBOOK: HandbookPage[] = [
  {
    title: 'System Architecture',
    icon: '🏗️',
    source: 'docs/architecture.md',
    summary: 'How the components fit together and why each platform was chosen.',
  },
  {
    title: 'Workflow Documentation',
    icon: '⚙️',
    source: 'docs/workflows.md',
    summary: 'All seven n8n workflows, their triggers, steps and failure behaviour.',
  },
  {
    title: 'AI Behaviour and Escalation Rules',
    icon: '🤖',
    source: 'docs/ai-behaviour.md',
    summary: 'What the AI may answer, what it must refuse, and when a human takes over.',
  },
  {
    title: 'RAG Knowledge Pipeline',
    icon: '📚',
    source: 'docs/rag.md',
    summary: 'How policy documents become answers, and how to publish a new one.',
  },
  {
    title: 'API and Webhook Reference',
    icon: '🔌',
    source: 'docs/api.md',
    summary: 'Every endpoint, its authentication, request and response shape.',
  },
  {
    title: 'Setup and Operations',
    icon: '🛠️',
    source: 'docs/setup.md',
    summary: 'Running the system, configuring integrations, and troubleshooting.',
  },
  {
    title: 'Testing',
    icon: '🧪',
    source: 'docs/testing.md',
    summary: 'The test suite, the demo scenarios and the expected results.',
  },
];

async function main(): Promise<void> {
  if (!integrationReadiness.notion) {
    console.log(
      '\nNOTION_API_KEY is not set. Running in DRY-RUN: every page that would be\n' +
        'created is written to data/outbox/notion.jsonl with its full block payload.\n' +
        '\nTo publish for real:\n' +
        '  1. Create an integration at https://www.notion.so/my-integrations\n' +
        '  2. Copy the Internal Integration Secret into NOTION_API_KEY\n' +
        '  3. Create a page called "UrbanCart Internal Handbook" in Notion\n' +
        '  4. Open it -> ... -> Connections -> add your integration\n' +
        '  5. Copy the page id from its URL into NOTION_PARENT_PAGE_ID\n',
    );
  } else if (!env.notion.parentPageId) {
    console.error(
      'NOTION_API_KEY is set but NOTION_PARENT_PAGE_ID is empty.\n' +
        'Create a parent page in Notion, share it with your integration, and put its id in .env.',
    );
    process.exit(1);
  }

  let published = 0;
  let failed = 0;

  // An index page first, so the handbook has a front door.
  const indexBlocks = [
    notionBlocks.callout(
      'This handbook is generated from the UrbanCart repository. Edit the markdown in docs/ and re-run `npm run notion:publish` - edits made directly in Notion will be overwritten.',
      '⚠️',
    ),
    notionBlocks.heading(2, 'Contents'),
    ...HANDBOOK.map((p) => notionBlocks.bullet(`${p.title} - ${p.summary}`)),
    notionBlocks.divider(),
    notionBlocks.heading(2, 'Quick reference'),
    notionBlocks.bullet('Slack alerts fire for four events only: high-value lead, serious complaint, automation failure, order issue.'),
    notionBlocks.bullet('The AI never states a price, policy, delivery time or warranty term that is not in a retrieved document or the database.'),
    notionBlocks.bullet('Escalation triggers: damaged product, complex refund, angry customer, missing information, low AI confidence, explicit request for a human.'),
    notionBlocks.bullet('PostgreSQL is the system of record. Airtable is the operational mirror. If they disagree, PostgreSQL wins.'),
  ];

  const indexResult = await notionConnector.createPage(
    'UrbanCart Internal Handbook',
    indexBlocks,
    '📖',
  );
  if (indexResult.delivered || indexResult.dryRun) {
    published++;
    console.log(`  ${indexResult.dryRun ? '[dry-run]' : '[created]'} UrbanCart Internal Handbook`);
  } else {
    failed++;
    console.error(`  ! index page: ${indexResult.error}`);
  }

  for (const page of HANDBOOK) {
    const path = join(PROJECT_ROOT, page.source);
    if (!existsSync(path)) {
      console.warn(`  - skipped ${page.title} (${page.source} does not exist yet)`);
      continue;
    }

    const markdown = await readFile(path, 'utf8');
    const blocks = [
      notionBlocks.callout(`Source: ${page.source} in the UrbanCart repository.`, '📄'),
      ...markdownToBlocks(markdown),
    ];

    const result = await notionConnector.createPage(page.title, blocks, page.icon);
    if (result.delivered || result.dryRun) {
      published++;
      console.log(
        `  ${result.dryRun ? '[dry-run]' : '[created]'} ${page.title.padEnd(34)} ${blocks.length} blocks`,
      );
    } else {
      failed++;
      console.error(`  ! ${page.title}: ${result.error}`);
    }

    // Notion allows ~3 requests/second.
    await sleep(400);
  }

  console.log(`\nPublished ${published} page(s), ${failed} failed.`);
  if (!integrationReadiness.notion) {
    console.log('(dry run - see data/outbox/notion.jsonl)');
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Notion publish failed:', err);
  process.exit(1);
});
