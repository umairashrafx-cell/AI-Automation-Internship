/**
 * Stage 2/3 of the RAG pipeline: text extraction and cleaning.
 *
 * Handles the three formats UrbanCart said they use: "Some are PDFs, some are
 * Word documents and some information is maintained in spreadsheets."
 *
 * Each extractor returns plain text plus a little structure (headings, sheet
 * names) that the chunker uses to keep related content together.
 */

import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { cleanDocumentText, stripRepeatedLines } from '../utils/text.ts';
import { errors } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import type { DocumentType } from '../models/types.ts';

export interface ExtractedDocument {
  /** Cleaned, ready-to-chunk text. */
  text: string;
  /** The document's own title, when one can be identified. */
  title: string | null;
  /** SHA-256 of the cleaned text; drives change detection. */
  contentHash: string;
  charCount: number;
  mimeType: string;
  /** Section headings discovered in order, used to label chunks. */
  headings: string[];
  /** Extra provenance, e.g. page count or sheet names. */
  meta: Record<string, unknown>;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

export const SUPPORTED_EXTENSIONS = Object.keys(MIME_BY_EXT);

export function isSupported(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extname(filename).toLowerCase());
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The document's own title, taken from its first meaningful line.
 *
 * Not the same thing as headings[0]: in a policy PDF the first *heading* is
 * "1. Standard Return Window", while the title is "UrbanCart Return and Refund
 * Policy" on the line above it. Attributing an answer to the section instead of
 * the document reads as a citation error to a customer, so the two are found
 * separately.
 */
function findTitle(text: string): string | null {
  for (const line of text.split('\n').slice(0, 6)) {
    const t = line.replace(/^#{1,6}\s*/, '').trim();
    if (t.length < 8 || t.length > 90) continue;
    // A spreadsheet's first line is our own "Sheet: X" label, not a title.
    if (/^(sheet|column)\s*:/i.test(t)) return null;
    // Body prose, not a title.
    if (t.endsWith('.') || /^\d+[.)]\s/.test(t)) continue;
    if (!/[A-Za-z]/.test(t)) continue;
    return t;
  }
  return null;
}

/** Markdown/plain-text headings, plus ALL-CAPS or "N. Title" style headings. */
function findHeadings(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.length > 90) continue;
    if (/^#{1,6}\s+\S/.test(t)) {
      out.push(t.replace(/^#{1,6}\s+/, ''));
    } else if (/^\d+(\.\d+)*[.)]\s+[A-Z]/.test(t)) {
      out.push(t);
    } else if (t.length > 3 && t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && !/[.;:]$/.test(t)) {
      out.push(t);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-format extractors                                                      */
/* -------------------------------------------------------------------------- */

async function extractPdf(buffer: Buffer): Promise<{ text: string; meta: Record<string, unknown> }> {
  // `unpdf` wraps a current pdf.js build. (The widely-cited `pdf-parse@1.1.1`
  // bundles a 2018 pdf.js that rejects PDFs produced by modern writers with
  // "bad XRef entry" / "Illegal character", so it is not used here.)
  const { extractText, getDocumentProxy } = await import('unpdf');

  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  // Per-page text, so repeated headers and footers can be detected and dropped.
  const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });

  const deduped = stripRepeatedLines(pages);
  return {
    text: deduped.join('\n\n'),
    meta: { pageCount: totalPages },
  };
}

/** Decode the handful of HTML entities mammoth emits. */
function decodeEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

async function extractDocx(buffer: Buffer): Promise<{ text: string; meta: Record<string, unknown> }> {
  const mammoth = await import('mammoth');
  // HTML rather than mammoth's deprecated markdown converter. Heading levels
  // are what the chunker needs, and they survive the conversion below.
  const result = await mammoth.convertToHtml({ buffer });
  const errors = result.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    logger.warn('docx extraction warnings', { count: errors.length });
  }

  const text = decodeEntities(
    result.value
      .replace(/<h1[^>]*>(.*?)<\/h1>/gis, '\n\n# $1\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gis, '\n\n## $1\n')
      .replace(/<h([3-6])[^>]*>(.*?)<\/h\1>/gis, '\n\n### $2\n')
      .replace(/<li[^>]*>(.*?)<\/li>/gis, '\n- $1')
      .replace(/<\/(p|div|tr|ul|ol|table)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  );

  return { text, meta: { converter: 'mammoth->html' } };
}

/**
 * Spreadsheets become one "Sheet: <name>" block per sheet, with each row
 * rendered as `Column: value` pairs.
 *
 * Rendering rows as labelled pairs rather than raw CSV matters: an embedding of
 * "SKU: UC-ELEC-001 | Product: iPhone 15 | Price: 249999" retrieves far better
 * against "how much is the iPhone 15" than a bare comma-separated line does.
 */
async function extractXlsx(buffer: Buffer): Promise<{ text: string; meta: Record<string, unknown> }> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const blocks: string[] = [];
  const sheetNames: string[] = [];

  workbook.eachSheet((sheet) => {
    sheetNames.push(sheet.name);
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) values.push('');
        else if (typeof v === 'object' && 'result' in v) values.push(String(v.result ?? ''));
        else if (typeof v === 'object' && 'text' in v) values.push(String(v.text ?? ''));
        else values.push(String(v));
      });
      rows.push(values);
    });

    if (rows.length === 0) return;
    const header = rows[0] ?? [];
    const lines = [`## Sheet: ${sheet.name}`];
    for (const row of rows.slice(1)) {
      if (row.every((c) => c.trim() === '')) continue;
      const pairs = row
        .map((cell, i) => {
          const label = (header[i] ?? `Column ${i + 1}`).trim();
          return cell.trim() ? `${label}: ${cell.trim()}` : '';
        })
        .filter(Boolean);
      if (pairs.length > 0) lines.push(pairs.join(' | '));
    }
    blocks.push(lines.join('\n'));
  });

  return { text: blocks.join('\n\n'), meta: { sheetNames, sheetCount: sheetNames.length } };
}

/** Delimited text uses the same labelled-pair rendering as XLSX. */
function extractDelimited(raw: string, delimiter: string): { text: string; meta: Record<string, unknown> } {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { text: '', meta: { rowCount: 0 } };

  const parseLine = (line: string): string[] => {
    // Minimal RFC-4180 handling: quoted fields may contain the delimiter.
    const out: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        out.push(current);
        current = '';
      } else current += ch;
    }
    out.push(current);
    return out.map((s) => s.trim());
  };

  const header = parseLine(lines[0] ?? '');
  const body = lines.slice(1).map((line) => {
    const cells = parseLine(line);
    return cells
      .map((cell, i) => (cell ? `${header[i] ?? `Column ${i + 1}`}: ${cell}` : ''))
      .filter(Boolean)
      .join(' | ');
  });

  return { text: body.join('\n'), meta: { rowCount: body.length, columns: header } };
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

/** Extract from an in-memory buffer (Google Drive downloads take this path). */
export async function extractFromBuffer(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedDocument> {
  const ext = extname(filename).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) {
    throw errors.documentProcessing(filename, `unsupported file type "${ext}"`);
  }

  let raw: { text: string; meta: Record<string, unknown> };
  try {
    switch (ext) {
      case '.pdf':
        raw = await extractPdf(buffer);
        break;
      case '.docx':
        raw = await extractDocx(buffer);
        break;
      case '.xlsx':
        raw = await extractXlsx(buffer);
        break;
      case '.csv':
        raw = extractDelimited(buffer.toString('utf8'), ',');
        break;
      case '.tsv':
        raw = extractDelimited(buffer.toString('utf8'), '\t');
        break;
      default:
        raw = { text: buffer.toString('utf8'), meta: {} };
    }
  } catch (err) {
    throw errors.documentProcessing(filename, `extraction failed: ${(err as Error).message}`, err);
  }

  const text = cleanDocumentText(raw.text);
  if (text.length < 20) {
    throw errors.documentProcessing(
      filename,
      `extracted only ${text.length} characters - the file may be a scan or image-only PDF`,
    );
  }

  return {
    text,
    title: findTitle(text),
    contentHash: sha256(text),
    charCount: text.length,
    mimeType,
    headings: findHeadings(text),
    meta: raw.meta,
  };
}

export async function extractFromFile(path: string): Promise<ExtractedDocument> {
  const buffer = await readFile(path);
  return extractFromBuffer(buffer, basename(path));
}

/**
 * Infer document type from the Google Drive folder it lives in, falling back to
 * the filename. Folder-driven classification is what lets business staff add a
 * new policy PDF without a developer touching any code: they drop it in
 * "UrbanCart Knowledge Base/Returns/" and it is classified as a return policy.
 */
export function inferDocumentType(relativePath: string): DocumentType {
  const p = relativePath.toLowerCase().replace(/\\/g, '/');
  const folder = p.split('/').slice(0, -1).join('/');

  if (folder.includes('product')) return 'product_catalog';
  if (folder.includes('shipping') || folder.includes('delivery')) return 'shipping_policy';
  if (folder.includes('return') || folder.includes('refund')) return 'return_policy';
  if (folder.includes('warranty')) return 'warranty_policy';
  if (folder.includes('support')) return 'support_guidelines';
  if (folder.includes('training')) return 'training';

  const file = p.split('/').pop() ?? '';
  if (file.includes('catalog') || file.includes('product')) return 'product_catalog';
  if (file.includes('shipping') || file.includes('delivery')) return 'shipping_policy';
  if (file.includes('return')) return 'return_policy';
  if (file.includes('warranty')) return 'warranty_policy';
  if (file.includes('support') || file.includes('guideline')) return 'support_guidelines';
  if (file.includes('training')) return 'training';

  return 'other';
}
