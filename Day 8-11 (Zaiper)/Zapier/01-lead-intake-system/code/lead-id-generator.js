/**
 * Module 01 — Sales Lead Intake System
 * Step: "Generate Lead ID"  (Code by Zapier → Run JavaScript)
 *
 * Produces a unique, human-readable Lead ID in the format:
 *
 *     LEAD-2026-001
 *     └──┘ └──┘ └─┘
 *      |    |    └── zero-padded sequence number for that year
 *      |    └─────── 4-digit year
 *      └──────────── fixed prefix
 *
 * ---------------------------------------------------------------------------
 * Why this needs a preceding "Find Records" step
 * ---------------------------------------------------------------------------
 * Zapier Tables has no auto-increment column, so the sequence number has to be
 * derived from what is already in the table. Place a
 *
 *     Zapier Tables → Find Records  (Leads)
 *
 * step BEFORE this one, sorted by Created At descending, limit 1, and map its
 * Lead ID output into `lastLeadId` below. On the very first run that step
 * returns nothing, which this code handles by starting the sequence at 001.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   lastLeadId   → {{Find Records: Lead ID}}   optional, e.g. "LEAD-2026-014"
 *   recordCount  → {{Find Records: Record Count}}  optional fallback
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   leadId       String   e.g. "LEAD-2026-015"
 *   sequence     Number   the numeric part
 *   year         Number
 *   createdAt    String   ISO timestamp, mapped into the Created At column
 */

var PREFIX = 'LEAD';
var PAD_WIDTH = 3;

var now = new Date();
var year = now.getUTCFullYear();

// --- work out the next sequence number -------------------------------------
var sequence = 1;

var lastLeadId = String(inputData.lastLeadId || '').trim();

if (lastLeadId) {
  // Expected shape: LEAD-<year>-<seq>
  var parts = lastLeadId.split('-');

  if (parts.length === 3) {
    var lastYear = parseInt(parts[1], 10);
    var lastSeq = parseInt(parts[2], 10);

    if (!isNaN(lastSeq)) {
      // Sequence resets each calendar year so IDs stay short and readable.
      sequence = lastYear === year ? lastSeq + 1 : 1;
    }
  }
} else if (inputData.recordCount) {
  // Fallback if the Find Records step returned a count but no parseable ID.
  var count = parseInt(inputData.recordCount, 10);
  if (!isNaN(count)) {
    sequence = count + 1;
  }
}

// --- zero-pad --------------------------------------------------------------
var padded = String(sequence);
while (padded.length < PAD_WIDTH) {
  padded = '0' + padded;
}

var leadId = PREFIX + '-' + year + '-' + padded;

output = {
  leadId: leadId,
  sequence: sequence,
  year: year,
  createdAt: now.toISOString()
};

/**
 * ---------------------------------------------------------------------------
 * Race condition note
 * ---------------------------------------------------------------------------
 * Two form submissions landing within the same second can both read the same
 * "last" record and generate the same ID. For an internship build the sequence
 * approach is what the task sheet asks for, but if you want a collision-proof
 * ID in production, append a short random suffix:
 *
 *     leadId + '-' + Math.random().toString(36).substring(2, 6).toUpperCase()
 *
 * or switch the Table's Lead ID column to Zapier's built-in record ID.
 */
