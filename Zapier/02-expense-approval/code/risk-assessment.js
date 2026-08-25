/**
 * Module 02 — Employee Expense Approval
 * Step: "Assess Risk"  (Code by Zapier → Run JavaScript)
 *
 * Determines the risk level of a submitted expense, the resulting approval
 * status, and who needs to be notified. One code step so the routing decision
 * lives in exactly one place — the Paths steps that follow only read the
 * booleans this step outputs.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   amount        → {{Interface Form: Amount}}          e.g. "750", "$750.00"
 *   receiptUrl    → {{Interface Form: Receipt Upload}}  file URL, may be empty
 *   expenseType   → {{Interface Form: Expense Type}}    Travel|Food|Software|Equipment|Other
 *   employeeName  → {{Interface Form: Employee Name}}
 *   managerEmail  → {{Interface Form: Manager Email}}
 *
 * ---------------------------------------------------------------------------
 * Rules (from the task sheet)
 * ---------------------------------------------------------------------------
 *   Low Risk     Amount < $100          → automatically mark "Approved"
 *   Medium Risk  $100 – $500            → send approval request to manager
 *   High Risk    > $500                 → send approval request to manager + finance
 *
 *   Extra requirement: if receipt is missing → Approval Status = "Receipt Required"
 *                      (this overrides the status, but NOT the risk level)
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   riskLevel        String   Low | Medium | High
 *   approvalStatus   String   Approved | Pending Manager Approval |
 *                             Pending Manager + Finance Approval | Receipt Required
 *   hasReceipt       Boolean
 *   notifyManager    Boolean  drives Path B / Path C
 *   notifyFinance    Boolean  drives Path C
 *   autoApproved     Boolean  drives Path A
 *   amountParsed     Number
 *   decisionTrace    String   audit line for Zap History
 */

// --- normalise inputs ------------------------------------------------------
var amountRaw = String(inputData.amount || '');
var amount = parseFloat(amountRaw.replace(/[^0-9.]/g, ''));
if (isNaN(amount)) {
  amount = 0;
}

// A Zapier file-upload field returns an empty string when nothing was attached.
// Some interfaces return the literal "null"/"undefined" — treat those as empty.
var receiptRaw = String(inputData.receiptUrl || '').trim().toLowerCase();
var hasReceipt = receiptRaw !== '' &&
                 receiptRaw !== 'null' &&
                 receiptRaw !== 'undefined' &&
                 receiptRaw !== 'false';

// --- risk banding ----------------------------------------------------------
// Boundaries: < 100 Low, 100–500 Medium, > 500 High.
// $100 and $500 exactly fall into Medium so no amount is unclassified.
var riskLevel;
if (amount < 100) {
  riskLevel = 'Low';
} else if (amount <= 500) {
  riskLevel = 'Medium';
} else {
  riskLevel = 'High';
}

// --- routing ---------------------------------------------------------------
var autoApproved = false;
var notifyManager = false;
var notifyFinance = false;
var approvalStatus;

if (riskLevel === 'Low') {
  autoApproved = true;
  approvalStatus = 'Approved';
} else if (riskLevel === 'Medium') {
  notifyManager = true;
  approvalStatus = 'Pending Manager Approval';
} else {
  notifyManager = true;
  notifyFinance = true;
  approvalStatus = 'Pending Manager + Finance Approval';
}

// --- missing-receipt override ----------------------------------------------
// The receipt rule outranks everything: nothing gets auto-approved and nothing
// goes to an approver until there is a receipt to look at. Risk level is left
// untouched so the table still records how large the claim was.
if (!hasReceipt) {
  approvalStatus = 'Receipt Required';
  autoApproved = false;
  notifyManager = false;
  notifyFinance = false;
}

var decisionTrace =
  'Amount $' + amount.toFixed(2) +
  ' → risk=' + riskLevel +
  ', receipt=' + (hasReceipt ? 'yes' : 'MISSING') +
  ' → status=' + approvalStatus;

output = {
  riskLevel: riskLevel,
  approvalStatus: approvalStatus,
  hasReceipt: hasReceipt,
  notifyManager: notifyManager,
  notifyFinance: notifyFinance,
  autoApproved: autoApproved,
  amountParsed: amount,
  amountFormatted: '$' + amount.toFixed(2),
  expenseType: String(inputData.expenseType || 'Other'),
  employeeName: String(inputData.employeeName || ''),
  managerEmail: String(inputData.managerEmail || ''),
  decisionTrace: decisionTrace
};

/**
 * ---------------------------------------------------------------------------
 * Worked example from the task sheet
 * ---------------------------------------------------------------------------
 *   Software | $750 | No receipt
 *
 *   amount 750  → > 500          → riskLevel = "High"
 *   receipt missing              → approvalStatus = "Receipt Required"
 *                                  notifyManager = false, notifyFinance = false
 *
 *   Result:  Risk: High   Status: Receipt Required     ✓ matches expected result
 *
 * Note that the expected output keeps Risk = High even though the receipt
 * override fired. That is deliberate: risk describes the claim, status
 * describes where it is in the workflow.
 */
