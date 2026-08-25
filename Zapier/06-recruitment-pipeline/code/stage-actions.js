/**
 * Module 06 — Recruitment Pipeline
 * Step: "Route Stage Action"  (Code by Zapier → Run JavaScript)
 *
 * Runs in the stage-change Zap. Turns a Kanban move into one decision: who to
 * email, with what subject and body.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   newStage       → {{Trigger: Stage}}
 *   previousStage  → {{Trigger: Previous Stage}}   optional
 *   candidateName  → {{Trigger: Candidate Name}}
 *   email          → {{Trigger: Email}}
 *   position       → {{Trigger: Position}}
 *   candidateId    → {{Trigger: Candidate ID}}
 *   priority       → {{Trigger: Priority}}
 *
 * ---------------------------------------------------------------------------
 * Stage actions required by the task sheet
 * ---------------------------------------------------------------------------
 *   Applied              → Screening              send screening email
 *   Screening            → Technical Interview    send interview scheduling email
 *   Technical Interview  → HR Interview           notify HR
 *   Offer                → Hired                  send congratulations email
 *   Any stage            → Rejected               send rejection email
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   shouldAct   Boolean
 *   audience    String   candidate | internal
 *   recipient   String
 *   subject     String
 *   body        String
 *   actionType  String
 */

var HR_EMAIL = 'hr@company.com';
var RECRUITER_EMAIL = 'recruiter@company.com';
var COMPANY = 'MATalogics';

var newStage = String(inputData.newStage || '').trim();
var previousStage = String(inputData.previousStage || '').trim();
var name = String(inputData.candidateName || 'there');
var email = String(inputData.email || '');
var position = String(inputData.position || 'the role');
var candidateId = String(inputData.candidateId || '');
var priority = String(inputData.priority || '');

var shouldAct = true;
var audience = 'candidate';
var recipient = email;
var subject = '';
var body = '';
var actionType = '';

if (newStage === 'Rejected') {
  // "Any stage → Rejected" — checked FIRST so it wins from wherever the card
  // came from, including straight out of Offer.
  actionType = 'rejection';
  subject = 'Update on your application — ' + position;
  body =
    'Hi ' + name + ',\n\n' +
    'Thank you for taking the time to apply for ' + position + ' at ' +
    COMPANY + ',\nand for the effort you put into your application.\n\n' +
    'After careful consideration we have decided not to move forward on this\n' +
    'occasion. This was a competitive process and the decision was not an easy\n' +
    'one.\n\n' +
    'We will keep your details on file and would welcome an application from\n' +
    'you for future openings.\n\n' +
    'We wish you the very best with your search.\n\n' +
    'Reference: ' + candidateId + '\n' +
    COMPANY + ' Recruitment';

} else if (newStage === 'Screening') {
  actionType = 'screening';
  subject = 'Your application is being reviewed — ' + position;
  body =
    'Hi ' + name + ',\n\n' +
    'Thanks for applying for ' + position + ' at ' + COMPANY + '.\n\n' +
    'Your application has passed our initial checks and is now with our team\n' +
    'for screening. We aim to come back to you within 3 working days.\n\n' +
    'In the meantime, if you have anything else you would like us to see —\n' +
    'a portfolio link, a project, a repository — simply reply to this email.\n\n' +
    'Reference: ' + candidateId + '\n' +
    COMPANY + ' Recruitment';

} else if (newStage === 'Technical Interview') {
  actionType = 'schedule_technical';
  subject = 'Technical interview — ' + position + ' at ' + COMPANY;
  body =
    'Hi ' + name + ',\n\n' +
    'Good news — we would like to invite you to a technical interview for\n' +
    position + '.\n\n' +
    'Format:    60 minutes, video call\n' +
    'Covers:    a walkthrough of your experience, then a practical exercise\n' +
    'Prepare:   be ready to talk through something you have built\n\n' +
    'Please reply with two or three time slots that suit you over the next\n' +
    'week and we will send a calendar invitation.\n\n' +
    'Reference: ' + candidateId + '\n' +
    COMPANY + ' Recruitment';

} else if (newStage === 'HR Interview') {
  // Internal notification — HR needs to know a candidate has reached them.
  actionType = 'notify_hr';
  audience = 'internal';
  recipient = HR_EMAIL;
  subject = 'Candidate ready for HR interview — ' + name + ' (' + position + ')';
  body =
    'A candidate has cleared the technical interview and is ready for HR.\n\n' +
    'Candidate: ' + name + '\n' +
    'Position:  ' + position + '\n' +
    'Priority:  ' + priority + '\n' +
    'Email:     ' + email + '\n' +
    'Ref:       ' + candidateId + '\n\n' +
    'Please schedule the HR interview and update the board.';

} else if (newStage === 'Hired') {
  actionType = 'congratulations';
  subject = 'Congratulations — welcome to ' + COMPANY + '!';
  body =
    'Hi ' + name + ',\n\n' +
    'Congratulations! We are delighted to confirm that you have been hired\n' +
    'as ' + position + ' at ' + COMPANY + '.\n\n' +
    'Our HR team will be in touch shortly with your offer letter, start date,\n' +
    'and onboarding details.\n\n' +
    'Thank you for your patience through the process — we are looking forward\n' +
    'to working with you.\n\n' +
    'Reference: ' + candidateId + '\n' +
    COMPANY + ' Recruitment';

} else {
  // Applied (creation) and Offer have no automatic message in this spec —
  // an offer should be made by a human, not by a Zap.
  shouldAct = false;
  actionType = 'none';
  recipient = '';
}

output = {
  shouldAct: shouldAct,
  actionType: actionType,
  audience: audience,
  recipient: recipient,
  subject: subject,
  body: body,
  newStage: newStage,
  previousStage: previousStage,
  transition: (previousStage || '?') + ' → ' + newStage,
  recruiterEmail: RECRUITER_EMAIL
};
