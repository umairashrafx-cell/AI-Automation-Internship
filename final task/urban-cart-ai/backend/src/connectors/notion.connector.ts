/**
 * Notion connector - internal documentation.
 *
 * Notion is for HUMANS reading about the system, not for the system's data.
 * The team already uses it ("We also use Notion for internal documentation"),
 * so the handbook - architecture, escalation rules, runbooks, API reference -
 * is published there from the repository. Docs live in git as the source of
 * truth and are pushed to Notion, so the documentation cannot drift from the
 * code that implements it.
 *
 * Notion deliberately holds NO customer, lead or order data. That belongs in
 * PostgreSQL (record) and Airtable (operations).
 *
 * API: https://api.notion.com/v1 - version pinned via the Notion-Version header.
 */

import { env, integrationReadiness } from '../config/env.ts';
import { dispatch, type OutboundResult } from './http.ts';

const API_BASE = 'https://api.notion.com/v1';
/** Notion rejects a rich_text item longer than 2000 characters. */
const RICH_TEXT_LIMIT = 2000;

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.notion.apiKey}`,
    'Notion-Version': env.notion.version,
  };
}

interface NotionBlock {
  object: 'block';
  type: string;
  [key: string]: unknown;
}

function richText(content: string) {
  return [{ type: 'text' as const, text: { content: content.slice(0, RICH_TEXT_LIMIT) } }];
}

export const notionBlocks = {
  heading(level: 1 | 2 | 3, text: string): NotionBlock {
    const type = `heading_${level}` as const;
    return { object: 'block', type, [type]: { rich_text: richText(text) } };
  },
  paragraph(text: string): NotionBlock {
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text) } };
  },
  bullet(text: string): NotionBlock {
    return {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(text) },
    };
  },
  code(text: string, language = 'json'): NotionBlock {
    return { object: 'block', type: 'code', code: { rich_text: richText(text), language } };
  },
  callout(text: string, emoji = '💡'): NotionBlock {
    return {
      object: 'block',
      type: 'callout',
      callout: { rich_text: richText(text), icon: { type: 'emoji', emoji } },
    };
  },
  divider(): NotionBlock {
    return { object: 'block', type: 'divider', divider: {} };
  },
};

/**
 * Convert a subset of Markdown to Notion blocks.
 *
 * Supports the constructs our docs actually use: ATX headings, bullets, fenced
 * code and paragraphs. Anything else becomes a paragraph rather than being
 * dropped, so no content is silently lost in translation.
 */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim() || 'plain text';
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence
      blocks.push(notionBlocks.code(body.join('\n'), language));
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading?.[1] && heading[2]) {
      blocks.push(notionBlocks.heading(heading[1].length as 1 | 2 | 3, heading[2]));
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      blocks.push(notionBlocks.bullet(trimmed.replace(/^[-*]\s+/, '')));
      i++;
      continue;
    }

    if (trimmed === '---') {
      blocks.push(notionBlocks.divider());
      i++;
      continue;
    }

    // Gather a paragraph until a blank line.
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      const l = (lines[i] ?? '').trim();
      if (/^(#{1,3}\s|[-*]\s|```)/.test(l)) break;
      para.push(l);
      i++;
    }
    if (para.length > 0) blocks.push(notionBlocks.paragraph(para.join(' ')));
  }

  return blocks;
}

export const notionConnector = {
  get ready(): boolean {
    return integrationReadiness.notion;
  },

  /**
   * Create a page under the configured parent.
   * Notion caps children at 100 blocks per request; extra blocks are appended.
   */
  async createPage(
    title: string,
    blocks: NotionBlock[],
    icon = '📘',
    correlationId?: string,
  ): Promise<OutboundResult> {
    const result = await dispatch(
      'notion',
      {
        url: `${API_BASE}/pages`,
        method: 'POST',
        headers: headers(),
        body: {
          parent: { type: 'page_id', page_id: env.notion.parentPageId || 'PARENT_PAGE_ID' },
          icon: { type: 'emoji', emoji: icon },
          properties: {
            title: { title: [{ type: 'text', text: { content: title.slice(0, 200) } }] },
          },
          children: blocks.slice(0, 100),
        },
        operation: `create page "${title}"`,
      },
      {
        ready: integrationReadiness.notion,
        correlationId,
        extractRef: (data) => (data as { id?: string })?.id,
      },
    );

    if (result.delivered && result.externalRef && blocks.length > 100) {
      for (let offset = 100; offset < blocks.length; offset += 100) {
        await this.appendBlocks(result.externalRef, blocks.slice(offset, offset + 100), correlationId);
      }
    }
    return result;
  },

  async appendBlocks(
    pageId: string,
    blocks: NotionBlock[],
    correlationId?: string,
  ): Promise<OutboundResult> {
    return dispatch(
      'notion',
      {
        url: `${API_BASE}/blocks/${pageId}/children`,
        method: 'PATCH',
        headers: headers(),
        body: { children: blocks.slice(0, 100) },
        operation: `append ${blocks.length} blocks to ${pageId}`,
      },
      { ready: integrationReadiness.notion, correlationId },
    );
  },

  async search(query: string, correlationId?: string): Promise<OutboundResult> {
    return dispatch(
      'notion',
      {
        url: `${API_BASE}/search`,
        method: 'POST',
        headers: headers(),
        body: { query, page_size: 10 },
        operation: `search "${query}"`,
      },
      { ready: integrationReadiness.notion, correlationId },
    );
  },
};

export type { NotionBlock };
