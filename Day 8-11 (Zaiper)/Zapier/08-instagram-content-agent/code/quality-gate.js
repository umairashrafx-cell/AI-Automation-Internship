/**
 * Module 08 — Instagram Content Agent
 * Step: "Quality Gate"  (Code by Zapier → Run JavaScript)
 *
 * Step 4 of the agent workflow. Parses the critic's JSON, applies the score
 * threshold, and decides: approve, rewrite, or hand to a human.
 *
 * The critic returns a verdict, but the DECISION is made here — a model that
 * returns "APPROVE" alongside a 4.4 score should not be able to publish itself.
 * The number is authoritative, not the word.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   criticOutput   → the raw JSON string from the critic AI step
 *   attemptNumber  → 1 on the first pass, 2 on the rewrite (static per step)
 *   caption        → {{Generator: caption}}
 *   hook           → {{Generator: hook}}
 *   topic          → {{Generator: topic}}
 *   contentType    → {{Generator: content_type}}
 *   cta            → {{Generator: cta}}
 *   hashtags       → {{Generator: hashtags}}
 *   visualConcept  → {{Generator: visual_concept}}
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   score            Number   total, one decimal
 *   passed           Boolean  score >= 7
 *   needsRewrite     Boolean  failed AND attempts remain
 *   needsHuman       Boolean  failed AND out of attempts
 *   status           String   Awaiting Approval | Needs Human Rewrite
 *   rewriteInstructions String
 *   problems         String   newline-joined
 *   strengths        String
 *   capApplied       String
 *   parseError       String   empty unless the critic returned unusable output
 */

var PASS_THRESHOLD = 7;
var MAX_ATTEMPTS = 2;

var attemptNumber = parseInt(inputData.attemptNumber, 10);
if (isNaN(attemptNumber) || attemptNumber < 1) { attemptNumber = 1; }

// --- parse the critic's output ---------------------------------------------
// Models sometimes wrap JSON in ```json fences or add a sentence before it.
// Extract the outermost {...} rather than trusting the whole string.
var raw = String(inputData.criticOutput || '').trim();
var parseError = '';
var critique = null;

var firstBrace = raw.indexOf('{');
var lastBrace = raw.lastIndexOf('}');

if (firstBrace !== -1 && lastBrace > firstBrace) {
  try {
    critique = JSON.parse(raw.substring(firstBrace, lastBrace + 1));
  } catch (e) {
    parseError = 'Could not parse critic JSON: ' + e.message;
  }
} else {
  parseError = 'Critic returned no JSON object.';
}

// --- score -----------------------------------------------------------------
var score = 0;
var capApplied = 'none';
var problemList = [];
var strengths = '';
var rewriteInstructions = '';

if (critique) {
  score = parseFloat(critique.total_score);

  // If the critic gave criterion scores but a missing or broken total,
  // recompute the average ourselves rather than defaulting to 0.
  if (isNaN(score)) {
    var parts = [
      parseFloat(critique.hook_score),
      parseFloat(critique.repetition_score),
      parseFloat(critique.cta_score),
      parseFloat(critique.relevance_score),
      parseFloat(critique.claims_score)
    ];
    var sum = 0;
    var valid = 0;
    for (var i = 0; i < parts.length; i++) {
      if (!isNaN(parts[i])) { sum += parts[i]; valid++; }
    }
    score = valid ? Math.round((sum / valid) * 10) / 10 : 0;
  }

  capApplied = String(critique.cap_applied || 'none');

  // Enforce the caps here too — do not rely on the critic having applied them.
  if (capApplied === 'invented_claim' && score > 4) { score = 4; }
  if (capApplied === 'repetitive' && score > 6) { score = 6; }

  if (Object.prototype.toString.call(critique.problems) === '[object Array]') {
    problemList = critique.problems;
  } else if (critique.problems) {
    problemList = [String(critique.problems)];
  }

  strengths = String(critique.strengths || '');
  rewriteInstructions = String(critique.rewrite_instructions || '');
} else {
  // Unparseable critique fails closed. Never publish something that was not
  // actually reviewed.
  score = 0;
  problemList = [parseError];
  rewriteInstructions = 'The quality review did not return a usable result. Regenerate the post and review again.';
}

if (isNaN(score)) { score = 0; }

// --- decision --------------------------------------------------------------
var passed = score >= PASS_THRESHOLD;
var attemptsRemain = attemptNumber < MAX_ATTEMPTS;

var needsRewrite = !passed && attemptsRemain;
var needsHuman = !passed && !attemptsRemain;

var status;
if (passed) {
  status = 'Awaiting Approval';
} else if (needsRewrite) {
  status = 'Rewriting';
} else {
  status = 'Needs Human Rewrite';
}

output = {
  score: score,
  passed: passed,
  needsRewrite: needsRewrite,
  needsHuman: needsHuman,
  status: status,
  attemptNumber: attemptNumber,
  capApplied: capApplied,
  strengths: strengths,
  problems: problemList.join('\n- '),
  problemCount: problemList.length,
  rewriteInstructions: rewriteInstructions,
  parseError: parseError,
  // pass the content through so the storage step maps from one place
  topic: String(inputData.topic || ''),
  contentType: String(inputData.contentType || ''),
  hook: String(inputData.hook || ''),
  caption: String(inputData.caption || ''),
  cta: String(inputData.cta || ''),
  hashtags: String(inputData.hashtags || ''),
  visualConcept: String(inputData.visualConcept || ''),
  reviewSummary: 'Attempt ' + attemptNumber + ' scored ' + score + '/10 → ' + status
};

/**
 * ---------------------------------------------------------------------------
 * Why the loop is capped at 2
 * ---------------------------------------------------------------------------
 * Zapier has no loop construct, so the rewrite is built as a second generator
 * step behind a Filter on `needsRewrite`. Two attempts is the practical limit
 * before the Zap becomes unreadable — and in practice a post that fails twice
 * is failing on something the model cannot fix by rewriting (a missing case
 * study, a topic with nothing to say). That belongs with a person.
 *
 * The record is still written, with Status = "Needs Human Rewrite", so nothing
 * is silently dropped. The marketing person sees it in the calendar alongside
 * the problems the critic listed.
 *
 * ---------------------------------------------------------------------------
 * Fail-closed
 * ---------------------------------------------------------------------------
 * If the critic's output cannot be parsed, score is 0 and the post does NOT
 * pass. An unreviewable post is treated exactly like a bad one. The alternative
 * — defaulting to approve when the reviewer breaks — is how unreviewed content
 * reaches a publishing queue.
 */
