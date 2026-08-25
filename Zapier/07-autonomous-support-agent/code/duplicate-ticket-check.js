/**
 * Module 07 — AI Customer Support Resolution Agent — EXTRA CHALLENGE
 * Step: "Duplicate Ticket Check"  (Code by Zapier → Run JavaScript)
 *
 * "The agent should check whether a ticket already exists before creating a
 *  duplicate."
 *
 * ---------------------------------------------------------------------------
 * Place this AFTER a search step
 * ---------------------------------------------------------------------------
 *     Zapier Tables → Find Records  (Tickets)
 *       Customer  equals  {{customer name or email}}
 *       Status    is any of  Open, In Progress
 *
 * Zapier flattens multiple matches into comma-joined strings, so this step
 * splits them apart and looks for one in the same category.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   existingTicketIds  → {{Find Records: Ticket ID}}
 *   existingCategories → {{Find Records: Category}}
 *   existingStatuses   → {{Find Records: Status}}
 *   existingIssues     → {{Find Records: Issue}}
 *   newCategory        → {{Classify: category}}
 *   newIssue           → {{Classify: issue}}
 *   customerName       → {{Classify: customerName}}
 *   lastTicketId       → {{Find Last Ticket: Ticket ID}}   for ID generation
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   isDuplicate        Boolean
 *   shouldCreate       Boolean   create a NEW ticket
 *   shouldUpdate       Boolean   append to an EXISTING ticket
 *   existingTicketId   String    which one to update
 *   newTicketId        String    the ID to use if creating
 *   customerMessage    String    what to say back
 *   duplicateReason    String    audit
 */

function splitList(value) {
  var s = String(value || '').trim();
  if (!s) { return []; }
  return s.split(',').map(function (item) { return item.trim(); });
}

var ticketIds = splitList(inputData.existingTicketIds);
var categories = splitList(inputData.existingCategories);
var statuses = splitList(inputData.existingStatuses);
var issues = splitList(inputData.existingIssues);

var newCategory = String(inputData.newCategory || '').trim();
var newIssue = String(inputData.newIssue || '');

var OPEN_STATUSES = ['open', 'in progress'];

// --- look for an open ticket in the same category --------------------------
var isDuplicate = false;
var existingTicketId = '';
var duplicateReason = 'no open ticket in category "' + newCategory + '"';

for (var i = 0; i < ticketIds.length; i++) {
  var status = String(statuses[i] || '').toLowerCase();
  var category = String(categories[i] || '').trim();

  if (OPEN_STATUSES.indexOf(status) === -1) {
    continue;          // resolved/closed tickets do not block a new one
  }

  if (category === newCategory) {
    isDuplicate = true;
    existingTicketId = ticketIds[i];
    duplicateReason = 'open ' + category + ' ticket ' + existingTicketId +
                      ' already exists ("' + (issues[i] || '') + '")';
    break;
  }
}

// --- next ticket ID --------------------------------------------------------
var sequence = 1;
var lastId = String(inputData.lastTicketId || '').trim();
if (lastId) {
  var lastSeq = parseInt(lastId.split('-').pop(), 10);
  if (!isNaN(lastSeq)) { sequence = lastSeq + 1; }
}
var padded = String(sequence);
while (padded.length < 4) { padded = '0' + padded; }
var newTicketId = 'TKT-' + padded;

// --- what to do and what to say --------------------------------------------
var shouldCreate = !isDuplicate;
var shouldUpdate = isDuplicate;

var customerMessage;
if (isDuplicate) {
  customerMessage =
    'You already have an open ticket for this (' + existingTicketId +
    "). I've added your latest message to it.";
} else {
  customerMessage =
    "I've raised ticket " + newTicketId + ' for this. ' +
    'Our team will come back to you at your account email.';
}

output = {
  isDuplicate: isDuplicate,
  shouldCreate: shouldCreate,
  shouldUpdate: shouldUpdate,
  existingTicketId: existingTicketId,
  newTicketId: newTicketId,
  customerMessage: customerMessage,
  duplicateReason: duplicateReason,
  appendedNote: '[' + new Date().toISOString() + '] Customer followed up: ' + newIssue,
  openTicketCount: ticketIds.length
};

/**
 * ---------------------------------------------------------------------------
 * Why category, and not text similarity
 * ---------------------------------------------------------------------------
 * Matching on category + open status is coarse but predictable: a customer with
 * an open Billing ticket who writes in about billing again gets an update, not
 * a second ticket. That is the behaviour the task sheet asks for, and it is
 * explainable to a support lead in one sentence.
 *
 * Text similarity ("is this message about the same thing?") is more precise in
 * principle and much harder to defend in practice — you cannot tell a customer
 * why the system decided two of their messages were the same issue.
 *
 * If you do want a finer check, add an AI step between the search and this one:
 *
 *   "Here is an existing open ticket: {{issue}}.
 *    Here is a new message from the same customer: {{newIssue}}.
 *    Are these about the same underlying problem? Answer only YES or NO."
 *
 * and map its answer into an extra input, requiring BOTH category match AND a
 * YES before treating it as a duplicate. Keep this code step as the gate — the
 * model advises, the code decides.
 */
