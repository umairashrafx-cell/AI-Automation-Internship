/**
 * Module 06 — Recruitment Pipeline — EXTRA CHALLENGE
 * Step: "Check Stale Candidates"  (Code by Zapier → Run JavaScript)
 *
 * "If a candidate hasn't received an update for 5 days, notify the recruiter."
 *
 * Runs in a daily-scheduled Zap.
 *
 * ---------------------------------------------------------------------------
 * Zap shape
 * ---------------------------------------------------------------------------
 *   1. Schedule by Zapier → Every Day (09:00)
 *   2. Zapier Tables → Find Records (Candidates)
 *      filter to the in-flight stages only:
 *        Stage is any of Applied, Screening, Technical Interview,
 *                        HR Interview, Offer
 *   3. THIS STEP → returns one item per stale candidate
 *   4. Filter → continue only if isStale is true
 *   5. Email by Zapier → the recruiter, one digest per candidate
 *
 * Terminal stages (Hired, Rejected) are excluded at step 2 — a hired candidate
 * has by definition stopped needing updates.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping  (Zapier flattens multiple records into comma-joined strings)
 * ---------------------------------------------------------------------------
 *   candidateIds     → {{Find Records: Candidate ID}}
 *   candidateNames   → {{Find Records: Candidate Name}}
 *   positions        → {{Find Records: Position}}
 *   stages           → {{Find Records: Stage}}
 *   lastUpdatedDates → {{Find Records: Last Update At}}
 *   priorities       → {{Find Records: Priority}}
 *   thresholdDays    → static: 5
 *   recruiterEmail   → static: recruiter@company.com
 *
 * ---------------------------------------------------------------------------
 * output  (array — one object per stale candidate)
 * ---------------------------------------------------------------------------
 */

function splitList(value) {
  var s = String(value || '').trim();
  if (!s) { return []; }
  return s.split(',').map(function (item) { return item.trim(); });
}

var ids = splitList(inputData.candidateIds);
var names = splitList(inputData.candidateNames);
var positions = splitList(inputData.positions);
var stages = splitList(inputData.stages);
var updatedDates = splitList(inputData.lastUpdatedDates);
var priorities = splitList(inputData.priorities);

var thresholdDays = parseInt(inputData.thresholdDays, 10);
if (isNaN(thresholdDays)) { thresholdDays = 5; }

var recruiterEmail = String(inputData.recruiterEmail || 'recruiter@company.com');

var MS_PER_DAY = 24 * 60 * 60 * 1000;
var now = Date.now();
var results = [];

for (var i = 0; i < ids.length; i++) {
  var updated = new Date(updatedDates[i] || '');

  if (isNaN(updated.getTime())) {
    continue;   // undateable row — skip rather than raise a false alarm
  }

  var daysSinceUpdate = Math.floor((now - updated.getTime()) / MS_PER_DAY);

  if (daysSinceUpdate >= thresholdDays) {
    var name = names[i] || '(unknown)';
    var stage = stages[i] || '(unknown stage)';
    var position = positions[i] || '';
    var priority = priorities[i] || '';

    results.push({
      candidateId: ids[i],
      candidateName: name,
      position: position,
      stage: stage,
      priority: priority,
      daysSinceUpdate: daysSinceUpdate,
      isStale: true,
      recipient: recruiterEmail,
      subject: 'No update for ' + daysSinceUpdate + ' days — ' + name +
               ' (' + stage + ')',
      body:
        name + ' has been waiting ' + daysSinceUpdate + ' days without an update.\n\n' +
        'Candidate: ' + name + '\n' +
        'Position:  ' + position + '\n' +
        'Stage:     ' + stage + '\n' +
        'Priority:  ' + priority + '\n' +
        'Ref:       ' + ids[i] + '\n\n' +
        'Candidates should hear something at least every ' + thresholdDays +
        ' days.\nEither move the card or send them a holding note.'
    });
  }
}

// Sort most-neglected first so the recruiter's inbox is usefully ordered.
results.sort(function (a, b) { return b.daysSinceUpdate - a.daysSinceUpdate; });

output = results;

/**
 * ---------------------------------------------------------------------------
 * The "Last Update At" column
 * ---------------------------------------------------------------------------
 * Add a `Last Update At` datetime column to the Candidates table, and have the
 * stage-change Zap write {{zap_meta_human_now}} into it on every move — the
 * same way Module 05 stamps Stage Changed At.
 *
 * "Update" here means anything the candidate would perceive as movement: a
 * stage change, or a manual note. If your recruiters also email candidates
 * outside the board, stamp the column from that Zap too, otherwise the sweep
 * will nag about candidates who were contacted an hour ago.
 */
