/**
 * Module 01 — Sales Lead Intake System
 * Step: "Score Lead"  (Code by Zapier → Run JavaScript)
 *
 * ---------------------------------------------------------------------------
 * inputData mapping (set these in the Code step's Input Data section)
 * ---------------------------------------------------------------------------
 *   urgency     → {{Interface Form: Urgency}}      "Low" | "Medium" | "High"
 *   budget      → {{Interface Form: Budget}}       e.g. "8000", "$8,000", "8,000 USD"
 *   leadSource  → {{Interface Form: Lead Source}}  Website | LinkedIn | Instagram | Referral | Advertisement
 *
 * ---------------------------------------------------------------------------
 * Scoring rules (from the task sheet)
 * ---------------------------------------------------------------------------
 *   Urgency     High +30   Medium +20   Low +10
 *   Budget      > $5,000 +30   $1,000–$5,000 +20   < $1,000 +10
 *   Source      Referral +20   LinkedIn +15   (others +0)
 *
 *   70+     → Hot
 *   40–69   → Warm
 *   below 40→ Cold
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   leadScore        Number   total score
 *   priority         String   Hot | Warm | Cold
 *   isHighPriority   Boolean  true when priority is Hot — used by the Filter step
 *   urgencyPoints / budgetPoints / sourcePoints  Number  breakdown, useful in Zap History
 *   scoreBreakdown   String   human-readable audit line
 */

// --- normalise inputs ------------------------------------------------------
// Zapier hands every inputData value over as a string, and empty fields arrive
// as undefined rather than "", so guard both.

var urgency = String(inputData.urgency || '').trim().toLowerCase();
var leadSource = String(inputData.leadSource || '').trim().toLowerCase();

// Budget can arrive as "$8,000", "8000 USD", "8,000". Strip everything that is
// not a digit or a decimal point before parsing.
var budgetRaw = String(inputData.budget || '');
var budget = parseFloat(budgetRaw.replace(/[^0-9.]/g, ''));
if (isNaN(budget)) {
  budget = 0;
}

// --- urgency ---------------------------------------------------------------
var urgencyPoints = 0;
if (urgency === 'high') {
  urgencyPoints = 30;
} else if (urgency === 'medium') {
  urgencyPoints = 20;
} else if (urgency === 'low') {
  urgencyPoints = 10;
}

// --- budget ----------------------------------------------------------------
// Task sheet reads "above $5,000", "$1,000–$5,000", "below $1,000".
// The band boundaries are inclusive on the middle band so $1,000 and $5,000
// both land in the middle rather than falling through a gap.
var budgetPoints = 0;
if (budget > 5000) {
  budgetPoints = 30;
} else if (budget >= 1000) {
  budgetPoints = 20;
} else if (budget > 0) {
  budgetPoints = 10;
}
// budget of 0 / unparseable scores 0 — an unqualified lead should not inherit
// the same points as a genuine sub-$1,000 budget.

// --- lead source -----------------------------------------------------------
var sourcePoints = 0;
if (leadSource === 'referral') {
  sourcePoints = 20;
} else if (leadSource === 'linkedin') {
  sourcePoints = 15;
}
// Website, Instagram, Advertisement contribute 0 per the task sheet.

// --- total & banding -------------------------------------------------------
var leadScore = urgencyPoints + budgetPoints + sourcePoints;

var priority;
if (leadScore >= 70) {
  priority = 'Hot';
} else if (leadScore >= 40) {
  priority = 'Warm';
} else {
  priority = 'Cold';
}

var scoreBreakdown =
  'Urgency(' + (inputData.urgency || 'n/a') + ')=' + urgencyPoints +
  ' + Budget(' + budget + ')=' + budgetPoints +
  ' + Source(' + (inputData.leadSource || 'n/a') + ')=' + sourcePoints +
  ' → ' + leadScore + ' (' + priority + ')';

output = {
  leadScore: leadScore,
  priority: priority,
  isHighPriority: priority === 'Hot',
  urgencyPoints: urgencyPoints,
  budgetPoints: budgetPoints,
  sourcePoints: sourcePoints,
  budgetParsed: budget,
  scoreBreakdown: scoreBreakdown
};

/**
 * ---------------------------------------------------------------------------
 * Worked example from the task sheet
 * ---------------------------------------------------------------------------
 *   Ahmad | ABC Company | $8,000 | LinkedIn | High
 *
 *   urgency  High     → +30
 *   budget   $8,000   → +30
 *   source   LinkedIn → +15
 *   ------------------------
 *   leadScore = 75  →  priority = "Hot"   ✓ matches expected result
 */
