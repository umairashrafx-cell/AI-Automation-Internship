/**
 * Module 08 — Instagram Content Agent
 * Step: "Analyze Existing Content"  (Code by Zapier → Run JavaScript)
 *
 * Step 1 of the agent workflow. Reads the recent post history and produces a
 * structured brief the generator can act on — including the hard constraint
 * that implements the task sheet's extra autonomous behaviour:
 *
 *   "If there are already 3 educational posts recently, the agent should
 *    recognise this and choose another content type."
 *
 * Computing this in code rather than trusting the model to count means the
 * constraint actually holds. The model is then told what it may not choose,
 * which is a much easier instruction to follow than "notice a pattern".
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   recentTopics       → {{Find Records (Content Calendar): Topic}}         comma-joined
 *   recentContentTypes → {{Find Records (Content Calendar): Content Type}}  comma-joined
 *   recentDates        → {{Find Records (Content Calendar): Date}}          comma-joined
 *   ideaTopics         → {{Find Records (Content Ideas): Topic}}            comma-joined
 *   ideaContentTypes   → {{Find Records (Content Ideas): Content Type}}     comma-joined
 *   ideaGoals          → {{Find Records (Content Ideas): Goal}}             comma-joined
 *
 * Sort the Content Calendar search by Date DESCENDING and limit it to ~10.
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   recentSummary        String   readable history for the generator prompt
 *   overusedType         String   a content type used 3+ times in the last 3–5 posts
 *   isOverused           Boolean
 *   bannedContentTypes   String   comma-separated — the generator must not pick these
 *   suggestedTypes       String   comma-separated — what it should pick from
 *   coveredTopics        String
 *   uncoveredIdeas       String   ideas from the table not yet posted
 *   agentObservation     String   the sentence the agent should say out loud
 *   postsAnalyzed        Number
 */

function splitList(value) {
  var s = String(value || '').trim();
  if (!s) { return []; }
  return s.split(',').map(function (item) { return item.trim(); }).filter(function (item) { return item !== ''; });
}

var ALL_TYPES = ['Educational', 'Case Study', 'Behind the Scenes', 'Myth Buster',
                 'Quick Tip', 'Story', 'Comparison', 'Question/Poll'];

var topics = splitList(inputData.recentTopics);
var types = splitList(inputData.recentContentTypes);
var dates = splitList(inputData.recentDates);

var ideaTopics = splitList(inputData.ideaTopics);
var ideaTypes = splitList(inputData.ideaContentTypes);
var ideaGoals = splitList(inputData.ideaGoals);

// --- readable history ------------------------------------------------------
var lines = [];
var limit = Math.min(topics.length, 10);
for (var i = 0; i < limit; i++) {
  lines.push((dates[i] || 'undated') + ' — ' + (types[i] || 'Unknown type') +
             ' — ' + (topics[i] || 'untitled'));
}
var recentSummary = lines.length ? lines.join('\n') : 'No previous posts on record.';

// --- content type frequency in the most recent posts -----------------------
// "Recently" = the last 5 posts. Three of the same type inside that window is
// the trigger, which catches both a straight run of three and 3-of-5.
var WINDOW = 5;
var TRIGGER_COUNT = 3;

var counts = {};
var windowSize = Math.min(types.length, WINDOW);
for (var t = 0; t < windowSize; t++) {
  var key = types[t];
  if (!key) { continue; }
  counts[key] = (counts[key] || 0) + 1;
}

var overusedList = [];
for (var type in counts) {
  if (counts[type] >= TRIGGER_COUNT) {
    overusedList.push(type);
  }
}

// Also treat a straight run of 3 identical types at the top as overuse, even
// if the window count would not reach the trigger.
if (types.length >= 3 &&
    types[0] && types[0] === types[1] && types[1] === types[2] &&
    overusedList.indexOf(types[0]) === -1) {
  overusedList.push(types[0]);
}

var isOverused = overusedList.length > 0;
var overusedType = overusedList.length ? overusedList[0] : '';

// --- what the generator may choose from ------------------------------------
var suggested = [];
for (var a = 0; a < ALL_TYPES.length; a++) {
  if (overusedList.indexOf(ALL_TYPES[a]) === -1) {
    suggested.push(ALL_TYPES[a]);
  }
}

// --- unused ideas ----------------------------------------------------------
var coveredLower = topics.map(function (x) { return x.toLowerCase(); });
var uncovered = [];
for (var n = 0; n < ideaTopics.length; n++) {
  if (coveredLower.indexOf(ideaTopics[n].toLowerCase()) === -1) {
    uncovered.push(ideaTopics[n] +
      (ideaTypes[n] ? ' (' + ideaTypes[n] + ')' : '') +
      (ideaGoals[n] ? ' — goal: ' + ideaGoals[n] : ''));
  }
}

// --- the observation the agent states --------------------------------------
var agentObservation;
if (isOverused) {
  agentObservation = 'Too much ' + overusedType.toLowerCase() +
    ' content recently — ' + counts[overusedType] + ' of the last ' +
    windowSize + ' posts. Choosing a different content type.';
} else if (topics.length === 0) {
  agentObservation = 'No post history yet. Starting with a foundational topic.';
} else {
  agentObservation = 'Content type mix over the last ' + windowSize +
    ' posts looks balanced. Choosing based on topic gaps instead.';
}

output = {
  recentSummary: recentSummary,
  overusedType: overusedType,
  isOverused: isOverused,
  bannedContentTypes: overusedList.join(', '),
  suggestedTypes: suggested.join(', '),
  coveredTopics: topics.slice(0, 10).join(', '),
  uncoveredIdeas: uncovered.length ? uncovered.join(' | ') : 'None — all ideas in the table have been used.',
  agentObservation: agentObservation,
  postsAnalyzed: topics.length
};

/**
 * ---------------------------------------------------------------------------
 * The task sheet's example
 * ---------------------------------------------------------------------------
 *   Recent: Educational → Educational → Educational
 *
 *   counts = { Educational: 3 }  → 3 >= TRIGGER_COUNT
 *   isOverused        = true
 *   overusedType      = "Educational"
 *   bannedContentTypes= "Educational"
 *   suggestedTypes    = "Case Study, Behind the Scenes, Myth Buster, Quick Tip,
 *                        Story, Comparison, Question/Poll"
 *   agentObservation  = "Too much educational content recently — 3 of the last
 *                        3 posts. Choosing a different content type."
 *
 *   Agent then chooses: Case Study   ✓ matches the expected behaviour
 */
