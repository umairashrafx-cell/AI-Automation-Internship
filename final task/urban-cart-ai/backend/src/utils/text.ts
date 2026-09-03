/**
 * Text utilities shared by the RAG pipeline and the intent classifier.
 */

/**
 * Clean raw extracted document text before chunking.
 *
 * PDF and DOCX extraction leaves artefacts that poison embeddings: hyphenated
 * line breaks, repeated page headers/footers, form feeds and runs of blank
 * lines. Removing them measurably improves retrieval quality.
 */
export function cleanDocumentText(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Normalise unicode punctuation that models tokenise inconsistently.
  text = text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/\f/g, '\n');

  // Re-join words split across a line break by hyphenation: "war-\nranty".
  text = text.replace(/(\w)-\n(\w)/g, '$1$2');

  // DOCX is converted to markdown, which backslash-escapes punctuation
  // ("delivery\." , "100\% original"). Left in place these escapes are quoted
  // straight back to the customer, so unescape them.
  text = text.replace(/\\([.\-+*_[\]()#!`>~|$%])/g, '$1');

  // Drop obvious page-number-only lines.
  text = text
    .split('\n')
    .filter((line) => !/^\s*(page\s+)?\d+\s*(of\s+\d+)?\s*$/i.test(line))
    .join('\n');

  // Collapse horizontal whitespace, then collapse 3+ newlines to a paragraph gap.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** Remove repeated header/footer lines that appear on most pages of a PDF. */
export function stripRepeatedLines(pages: string[], minRepeatRatio = 0.6): string[] {
  if (pages.length < 3) return pages;
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const line of page.split('\n')) {
      const key = line.trim();
      if (key.length < 8 || key.length > 120) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = pages.length * minRepeatRatio;
  const boilerplate = new Set(
    [...counts.entries()].filter(([, c]) => c >= threshold).map(([line]) => line),
  );
  if (boilerplate.size === 0) return pages;
  return pages.map((page) =>
    page
      .split('\n')
      .filter((line) => !boilerplate.has(line.trim()))
      .join('\n'),
  );
}

/** Lowercase, strip punctuation, collapse whitespace. Used for matching. */
export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'have', 'has', 'had', 'i', 'you', 'he', 'she', 'it',
  'we', 'they', 'me', 'my', 'your', 'this', 'that', 'these', 'those', 'to',
  'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'but', 'if', 'can',
  'could', 'will', 'would', 'should', 'please', 'want', 'need', 'from', 'by',
  'as', 'so', 'not', 'no', 'yes', 'about', 'there', 'their', 'what', 'how',
]);

/**
 * Very light suffix stemmer.
 *
 * The local embedding provider matches on shared vocabulary, so morphology is
 * a real failure mode: "Can I cancel my order?" shares no token with a policy
 * section titled "Order Cancellation" unless both sides are reduced to a common
 * root. Applied at index time and query time alike, so the two always agree.
 *
 * Deliberately conservative - it only strips endings that are safe without a
 * dictionary, and never shortens a word below four characters.
 */
export function stem(word: string): string {
  let w = word;
  const min = 4;

  const strip = (suffix: string, replacement = ''): boolean => {
    if (w.length - suffix.length + replacement.length >= min && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length) + replacement;
      return true;
    }
    return false;
  };

  // Longest suffixes first, one pass, then a plural pass.
  strip('ationally', 'ate') ||
    strip('ation', 'ate') ||
    strip('isation', 'ise') ||
    strip('ization', 'ize') ||
    strip('fulness', 'ful') ||
    strip('ements', 'ement') ||
    strip('ement') ||
    strip('ments', 'ment') ||
    strip('ment') ||
    strip('ness') ||
    strip('ingly') ||
    strip('edly') ||
    strip('ing') ||
    strip('ies', 'y') ||
    strip('ied', 'y') ||
    strip('ed');

  // "cancellate" -> "cancel", "deliverate" -> "deliver": the -ation rule above
  // leaves an -ate stem; drop it so it meets the verb root.
  if (w.endsWith('ate') && w.length > 6) w = w.slice(0, -3);
  // Double consonant left by -ing/-ed removal: "cancell" -> "cancel".
  if (/([bdfglmnprt])\1$/.test(w) && w.length > min) w = w.slice(0, -1);

  // Plurals. "-es" is only a real plural ending after a sibilant (boxes,
  // batches, dishes); elsewhere the "e" belongs to the word itself, so
  // "headphones" must lose only the "s" and stem to "headphone".
  if (w.length > min && w.endsWith('es') && /(?:s|x|z|ch|sh)es$/.test(w)) {
    w = w.slice(0, -2);
  } else if (w.length > min && w.endsWith('s') && !w.endsWith('ss')) {
    w = w.slice(0, -1);
  }

  return w;
}

/**
 * Content words of a string, stemmed, for the local embedding and for the
 * lexical-coverage component of the confidence score.
 */
export function tokenize(text: string): string[] {
  return normaliseForMatch(text)
    .split(' ')
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

/** Trim a string to a maximum length on a word boundary. */
export function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Split text into sentences. Deliberately simple and abbreviation-aware enough
 * for business documents (Rs., e.g., i.e., No.).
 */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\bRs\./g, 'Rs<DOT>')
    .replace(/\be\.g\./gi, 'e<DOT>g<DOT>')
    .replace(/\bi\.e\./gi, 'i<DOT>e<DOT>')
    .replace(/\bNo\./g, 'No<DOT>')
    .replace(/\bApprox\./gi, 'Approx<DOT>');

  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter(Boolean);
}
