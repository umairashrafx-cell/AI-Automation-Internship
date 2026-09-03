/**
 * Stage 4 of the RAG pipeline: chunking.
 *
 * Strategy: structure-aware, then size-bounded.
 *
 *   1. Split on headings so a chunk never spans two policies. This is the
 *      single biggest quality win for a policy corpus: "Can I return
 *      headphones after 10 days?" must not retrieve a chunk that starts in the
 *      return policy and ends in the warranty policy.
 *   2. Inside a section, pack whole paragraphs up to the target size.
 *   3. A paragraph larger than the target is split on sentence boundaries, so
 *      a chunk never ends mid-sentence.
 *   4. Consecutive chunks overlap by RAG_CHUNK_OVERLAP characters of trailing
 *      sentences, so a rule split across a boundary is still retrievable whole.
 *
 * Every chunk is prefixed with its heading trail, which materially improves
 * embedding recall because the topic words appear in the embedded text itself.
 */

import { env } from '../config/env.ts';
import { splitSentences } from '../utils/text.ts';

export interface Chunk {
  text: string;
  index: number;
  tokenEstimate: number;
  metadata: {
    section: string | null;
    headingTrail: string[];
    charStart: number;
    charEnd: number;
    [key: string]: unknown;
  };
}

/** ~4 characters per token for English. Good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Section {
  heading: string | null;
  level: number;
  body: string;
  offset: number;
}

/** Split text into sections on markdown headings and numbered headings. */
function splitIntoSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];

  let currentHeading: string | null = null;
  let currentLevel = 0;
  let buffer: string[] = [];
  let offset = 0;
  let bufferStart = 0;

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body || currentHeading) {
      sections.push({ heading: currentHeading, level: currentLevel, body, offset: bufferStart });
    }
    buffer = [];
  };

  for (const line of lines) {
    const md = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    const numbered = line.match(/^(\d+(?:\.\d+)*)[.)]\s+([A-Z].{2,80})$/);

    if (md?.[1] && md[2]) {
      flush();
      currentHeading = md[2].trim();
      currentLevel = md[1].length;
      bufferStart = offset;
    } else if (numbered?.[1] && numbered[2]) {
      flush();
      currentHeading = `${numbered[1]} ${numbered[2]}`.trim();
      currentLevel = numbered[1].split('.').length;
      bufferStart = offset;
    } else {
      buffer.push(line);
    }
    offset += line.length + 1;
  }
  flush();

  return sections.filter((s) => s.body.length > 0 || s.heading !== null);
}

/** Maintain the heading trail (H1 > H2 > H3) as we walk sections. */
function buildHeadingTrail(sections: Section[], index: number): string[] {
  const trail: string[] = [];
  const current = sections[index];
  if (!current) return trail;

  let level = current.level;
  for (let i = index; i >= 0 && level > 0; i--) {
    const s = sections[i];
    if (!s?.heading) continue;
    if (s.level < level || i === index) {
      if (!trail.includes(s.heading)) trail.unshift(s.heading);
      level = s.level;
    }
  }
  return trail;
}

/** Take the trailing `maxChars` worth of whole sentences, for overlap. */
function tailSentences(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const sentences = splitSentences(text);
  const picked: string[] = [];
  let total = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (!s) continue;
    if (total + s.length > maxChars && picked.length > 0) break;
    picked.unshift(s);
    total += s.length + 1;
  }
  return picked.join(' ');
}

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
  /** Extra metadata copied onto every chunk (document type, filename, …). */
  baseMetadata?: Record<string, unknown>;
}

export function chunkDocument(text: string, options: ChunkOptions = {}): Chunk[] {
  const targetSize = options.chunkSize ?? env.rag.chunkSize;
  const overlap = Math.min(options.overlap ?? env.rag.chunkOverlap, Math.floor(targetSize / 2));
  const base = options.baseMetadata ?? {};

  const sections = splitIntoSections(text);
  const chunks: Chunk[] = [];
  let index = 0;

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];
    if (!section) continue;

    const trail = buildHeadingTrail(sections, s);
    const prefix = trail.length > 0 ? `${trail.join(' > ')}\n` : '';
    const budget = Math.max(200, targetSize - prefix.length);

    // Pack paragraphs, splitting any oversized paragraph into sentences.
    const units: string[] = [];
    for (const para of section.body.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= budget) {
        units.push(p);
        continue;
      }
      let current = '';
      for (const sentence of splitSentences(p)) {
        if (current.length + sentence.length + 1 > budget && current) {
          units.push(current.trim());
          current = '';
        }
        current += (current ? ' ' : '') + sentence;
      }
      if (current.trim()) units.push(current.trim());
    }

    if (units.length === 0) continue;

    let buffer = '';
    let charStart = section.offset;
    let carry = '';

    const emit = () => {
      const body = (carry ? `${carry}\n\n` : '') + buffer;
      const full = `${prefix}${body}`.trim();
      if (full.length < 25) return; // discard fragments that cannot ground anything
      chunks.push({
        text: full,
        index: index++,
        tokenEstimate: estimateTokens(full),
        metadata: {
          ...base,
          section: section.heading,
          headingTrail: trail,
          charStart,
          charEnd: charStart + body.length,
        },
      });
      carry = overlap > 0 ? tailSentences(buffer, overlap) : '';
      charStart += body.length;
      buffer = '';
    };

    for (const unit of units) {
      if (buffer && buffer.length + unit.length + 2 > budget) emit();
      buffer += (buffer ? '\n\n' : '') + unit;
    }
    if (buffer) emit();
  }

  // A document with no detectable structure still has to be chunked.
  if (chunks.length === 0 && text.trim().length >= 25) {
    return fixedSizeChunks(text, targetSize, overlap, base);
  }

  return chunks;
}

/** Fallback: sentence-aligned fixed-size windows with overlap. */
function fixedSizeChunks(
  text: string,
  size: number,
  overlap: number,
  base: Record<string, unknown>,
): Chunk[] {
  const sentences = splitSentences(text);
  const chunks: Chunk[] = [];
  let buffer = '';
  let index = 0;
  let charStart = 0;

  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length + 1 > size) {
      chunks.push({
        text: buffer.trim(),
        index: index++,
        tokenEstimate: estimateTokens(buffer),
        metadata: { ...base, section: null, headingTrail: [], charStart, charEnd: charStart + buffer.length },
      });
      const carry = tailSentences(buffer, overlap);
      charStart += buffer.length - carry.length;
      buffer = carry;
    }
    buffer += (buffer ? ' ' : '') + sentence;
  }

  if (buffer.trim().length >= 25) {
    chunks.push({
      text: buffer.trim(),
      index: index++,
      tokenEstimate: estimateTokens(buffer),
      metadata: { ...base, section: null, headingTrail: [], charStart, charEnd: charStart + buffer.length },
    });
  }

  return chunks;
}
