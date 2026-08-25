/**
 * Module 07 — AI Customer Support Resolution Agent
 * Step: "Classify & Route"  (Code by Zapier → Run JavaScript)
 *
 * Turns the customer's message into a structured decision: intent, severity,
 * which action to take, and what to write on the ticket.
 *
 * ---------------------------------------------------------------------------
 * Where this fits
 * ---------------------------------------------------------------------------
 * If you build the agent with Zapier's AI Agent feature, the model makes these
 * decisions itself using the tools in prompts/agent-system-prompt.md, and this
 * step becomes the DETERMINISTIC BACKSTOP: run it on the model's output to
 * force any unexpected value back onto a valid intent/severity, so a
 * hallucinated category can never reach the Tickets table.
 *
 * If you build the agent as a plain Zap (no AI Agent tier), this step IS the
 * decision engine and everything downstream reads its output.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   message        → the customer's text
 *   customerEmail  → their email
 *   customerName   → optional
 *   aiIntent       → optional, an AI step's proposed intent (validated here)
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   intent           String   Password Problem | Billing Question |
 *                             Duplicate Payment | Technical Issue |
 *                             Angry Customer | General Enquiry
 *   severity         String   Critical | High | Medium | Low
 *   action           String   the action the agent should take
 *   category         String   ticket category: Account | Billing | Technical | General
 *   needsTicket      Boolean
 *   needsHuman       Boolean  escalate to a person
 *   needsCustomerLookup Boolean
 *   canSelfResolve   Boolean  agent can handle it with no ticket
 *   matchedOn        String   audit
 */

var message = String(inputData.message || '').toLowerCase();

// --- signal dictionaries ---------------------------------------------------
var ANGER = [
  'unacceptable', 'ridiculous', 'furious', 'outraged', 'disgusted',
  'worst', 'terrible service', 'appalling', 'fed up', 'sick of',
  'third time', 'fourth time', 'again and again', 'nobody has',
  'no one has', 'still waiting', 'cancel my account', 'legal action',
  'lawyer', 'chargeback', 'complaint'
];

var DUPLICATE_PAYMENT = [
  'charged twice', 'charged 2 times', 'double charge', 'double charged',
  'billed twice', 'two charges', 'duplicate charge', 'duplicate payment',
  'charged me again', 'paid twice'
];

var BILLING = [
  'billing', 'invoice', 'receipt', 'refund', 'payment', 'charge', 'charged',
  'subscription cost', 'price', 'plan cost', 'card declined', 'renew',
  // Plan questions are billing questions — they need a customer lookup, not a
  // knowledge-base answer, because the answer depends on the account.
  'my plan', 'what plan', 'which plan', 'plan am i', 'upgrade', 'downgrade',
  'subscription', 'billed'
];

var PASSWORD = [
  'password', 'reset my password', 'forgot my password', "can't log in",
  'cant log in', 'cannot log in', 'login', 'log in', 'sign in', 'locked out',
  'access my account'
];

var TECHNICAL = [
  'error', 'bug', 'broken', 'not working', "doesn't work", 'crash',
  'failed', 'failing', 'down', 'outage', 'slow', 'timeout', 'disconnected',
  'integration', 'workflow', 'api', 'sync'
];

var CRITICAL_SIGNALS = [
  'completely down', 'system is down', 'system down', 'total outage',
  'nothing works', 'nothing is working', 'lost all', 'data loss',
  'all my data', 'security breach', 'hacked', 'everything is down'
];

function matches(list) {
  for (var i = 0; i < list.length; i++) {
    if (message.indexOf(list[i]) !== -1) {
      return list[i];
    }
  }
  return null;
}

// --- classification --------------------------------------------------------
// Order matters. Anger is checked first because an angry customer goes to a
// human regardless of what they are angry about.
var intent;
var matchedOn;

var angerHit = matches(ANGER);
var criticalHit = matches(CRITICAL_SIGNALS);
var dupHit = matches(DUPLICATE_PAYMENT);
var passwordHit = matches(PASSWORD);
var billingHit = matches(BILLING);
var technicalHit = matches(TECHNICAL);

if (angerHit) {
  intent = 'Angry Customer';
  matchedOn = 'anger signal: "' + angerHit + '"';
} else if (dupHit) {
  intent = 'Duplicate Payment';
  matchedOn = 'duplicate payment: "' + dupHit + '"';
} else if (criticalHit) {
  intent = 'Technical Issue';
  matchedOn = 'critical technical signal: "' + criticalHit + '"';
} else if (passwordHit) {
  intent = 'Password Problem';
  matchedOn = 'password/access: "' + passwordHit + '"';
} else if (billingHit) {
  intent = 'Billing Question';
  matchedOn = 'billing: "' + billingHit + '"';
} else if (technicalHit) {
  intent = 'Technical Issue';
  matchedOn = 'technical: "' + technicalHit + '"';
} else {
  intent = 'General Enquiry';
  matchedOn = 'no signal matched';
}

// --- validate any AI-proposed intent ---------------------------------------
// If an AI step proposed an intent, accept it only when it is one of the valid
// values. Anything else falls back to the keyword result above.
var VALID_INTENTS = ['Password Problem', 'Billing Question', 'Duplicate Payment',
                     'Technical Issue', 'Angry Customer', 'General Enquiry'];
var aiIntent = String(inputData.aiIntent || '').trim();

if (aiIntent && VALID_INTENTS.indexOf(aiIntent) !== -1) {
  // Anger overrides the model — if the customer is angry, escalation wins
  // whatever the model thought the topic was.
  if (intent !== 'Angry Customer') {
    intent = aiIntent;
    matchedOn = 'AI classification accepted: ' + aiIntent;
  } else {
    matchedOn = matchedOn + ' (overrode AI "' + aiIntent + '" — anger escalates)';
  }
} else if (aiIntent) {
  matchedOn = matchedOn + ' (rejected invalid AI intent "' + aiIntent + '")';
}

// --- action, severity, ticketing -------------------------------------------
var severity, action, category, needsTicket, needsHuman, needsCustomerLookup, canSelfResolve;

if (intent === 'Angry Customer') {
  severity = 'Critical';
  action = 'Escalate to human';
  category = 'General';
  needsTicket = true;
  needsHuman = true;
  needsCustomerLookup = true;
  canSelfResolve = false;

} else if (intent === 'Duplicate Payment') {
  severity = 'High';
  action = 'Create finance ticket';
  category = 'Billing';
  needsTicket = true;
  needsHuman = false;
  needsCustomerLookup = true;
  canSelfResolve = false;

} else if (intent === 'Password Problem') {
  severity = 'Medium';
  action = 'Send password reset instructions';
  category = 'Account';
  needsTicket = false;
  needsHuman = false;
  needsCustomerLookup = false;
  canSelfResolve = true;

} else if (intent === 'Billing Question') {
  severity = 'Medium';
  action = 'Search customer/order data';
  category = 'Billing';
  needsTicket = false;
  needsHuman = false;
  needsCustomerLookup = true;
  canSelfResolve = true;

} else if (intent === 'Technical Issue') {
  severity = criticalHit ? 'Critical' : 'Medium';
  action = 'Create technical support ticket';
  category = 'Technical';
  needsTicket = true;
  needsHuman = severity === 'Critical';
  needsCustomerLookup = true;
  canSelfResolve = false;

} else {
  severity = 'Low';
  action = 'Answer from knowledge base';
  category = 'General';
  needsTicket = false;
  needsHuman = false;
  needsCustomerLookup = false;
  canSelfResolve = true;
}

output = {
  intent: intent,
  severity: severity,
  action: action,
  category: category,
  needsTicket: needsTicket,
  needsHuman: needsHuman,
  needsCustomerLookup: needsCustomerLookup,
  canSelfResolve: canSelfResolve,
  matchedOn: matchedOn,
  customerEmail: String(inputData.customerEmail || ''),
  customerName: String(inputData.customerName || ''),
  issue: String(inputData.message || ''),
  decisionTrace: 'intent=' + intent + ' severity=' + severity +
                 ' action="' + action + '" (' + matchedOn + ')'
};

/**
 * ---------------------------------------------------------------------------
 * Worked example from the task sheet
 * ---------------------------------------------------------------------------
 *   "I was charged twice for my subscription."
 *
 *   → no anger signal
 *   → "charged twice" matches DUPLICATE_PAYMENT
 *   → intent   = "Duplicate Payment"
 *     severity = "High"
 *     action   = "Create finance ticket"
 *     category = "Billing"
 *
 *   ✓ matches the expected Intent: Billing Issue / Severity: High, and the
 *     action mapping "Duplicate payment → Create finance ticket".
 */
