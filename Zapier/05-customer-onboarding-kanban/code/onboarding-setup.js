/**
 * Module 05 — Customer Onboarding Pipeline
 * Step: "Prepare Onboarding Record"  (Code by Zapier → Run JavaScript)
 *
 * Runs immediately after the onboarding form is submitted. Generates the
 * customer ID, assigns an account manager, computes the due date, and produces
 * every derived value the later steps need — so the Table write and the Kanban
 * card creation are both pure mapping steps with no logic in them.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   clientName     → {{Form: Client Name}}
 *   company        → {{Form: Company}}
 *   email          → {{Form: Email}}
 *   service        → {{Form: Service}}
 *   projectBudget  → {{Form: Project Budget}}
 *   startDate      → {{Form: Start Date}}      "YYYY-MM-DD"
 *   requirements   → {{Form: Requirements}}
 *   lastCustomerId → {{Find Record: Customer ID}}   optional
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   customerId        String   "CUST-0112"
 *   accountManager    String   assigned name
 *   accountManagerEmail String
 *   stage             String   always "New Lead" on creation
 *   dueDate           String   "YYYY-MM-DD"
 *   tier              String   Enterprise | Mid-Market | Standard
 *   budgetParsed      Number
 *   cardTitle         String   ready-to-use Kanban card title
 *   createdAt         String   ISO
 */

// --- account managers ------------------------------------------------------
// Assignment is by service line so the client lands with someone who knows the
// work, and falls back to round-robin within that line.
var MANAGERS = {
  'automation':  [{ name: 'Umair Ashraf',   email: 'umair@company.com' },
                  { name: 'Zainab Qureshi', email: 'zainab@company.com' }],
  'web':         [{ name: 'Hassan Raza',    email: 'hassan@company.com' }],
  'mobile':      [{ name: 'Hassan Raza',    email: 'hassan@company.com' }],
  'ai':          [{ name: 'Umair Ashraf',   email: 'umair@company.com' }],
  'consulting':  [{ name: 'Zainab Qureshi', email: 'zainab@company.com' }],
  'default':     [{ name: 'Zainab Qureshi', email: 'zainab@company.com' }]
};

// --- normalise inputs ------------------------------------------------------
var service = String(inputData.service || '').trim();
var serviceKey = service.toLowerCase();

var budgetRaw = String(inputData.projectBudget || '');
var budget = parseFloat(budgetRaw.replace(/[^0-9.]/g, ''));
if (isNaN(budget)) { budget = 0; }

// --- customer ID -----------------------------------------------------------
var sequence = 1;
var lastId = String(inputData.lastCustomerId || '').trim();
if (lastId) {
  var lastSeq = parseInt(lastId.split('-').pop(), 10);
  if (!isNaN(lastSeq)) { sequence = lastSeq + 1; }
}
var padded = String(sequence);
while (padded.length < 4) { padded = '0' + padded; }
var customerId = 'CUST-' + padded;

// --- account manager assignment --------------------------------------------
var pool = MANAGERS['default'];
for (var key in MANAGERS) {
  if (key !== 'default' && serviceKey.indexOf(key) !== -1) {
    pool = MANAGERS[key];
    break;
  }
}
// Round-robin within the pool using the sequence number — deterministic, so a
// re-run of the same record assigns the same person.
var manager = pool[sequence % pool.length];

// --- tier ------------------------------------------------------------------
var tier;
if (budget >= 50000) {
  tier = 'Enterprise';
} else if (budget >= 10000) {
  tier = 'Mid-Market';
} else {
  tier = 'Standard';
}

// --- due date --------------------------------------------------------------
// First onboarding milestone: 7 days after the requested start date, or 7 days
// from today if no start date was given.
function toISODate(dt) {
  var m = String(dt.getMonth() + 1);
  var d = String(dt.getDate());
  if (m.length < 2) { m = '0' + m; }
  if (d.length < 2) { d = '0' + d; }
  return dt.getFullYear() + '-' + m + '-' + d;
}

var startRaw = String(inputData.startDate || '').trim();
var base = new Date();
if (/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) {
  var p = startRaw.split('-');
  base = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}
var due = new Date(base.getTime());
due.setDate(due.getDate() + 7);

var clientName = String(inputData.clientName || '');
var company = String(inputData.company || '');

output = {
  customerId: customerId,
  clientName: clientName,
  company: company,
  email: String(inputData.email || ''),
  service: service,
  budgetParsed: budget,
  budgetFormatted: '$' + budget.toLocaleString('en-US'),
  startDate: startRaw,
  requirements: String(inputData.requirements || ''),
  accountManager: manager.name,
  accountManagerEmail: manager.email,
  tier: tier,
  stage: 'New Lead',
  dueDate: toISODate(due),
  cardTitle: company + ' — ' + service + ' (' + customerId + ')',
  createdAt: new Date().toISOString()
};
