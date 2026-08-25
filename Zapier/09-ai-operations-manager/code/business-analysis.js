/**
 * Module 09 — AI Operations Manager
 * Step: "Analyze Business"  (Code by Zapier → Run JavaScript)
 *
 * Reads the three tables and computes every fact the agent needs: stale deals,
 * overdue tasks, overloaded owners, breached tickets, and — the useful bit —
 * customers that appear as a problem in more than one table at once.
 *
 * The arithmetic is done here so the model never has to count. Models are good
 * at judgement and bad at "how many days is 2026-08-19 from today", and an ops
 * report built on miscounted days is worse than no report.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping (Zapier flattens found records into comma-joined strings)
 * ---------------------------------------------------------------------------
 *   SALES
 *     salesCustomers, salesDeals, salesAmounts, salesStages, salesOwners,
 *     salesLastActivity
 *   TASKS
 *     taskNames, taskOwners, taskDeadlines, taskStatuses
 *   SUPPORT
 *     supportCustomers, supportIssues, supportPriorities, supportStatuses,
 *     supportCreatedAt
 *   THRESHOLDS (static)
 *     staleDealDays        default 5
 *     highValueAmount      default 10000
 *     taskOverloadCount    default 5
 *     criticalTicketHours  default 24
 *
 * ---------------------------------------------------------------------------
 * output — a structured brief, plus `analysisText` to paste into the AI step
 * ---------------------------------------------------------------------------
 */

function splitList(value) {
  var s = String(value || '').trim();
  if (!s) { return []; }
  return s.split(',').map(function (x) { return x.trim(); });
}

function num(value) {
  var n = parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function daysSince(dateStr) {
  var d = new Date(String(dateStr || ''));
  if (isNaN(d.getTime())) { return null; }
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
}

function daysUntil(dateStr) {
  var d = new Date(String(dateStr || ''));
  if (isNaN(d.getTime())) { return null; }
  return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function money(n) {
  return '$' + n.toLocaleString('en-US');
}

// --- thresholds ------------------------------------------------------------
var STALE_DAYS = parseInt(inputData.staleDealDays, 10);
if (isNaN(STALE_DAYS)) { STALE_DAYS = 5; }

var HIGH_VALUE = num(inputData.highValueAmount) || 10000;

var OVERLOAD = parseInt(inputData.taskOverloadCount, 10);
if (isNaN(OVERLOAD)) { OVERLOAD = 5; }

var CRITICAL_HOURS = parseInt(inputData.criticalTicketHours, 10);
if (isNaN(CRITICAL_HOURS)) { CRITICAL_HOURS = 24; }

// ===========================================================================
// SALES
// ===========================================================================
var sCustomers = splitList(inputData.salesCustomers);
var sDeals = splitList(inputData.salesDeals);
var sAmounts = splitList(inputData.salesAmounts);
var sStages = splitList(inputData.salesStages);
var sOwners = splitList(inputData.salesOwners);
var sActivity = splitList(inputData.salesLastActivity);

var CLOSED_STAGES = ['closed won', 'closed lost', 'won', 'lost'];

var staleDeals = [];
var highValueAtRisk = [];
var pipelineValue = 0;

for (var i = 0; i < sCustomers.length; i++) {
  var stage = String(sStages[i] || '').toLowerCase();
  if (CLOSED_STAGES.indexOf(stage) !== -1) { continue; }

  var amount = num(sAmounts[i]);
  pipelineValue += amount;

  var idle = daysSince(sActivity[i]);
  if (idle === null) { continue; }

  if (idle >= STALE_DAYS) {
    var entry = {
      customer: sCustomers[i],
      deal: sDeals[i] || '',
      amount: amount,
      amountFormatted: money(amount),
      stage: sStages[i] || '',
      owner: sOwners[i] || 'unassigned',
      daysIdle: idle,
      isHighValue: amount >= HIGH_VALUE
    };
    staleDeals.push(entry);
    if (entry.isHighValue) {
      highValueAtRisk.push(entry);
    }
  }
}

// Most valuable stale deal first — that is the ordering an ops lead wants.
staleDeals.sort(function (a, b) { return b.amount - a.amount; });
highValueAtRisk.sort(function (a, b) { return b.amount - a.amount; });

// ===========================================================================
// TASKS
// ===========================================================================
var tNames = splitList(inputData.taskNames);
var tOwners = splitList(inputData.taskOwners);
var tDeadlines = splitList(inputData.taskDeadlines);
var tStatuses = splitList(inputData.taskStatuses);

var DONE_STATUSES = ['done', 'complete', 'completed', 'closed', 'cancelled'];

var overdueTasks = [];
var openByOwner = {};
var overdueByOwner = {};

for (var t = 0; t < tNames.length; t++) {
  var status = String(tStatuses[t] || '').toLowerCase();
  if (DONE_STATUSES.indexOf(status) !== -1) { continue; }

  var owner = tOwners[t] || 'unassigned';
  openByOwner[owner] = (openByOwner[owner] || 0) + 1;

  var due = daysUntil(tDeadlines[t]);
  if (due !== null && due < 0) {
    overdueTasks.push({
      task: tNames[t],
      owner: owner,
      deadline: tDeadlines[t],
      daysOverdue: Math.abs(due)
    });
    overdueByOwner[owner] = (overdueByOwner[owner] || 0) + 1;
  }
}

overdueTasks.sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });

var overloadedOwners = [];
for (var o in openByOwner) {
  if (openByOwner[o] >= OVERLOAD) {
    overloadedOwners.push({
      owner: o,
      openTasks: openByOwner[o],
      overdueTasks: overdueByOwner[o] || 0
    });
  }
}
overloadedOwners.sort(function (a, b) { return b.overdueTasks - a.overdueTasks; });

// Who has capacity — needed for a useful reassignment recommendation.
var lightestOwner = '';
var lightestCount = null;
for (var o2 in openByOwner) {
  if (lightestCount === null || openByOwner[o2] < lightestCount) {
    lightestCount = openByOwner[o2];
    lightestOwner = o2;
  }
}

// ===========================================================================
// SUPPORT
// ===========================================================================
var suCustomers = splitList(inputData.supportCustomers);
var suIssues = splitList(inputData.supportIssues);
var suPriorities = splitList(inputData.supportPriorities);
var suStatuses = splitList(inputData.supportStatuses);
var suCreated = splitList(inputData.supportCreatedAt);

var RESOLVED_STATUSES = ['resolved', 'closed'];

var unresolvedCritical = [];
var breachedTickets = [];
var openTicketCustomers = {};

for (var k = 0; k < suCustomers.length; k++) {
  var st = String(suStatuses[k] || '').toLowerCase();
  if (RESOLVED_STATUSES.indexOf(st) !== -1) { continue; }

  var priority = String(suPriorities[k] || '').trim();
  var ageDays = daysSince(suCreated[k]);
  var ageHours = ageDays === null ? null : ageDays * 24;

  var ticket = {
    customer: suCustomers[k],
    issue: suIssues[k] || '',
    priority: priority,
    status: suStatuses[k] || '',
    ageDays: ageDays === null ? 0 : ageDays
  };

  openTicketCustomers[suCustomers[k]] = ticket;

  if (priority.toLowerCase() === 'critical') {
    unresolvedCritical.push(ticket);
    if (ageHours !== null && ageHours > CRITICAL_HOURS) {
      breachedTickets.push(ticket);
    }
  }
}

unresolvedCritical.sort(function (a, b) { return b.ageDays - a.ageDays; });

// ===========================================================================
// CROSS-TABLE: customers in trouble in more than one place
// ===========================================================================
var compoundRisk = [];
for (var c = 0; c < staleDeals.length; c++) {
  var cust = staleDeals[c].customer;
  if (openTicketCustomers[cust]) {
    compoundRisk.push({
      customer: cust,
      dealAmount: staleDeals[c].amountFormatted,
      dealStage: staleDeals[c].stage,
      daysIdle: staleDeals[c].daysIdle,
      ticketPriority: openTicketCustomers[cust].priority,
      ticketIssue: openTicketCustomers[cust].issue,
      ticketAgeDays: openTicketCustomers[cust].ageDays
    });
  }
}

// ===========================================================================
// Readable brief for the AI step
// ===========================================================================
var lines = [];

lines.push('SALES');
lines.push('  Open pipeline: ' + money(pipelineValue));
lines.push('  Stale deals (no activity ' + STALE_DAYS + '+ days): ' + staleDeals.length);
for (var a = 0; a < staleDeals.length; a++) {
  var sd = staleDeals[a];
  lines.push('    - ' + sd.customer + ' | ' + sd.amountFormatted + ' | ' + sd.stage +
             ' | owner ' + sd.owner + ' | idle ' + sd.daysIdle + ' days' +
             (sd.isHighValue ? ' | HIGH VALUE' : ''));
}

lines.push('');
lines.push('TASKS');
lines.push('  Overdue: ' + overdueTasks.length);
for (var b = 0; b < overdueTasks.length; b++) {
  lines.push('    - ' + overdueTasks[b].task + ' | ' + overdueTasks[b].owner +
             ' | ' + overdueTasks[b].daysOverdue + ' days overdue');
}
lines.push('  Overloaded owners (' + OVERLOAD + '+ open):');
if (overloadedOwners.length === 0) {
  lines.push('    - none');
} else {
  for (var e = 0; e < overloadedOwners.length; e++) {
    lines.push('    - ' + overloadedOwners[e].owner + ': ' +
               overloadedOwners[e].openTasks + ' open, ' +
               overloadedOwners[e].overdueTasks + ' overdue');
  }
}
if (lightestOwner) {
  lines.push('  Most capacity: ' + lightestOwner + ' (' + lightestCount + ' open)');
}

lines.push('');
lines.push('SUPPORT');
lines.push('  Unresolved critical tickets: ' + unresolvedCritical.length);
for (var f = 0; f < unresolvedCritical.length; f++) {
  lines.push('    - ' + unresolvedCritical[f].customer + ' | ' +
             unresolvedCritical[f].issue + ' | ' +
             unresolvedCritical[f].ageDays + ' days old | ' +
             unresolvedCritical[f].status);
}
lines.push('  Breached (' + CRITICAL_HOURS + 'h SLA): ' + breachedTickets.length);

if (compoundRisk.length) {
  lines.push('');
  lines.push('COMPOUND RISK — same customer, problems in two tables');
  for (var g = 0; g < compoundRisk.length; g++) {
    var cr = compoundRisk[g];
    lines.push('    - ' + cr.customer + ': ' + cr.dealAmount + ' deal idle ' +
               cr.daysIdle + ' days AND ' + cr.ticketPriority +
               ' ticket open ' + cr.ticketAgeDays + ' days');
  }
}

var needsAttention = staleDeals.length > 0 ||
                     overdueTasks.length > 0 ||
                     unresolvedCritical.length > 0 ||
                     overloadedOwners.length > 0;

output = {
  analysisText: lines.join('\n'),
  needsAttention: needsAttention,

  staleDealCount: staleDeals.length,
  staleDeals: staleDeals,
  highValueAtRiskCount: highValueAtRisk.length,
  topStaleDeal: staleDeals.length ? staleDeals[0] : null,
  pipelineValue: pipelineValue,
  pipelineValueFormatted: money(pipelineValue),

  overdueTaskCount: overdueTasks.length,
  overdueTasks: overdueTasks,
  overloadedOwners: overloadedOwners,
  mostOverloadedOwner: overloadedOwners.length ? overloadedOwners[0].owner : '',
  lightestOwner: lightestOwner,

  unresolvedCriticalCount: unresolvedCritical.length,
  unresolvedCritical: unresolvedCritical,
  breachedTicketCount: breachedTickets.length,

  compoundRiskCount: compoundRisk.length,
  compoundRisk: compoundRisk,

  // Drives the safe auto-action: create a follow-up task for the worst stale deal
  shouldCreateFollowUp: staleDeals.length > 0,
  followUpTaskTitle: staleDeals.length
    ? 'Follow up — ' + staleDeals[0].customer + ' (' + staleDeals[0].amountFormatted + ')'
    : '',
  followUpOwner: staleDeals.length ? staleDeals[0].owner : '',

  reportDate: new Date().toISOString().substring(0, 10)
};
