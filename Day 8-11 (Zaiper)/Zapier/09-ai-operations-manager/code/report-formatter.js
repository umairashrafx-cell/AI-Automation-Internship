/**
 * Module 09 — AI Operations Manager
 * Step: "Format Report"  (Code by Zapier → Run JavaScript)
 *
 * Assembles the Daily Operations Report from the agent's reasoning, the safe
 * action guard's verdicts, and the computed metrics. Produces both a plain-text
 * version (Slack, plain email) and an HTML version (rich email).
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   agentReport       → {{Reasoning AI: output}}   the HIGH PRIORITY /
 *                                                  RECOMMENDED ACTIONS text
 *   approvedActions   → {{Guard: approvedActions}}
 *   blockedActions    → {{Guard: blockedActions}}
 *   approvedCount     → {{Guard: approvedCount}}
 *   blockedCount      → {{Guard: blockedCount}}
 *   reportDate        → {{Analyze: reportDate}}
 *   pipelineValueFormatted → {{Analyze: pipelineValueFormatted}}
 *   staleDealCount    → {{Analyze: staleDealCount}}
 *   overdueTaskCount  → {{Analyze: overdueTaskCount}}
 *   unresolvedCriticalCount → {{Analyze: unresolvedCriticalCount}}
 *   compoundRiskCount → {{Analyze: compoundRiskCount}}
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   subject       String
 *   plainText     String   for Slack / plain email
 *   html          String   for rich email
 *   headline      String   one-line summary
 */

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

var reportDate = String(inputData.reportDate || new Date().toISOString().substring(0, 10));
var agentReport = String(inputData.agentReport || '').trim();

var approvedActions = String(inputData.approvedActions || 'None.').trim();
var blockedActions = String(inputData.blockedActions || 'None.').trim();
var approvedCount = parseInt(inputData.approvedCount, 10) || 0;
var blockedCount = parseInt(inputData.blockedCount, 10) || 0;

var pipeline = String(inputData.pipelineValueFormatted || '$0');
var staleDeals = parseInt(inputData.staleDealCount, 10) || 0;
var overdueTasks = parseInt(inputData.overdueTaskCount, 10) || 0;
var criticalTickets = parseInt(inputData.unresolvedCriticalCount, 10) || 0;
var compoundRisk = parseInt(inputData.compoundRiskCount, 10) || 0;

// --- headline --------------------------------------------------------------
var issueTotal = staleDeals + overdueTasks + criticalTickets;
var headline;

if (compoundRisk > 0) {
  headline = compoundRisk + ' customer' + (compoundRisk > 1 ? 's' : '') +
             ' with problems in more than one place — start there.';
} else if (criticalTickets > 0) {
  headline = criticalTickets + ' unresolved critical ticket' +
             (criticalTickets > 1 ? 's' : '') + '.';
} else if (staleDeals > 0) {
  headline = staleDeals + ' deal' + (staleDeals > 1 ? 's' : '') + ' losing momentum.';
} else if (overdueTasks > 0) {
  headline = overdueTasks + ' overdue task' + (overdueTasks > 1 ? 's' : '') + '.';
} else {
  headline = 'Nothing requiring attention.';
}

var subject = 'Daily Ops — ' + reportDate + ' — ' + headline;

// --- metrics strip ---------------------------------------------------------
var metrics = pipeline + ' open pipeline · ' +
              staleDeals + ' stale deal' + (staleDeals === 1 ? '' : 's') + ' · ' +
              overdueTasks + ' overdue task' + (overdueTasks === 1 ? '' : 's') + ' · ' +
              criticalTickets + ' critical ticket' + (criticalTickets === 1 ? '' : 's');

// --- plain text ------------------------------------------------------------
var lines = [];
lines.push('DAILY OPERATIONS REPORT — ' + reportDate);
lines.push('');
lines.push(agentReport || '(the reasoning step returned nothing)');
lines.push('');
lines.push('─────────────────────────────────────────────');
lines.push('ACTIONS TAKEN (' + approvedCount + ')');
lines.push(approvedActions);
lines.push('');
lines.push('BLOCKED / FOR A HUMAN (' + blockedCount + ')');
lines.push(blockedActions);
lines.push('');
lines.push('─────────────────────────────────────────────');
lines.push(metrics);
lines.push('');
lines.push('No external messages were sent and no records were deleted or');
lines.push('financially altered. The agent may only create and reassign');
lines.push('internal tasks, flag records, and add notes.');

var plainText = lines.join('\n');

// --- html ------------------------------------------------------------------
var html =
  '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'max-width:680px;margin:0 auto;color:#1a1a1a;line-height:1.55">' +
    '<h2 style="margin:0 0 4px;font-size:20px">Daily Operations Report</h2>' +
    '<div style="color:#666;font-size:13px;margin-bottom:20px">' + esc(reportDate) +
      ' &middot; ' + esc(headline) + '</div>' +

    '<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;' +
    'background:#f7f7f8;border-left:3px solid #d0d0d5;padding:14px 16px;' +
    'margin:0 0 20px;border-radius:4px">' + esc(agentReport) + '</pre>' +

    '<h3 style="font-size:14px;margin:0 0 6px;text-transform:uppercase;' +
    'letter-spacing:.05em;color:#444">Actions taken (' + approvedCount + ')</h3>' +
    '<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;' +
    'margin:0 0 18px;color:#1a1a1a">' + esc(approvedActions) + '</pre>' +

    '<h3 style="font-size:14px;margin:0 0 6px;text-transform:uppercase;' +
    'letter-spacing:.05em;color:#444">Blocked / for a human (' + blockedCount + ')</h3>' +
    '<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;' +
    'margin:0 0 18px;color:#8a4b00">' + esc(blockedActions) + '</pre>' +

    '<div style="border-top:1px solid #e3e3e6;padding-top:12px;font-size:13px;' +
    'color:#666">' + esc(metrics) + '</div>' +

    '<div style="margin-top:14px;font-size:12px;color:#888">' +
      'No external messages were sent and no records were deleted or financially ' +
      'altered. The agent may only create and reassign internal tasks, flag ' +
      'records, and add notes.' +
    '</div>' +
  '</div>';

output = {
  subject: subject,
  headline: headline,
  plainText: plainText,
  html: html,
  metrics: metrics,
  issueTotal: issueTotal
};

/**
 * ---------------------------------------------------------------------------
 * The footer is not decoration
 * ---------------------------------------------------------------------------
 * Every report states what the agent is not permitted to do. An operator
 * reading a report generated by something autonomous needs to know the bounds
 * without going to look them up — and if the footer ever disappears from a
 * report, that is a signal the guard step was removed.
 */
