/**
 * Module 02 — Employee Expense Approval
 * Step: "Generate Request ID"  (Code by Zapier → Run JavaScript)
 *
 * Produces a sequential request ID in the format used by the task sheet:
 *
 *     EXP-0045
 *
 * Requires a preceding step:
 *     Zapier Tables → Find Record  (Expense Requests)
 *     sort: Submitted At descending, limit 1, "create if not found" OFF
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   lastRequestId → {{Find Record: Request ID}}    optional, e.g. "EXP-0044"
 *   recordCount   → {{Find Record: Record Count}}  optional fallback
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   requestId     String   e.g. "EXP-0045"
 *   sequence      Number
 *   submittedAt   String   ISO timestamp for the Submitted At column
 */

var PREFIX = 'EXP';
var PAD_WIDTH = 4;

var sequence = 1;
var lastRequestId = String(inputData.lastRequestId || '').trim();

if (lastRequestId) {
  // Take the digits after the final hyphen: "EXP-0044" → 44
  var tail = lastRequestId.split('-').pop();
  var lastSeq = parseInt(tail, 10);

  if (!isNaN(lastSeq)) {
    sequence = lastSeq + 1;
  }
} else if (inputData.recordCount) {
  var count = parseInt(inputData.recordCount, 10);
  if (!isNaN(count)) {
    sequence = count + 1;
  }
}

// Unlike the Lead ID in Module 01, expense request numbers do NOT reset each
// year — finance teams generally want one continuous sequence per system.
var padded = String(sequence);
while (padded.length < PAD_WIDTH) {
  padded = '0' + padded;
}

output = {
  requestId: PREFIX + '-' + padded,
  sequence: sequence,
  submittedAt: new Date().toISOString()
};
