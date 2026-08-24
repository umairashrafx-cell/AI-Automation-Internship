/**
 * Module 06 — Recruitment Pipeline
 * Step: "Analyze Candidate"  (Code by Zapier → Run JavaScript)
 *
 * Runs when an application arrives. Creates the candidate ID, parses years of
 * experience out of whatever the applicant typed, assigns priority, and sets
 * the opening Kanban stage.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   candidateName   → {{Form: Candidate Name}}
 *   email           → {{Form: Email}}
 *   phone           → {{Form: Phone}}
 *   position        → {{Form: Position}}
 *   experience      → {{Form: Experience}}        "5", "5 years", "5+", "3-4 years"
 *   expectedSalary  → {{Form: Expected Salary}}
 *   resume          → {{Form: Resume}}            file URL
 *   portfolio       → {{Form: Portfolio}}         URL, optional
 *   availability    → {{Form: Availability}}      "Immediate" | "2 weeks" | "1 month" | ...
 *   lastCandidateId → {{Find Record: Candidate ID}}  optional
 *
 * ---------------------------------------------------------------------------
 * Priority rules (from the task sheet)
 * ---------------------------------------------------------------------------
 *   5+ years  → High
 *   2–4 years → Medium
 *   <2 years  → Low
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   candidateId     String   "CAND-0087"
 *   yearsExperience Number
 *   priority        String   High | Medium | Low
 *   stage           String   always "Applied"
 *   hasPortfolio    Boolean
 *   hasResume       Boolean
 *   isHighPriority  Boolean
 *   analysisNote    String   audit line
 */

// --- parse years of experience ---------------------------------------------
// Applicants type "5", "5 years", "5+", "about 3", "3-4 years", "0.5".
// Take the FIRST number found; for a range like "3-4" that means the lower
// bound, which is the conservative read for a hiring decision.
var experienceRaw = String(inputData.experience || '');
var match = experienceRaw.match(/(\d+(?:\.\d+)?)/);
var yearsExperience = match ? parseFloat(match[1]) : 0;

if (isNaN(yearsExperience) || yearsExperience < 0) {
  yearsExperience = 0;
}

// "Fresher", "fresh graduate", "no experience" all mean 0.
var lowerExp = experienceRaw.toLowerCase();
if (lowerExp.indexOf('fresh') !== -1 ||
    lowerExp.indexOf('no experience') !== -1 ||
    lowerExp.indexOf('none') !== -1) {
  yearsExperience = 0;
}

// --- priority --------------------------------------------------------------
var priority;
if (yearsExperience >= 5) {
  priority = 'High';
} else if (yearsExperience >= 2) {
  priority = 'Medium';
} else {
  priority = 'Low';
}

// --- candidate ID ----------------------------------------------------------
var sequence = 1;
var lastId = String(inputData.lastCandidateId || '').trim();
if (lastId) {
  var lastSeq = parseInt(lastId.split('-').pop(), 10);
  if (!isNaN(lastSeq)) { sequence = lastSeq + 1; }
}
var padded = String(sequence);
while (padded.length < 4) { padded = '0' + padded; }

// --- attachments -----------------------------------------------------------
function isPresent(value) {
  var v = String(value || '').trim().toLowerCase();
  return v !== '' && v !== 'null' && v !== 'undefined' && v !== 'n/a' && v !== 'none';
}

var hasResume = isPresent(inputData.resume);
var hasPortfolio = isPresent(inputData.portfolio);

// --- salary ----------------------------------------------------------------
var salaryRaw = String(inputData.expectedSalary || '');
var salary = parseFloat(salaryRaw.replace(/[^0-9.]/g, ''));
if (isNaN(salary)) { salary = 0; }

var analysisNote =
  'Experience "' + experienceRaw + '" → ' + yearsExperience + ' yrs → ' + priority +
  ' priority. Resume: ' + (hasResume ? 'yes' : 'MISSING') +
  '. Portfolio: ' + (hasPortfolio ? 'yes' : 'none') + '.';

output = {
  candidateId: 'CAND-' + padded,
  candidateName: String(inputData.candidateName || ''),
  email: String(inputData.email || ''),
  phone: String(inputData.phone || ''),
  position: String(inputData.position || ''),
  yearsExperience: yearsExperience,
  experienceRaw: experienceRaw,
  expectedSalary: salary,
  expectedSalaryFormatted: salary ? '$' + salary.toLocaleString('en-US') : 'Not stated',
  resume: String(inputData.resume || ''),
  portfolio: String(inputData.portfolio || ''),
  availability: String(inputData.availability || ''),
  priority: priority,
  isHighPriority: priority === 'High',
  hasResume: hasResume,
  hasPortfolio: hasPortfolio,
  stage: 'Applied',
  analysisNote: analysisNote,
  appliedAt: new Date().toISOString(),
  cardTitle: String(inputData.candidateName || 'Candidate') + ' — ' +
             String(inputData.position || '') + ' (' + yearsExperience + 'y)'
};

/**
 * ---------------------------------------------------------------------------
 * Note on "Analyze experience"
 * ---------------------------------------------------------------------------
 * The task sheet's step 3 is "Analyze experience". This step does the numeric
 * part deterministically, which is what the priority rules actually need.
 *
 * If you want a genuine résumé read, add an AI by Zapier step before this one
 * that extracts years of experience and key skills from the resume file, and
 * map its output into `experience` here. Keep this step either way — it is the
 * guardrail that turns any model output back into one of the three valid
 * priority bands, so a hallucinated "senior-ish" never reaches the table.
 */
