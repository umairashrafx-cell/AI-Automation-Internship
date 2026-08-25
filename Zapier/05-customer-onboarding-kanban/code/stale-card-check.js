/**
 * Module 05 — Customer Onboarding Pipeline — EXTRA CHALLENGE
 * Step: "Check Stale Cards"  (Code by Zapier → Run JavaScript)
 *
 * "If a card stays in Qualified for more than 3 days, automatically notify the
 *  account manager."
 *
 * Runs in a THIRD Zap on a daily Schedule trigger.
 *
 * ---------------------------------------------------------------------------
 * Zap shape
 * ---------------------------------------------------------------------------
 *   1. Schedule by Zapier → Every Day  (09:00)
 *   2. Zapier Tables → Find Records (Customers)   Stage equals "Qualified"
 *   3. THIS STEP                                   → returns one item per stale card
 *   4. Filter by Zapier                            → only continue if isStale is true
 *   5. Email by Zapier → notify {{accountManagerEmail}}
 *
 * Because step 3 returns an ARRAY, Zapier fans out and runs steps 4–5 once per
 * stale card. Returning an empty array ends the run cleanly with nothing sent.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   customerIds          → {{Find Records: Customer ID}}            comma-joined
 *   companies            → {{Find Records: Company}}                comma-joined
 *   stageChangedDates    → {{Find Records: Stage Changed At}}       comma-joined
 *   accountManagers      → {{Find Records: Account Manager}}        comma-joined
 *   accountManagerEmails → {{Find Records: Account Manager Email}}  comma-joined
 *   thresholdDays        → static: 3
 *
 * Zapier flattens multiple found records into comma-separated strings, which is
 * why everything is split back apart here.
 *
 * ---------------------------------------------------------------------------
 * output  (array — one object per stale card)
 * ---------------------------------------------------------------------------
 *   customerId, company, accountManager, accountManagerEmail,
 *   daysInStage, isStale, subject, body
 */

function splitList(value) {
  var s = String(value || '').trim();
  if (!s) { return []; }
  return s.split(',').map(function (item) { return item.trim(); });
}

var customerIds = splitList(inputData.customerIds);
var companies = splitList(inputData.companies);
var changedDates = splitList(inputData.stageChangedDates);
var managers = splitList(inputData.accountManagers);
var managerEmails = splitList(inputData.accountManagerEmails);

var thresholdDays = parseInt(inputData.thresholdDays, 10);
if (isNaN(thresholdDays)) { thresholdDays = 3; }

var MS_PER_DAY = 24 * 60 * 60 * 1000;
var now = Date.now();

var results = [];

for (var i = 0; i < customerIds.length; i++) {
  var changedRaw = changedDates[i] || '';
  var changed = new Date(changedRaw);

  // Skip rows we cannot date — better to miss a nudge than to email someone
  // that a brand-new card is 19,000 days old.
  if (isNaN(changed.getTime())) {
    continue;
  }

  var daysInStage = Math.floor((now - changed.getTime()) / MS_PER_DAY);

  if (daysInStage > thresholdDays) {
    var company = companies[i] || '(unknown company)';
    var manager = managers[i] || 'there';
    var customerId = customerIds[i];

    results.push({
      customerId: customerId,
      company: company,
      accountManager: manager,
      accountManagerEmail: managerEmails[i] || '',
      daysInStage: daysInStage,
      isStale: true,
      subject: 'Stalled in Qualified for ' + daysInStage + ' days — ' + company,
      body:
        'Hi ' + manager + ',\n\n' +
        company + ' (' + customerId + ') has been sitting in Qualified for ' +
        daysInStage + ' days.\n\n' +
        'Cards in Qualified are expected to move to Proposal within ' +
        thresholdDays + ' days. Either send the proposal, or move the card to\n' +
        'reflect where the deal actually is.\n\n' +
        'Open the onboarding board to update it.'
    });
  }
}

output = results;

/**
 * ---------------------------------------------------------------------------
 * The "Stage Changed At" column
 * ---------------------------------------------------------------------------
 * This check needs to know when the card ENTERED Qualified, not when the record
 * was created. Add a `Stage Changed At` datetime column to the Customers table
 * and have the stage-change Zap (Zap 2) update it on every move:
 *
 *     Zapier Tables → Update Record
 *       Stage Changed At  ←  {{zap_meta_human_now}}
 *
 * Without that column the check silently measures the wrong thing — a deal
 * that has bounced through four stages in a week would look 7 days stale.
 *
 * ---------------------------------------------------------------------------
 * The Delay-by-Zapier alternative
 * ---------------------------------------------------------------------------
 * The task sheet's hint mentions Delay. You can instead put a
 * "Delay For 3 days" step inside the New Lead → Qualified branch, then
 * re-read the record and notify if it is still in Qualified.
 *
 * That is fewer moving parts, but it holds one Zap run open per card for three
 * days, and if you edit the Zap in the meantime the queued runs are dropped.
 * The scheduled sweep above is the version that survives contact with a real
 * team, which is why it is the one implemented here.
 */
