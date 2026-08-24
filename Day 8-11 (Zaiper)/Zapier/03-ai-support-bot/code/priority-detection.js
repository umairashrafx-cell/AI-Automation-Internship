/**
 * Module 03 — AI Customer Support Bot (CloudFlow)
 * Step: "Detect Priority"  (Code by Zapier → Run JavaScript)
 *
 * Classifies an incoming support request into a priority band and generates
 * the ticket ID. Runs after the chatbot has handed the request off to the Zap.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   problem       → {{Webhook / Chatbot: problem}}   free text from the customer
 *   customerName  → {{Webhook / Chatbot: name}}
 *   customerEmail → {{Webhook / Chatbot: email}}
 *   lastTicketId  → {{Find Record: Ticket ID}}       optional, e.g. "TKT-0231"
 *
 * ---------------------------------------------------------------------------
 * Priority rules (from the task sheet)
 * ---------------------------------------------------------------------------
 *   "System completely down"  → Critical
 *   "Can't access account"    → High
 *   Normal question           → Medium
 *   General request           → Low
 *
 * Matching is keyword-based and ordered most-severe-first: the first band whose
 * keywords appear wins, so "can't log in and the whole system is down" is
 * correctly Critical rather than High.
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   ticketId      String   e.g. "TKT-0232"
 *   priority      String   Critical | High | Medium | Low
 *   status        String   always "Open" for a new ticket
 *   matchedOn     String   which keyword triggered the band (audit)
 *   isCritical    Boolean  drives the urgent-notification Filter/Path
 *   isHighOrAbove Boolean
 *   createdAt     String   ISO timestamp
 */

var problem = String(inputData.problem || '').toLowerCase();

// --- keyword bands, most severe first --------------------------------------
var BANDS = [
  {
    priority: 'Critical',
    keywords: [
      // "completely down" first — it catches "the system is completely down",
      // "we're completely down", and the task sheet's literal phrasing without
      // needing a variant per sentence shape.
      'completely down', 'system is down', 'system down',
      'everything is down', 'total outage', 'outage',
      'nothing works', 'nothing is working', 'cannot use anything',
      'service unavailable', 'all workflows failed', 'data loss',
      'lost all my data', 'security breach', 'hacked'
    ]
  },
  {
    priority: 'High',
    keywords: [
      "can't access account", 'cant access account', 'cannot access account',
      'locked out', 'unable to log in', "can't log in", 'cant log in',
      'cannot log in', "can't login", 'cannot login', 'account suspended',
      'charged twice', 'double charge', 'double charged', 'billing error',
      'wrong amount', 'payment failed', 'urgent', 'asap', 'immediately'
    ]
  },
  {
    priority: 'Medium',
    keywords: [
      'not working', 'error', 'issue', 'problem', 'bug', 'broken',
      'failed', 'slow', 'disconnected', 'reconnect', 'why is', 'how do i',
      'how to', 'help with'
    ]
  }
];

var priority = 'Low';       // default: general request
var matchedOn = 'no keyword matched — treated as a general request';

for (var b = 0; b < BANDS.length; b++) {
  var band = BANDS[b];
  var hit = null;

  for (var k = 0; k < band.keywords.length; k++) {
    if (problem.indexOf(band.keywords[k]) !== -1) {
      hit = band.keywords[k];
      break;
    }
  }

  if (hit) {
    priority = band.priority;
    matchedOn = '"' + hit + '" → ' + band.priority;
    break;   // most severe match wins; stop looking
  }
}

// --- ticket ID -------------------------------------------------------------
var sequence = 1;
var lastTicketId = String(inputData.lastTicketId || '').trim();

if (lastTicketId) {
  var lastSeq = parseInt(lastTicketId.split('-').pop(), 10);
  if (!isNaN(lastSeq)) {
    sequence = lastSeq + 1;
  }
}

var padded = String(sequence);
while (padded.length < 4) {
  padded = '0' + padded;
}

output = {
  ticketId: 'TKT-' + padded,
  priority: priority,
  status: 'Open',
  matchedOn: matchedOn,
  isCritical: priority === 'Critical',
  isHighOrAbove: priority === 'Critical' || priority === 'High',
  customerName: String(inputData.customerName || ''),
  customerEmail: String(inputData.customerEmail || ''),
  issue: String(inputData.problem || ''),
  createdAt: new Date().toISOString()
};

/**
 * ---------------------------------------------------------------------------
 * Keyword matching vs. asking the AI
 * ---------------------------------------------------------------------------
 * A keyword table is deterministic, free, and auditable in Zap History — you
 * can always see exactly why a ticket got its priority. The trade-off is that
 * it misses phrasings nobody thought of.
 *
 * If you want the model to classify instead, swap this step for:
 *
 *     AI by Zapier → Analyze / Extract  with the instruction:
 *     "Classify this support request as Critical, High, Medium, or Low.
 *      Critical = the system is completely down or data is lost.
 *      High     = the customer cannot access their account, or there is a
 *                 billing error on their account.
 *      Medium   = a normal question about a feature or an error.
 *      Low      = a general request or enquiry.
 *      Reply with one word only."
 *
 * Keep this code step after it as a safety net that maps any unexpected model
 * output back onto one of the four valid bands.
 */
