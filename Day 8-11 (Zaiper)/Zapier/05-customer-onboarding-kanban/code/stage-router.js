/**
 * Module 05 — Customer Onboarding Pipeline
 * Step: "Route Stage Change"  (Code by Zapier → Run JavaScript)
 *
 * Runs in the SECOND Zap, the one triggered when a Kanban card moves.
 *
 * Zapier's Paths are limited in number and get unwieldy when every stage needs
 * a different message. This step turns the stage transition into a single
 * decision — which template, to whom, with what subject — so the Zap after it
 * is one Filter plus one send action rather than six parallel branches.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   newStage       → {{Trigger: Stage}}            the stage the card moved INTO
 *   previousStage  → {{Trigger: Previous Stage}}   optional
 *   clientName     → {{Trigger: Client Name}}
 *   company        → {{Trigger: Company}}
 *   email          → {{Trigger: Email}}
 *   accountManager → {{Trigger: Account Manager}}
 *   accountManagerEmail → {{Trigger: Account Manager Email}}
 *   service        → {{Trigger: Service}}
 *   customerId     → {{Trigger: Customer ID}}
 *
 * ---------------------------------------------------------------------------
 * Stage automation required by the task sheet
 * ---------------------------------------------------------------------------
 *   New Lead   → Qualified     send "Lead qualified."
 *   Qualified  → Proposal      create proposal task
 *   Won        → Onboarding    send onboarding email
 *   Onboarding → In Progress   notify project manager
 *   In Progress→ Completed     send completion email to customer
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   shouldAct     Boolean  false when this transition has no automation
 *   actionType    String   notify_internal | create_task | email_customer | notify_pm
 *   recipient     String   email address to send to
 *   subject       String
 *   body          String
 *   createTask    Boolean  true only for Qualified → Proposal
 *   taskTitle     String
 *   taskDueDate   String   "YYYY-MM-DD"
 */

var STAGES = ['New Lead', 'Qualified', 'Proposal', 'Won', 'Onboarding', 'In Progress', 'Completed'];

var newStage = String(inputData.newStage || '').trim();
var previousStage = String(inputData.previousStage || '').trim();

var clientName = String(inputData.clientName || 'there');
var company = String(inputData.company || '');
var email = String(inputData.email || '');
var manager = String(inputData.accountManager || 'the account manager');
var managerEmail = String(inputData.accountManagerEmail || '');
var service = String(inputData.service || 'your project');
var customerId = String(inputData.customerId || '');

var PM_EMAIL = 'pm@company.com';   // change to your project manager

function isoInDays(days) {
  var d = new Date();
  d.setDate(d.getDate() + days);
  var m = String(d.getMonth() + 1);
  var dd = String(d.getDate());
  if (m.length < 2) { m = '0' + m; }
  if (dd.length < 2) { dd = '0' + dd; }
  return d.getFullYear() + '-' + m + '-' + dd;
}

var shouldAct = true;
var actionType = '';
var recipient = '';
var subject = '';
var body = '';
var createTask = false;
var taskTitle = '';
var taskDueDate = '';

if (newStage === 'Qualified') {
  actionType = 'notify_internal';
  recipient = managerEmail;
  subject = 'Lead qualified — ' + company + ' (' + customerId + ')';
  body =
    'Lead qualified.\n\n' +
    'Client:   ' + clientName + '\n' +
    'Company:  ' + company + '\n' +
    'Service:  ' + service + '\n' +
    'Owner:    ' + manager + '\n\n' +
    'Next step: prepare and send a proposal.';

} else if (newStage === 'Proposal') {
  actionType = 'create_task';
  createTask = true;
  taskTitle = 'Prepare proposal — ' + company + ' (' + customerId + ')';
  taskDueDate = isoInDays(3);
  recipient = managerEmail;
  subject = 'Proposal task created — ' + company;
  body =
    'A proposal task has been created.\n\n' +
    'Task:     ' + taskTitle + '\n' +
    'Owner:    ' + manager + '\n' +
    'Due:      ' + taskDueDate + '\n' +
    'Service:  ' + service;

} else if (newStage === 'Onboarding') {
  actionType = 'email_customer';
  recipient = email;
  subject = 'Welcome aboard, ' + company + ' — let us get started';
  body =
    'Hi ' + clientName + ',\n\n' +
    'Great news — we are ready to begin ' + service + '.\n\n' +
    'Your account manager is ' + manager + ', who will be your main point of\n' +
    'contact from here on. Over the next few days we will:\n\n' +
    '  1. Send you a short onboarding questionnaire\n' +
    '  2. Book a kickoff call\n' +
    '  3. Set up your shared workspace\n\n' +
    'Reference: ' + customerId + '\n\n' +
    'Welcome aboard.\n' + manager;

} else if (newStage === 'In Progress') {
  actionType = 'notify_pm';
  recipient = PM_EMAIL;
  subject = 'Project starting — ' + company + ' (' + customerId + ')';
  body =
    'A project has moved into In Progress and needs a delivery plan.\n\n' +
    'Client:   ' + clientName + '\n' +
    'Company:  ' + company + '\n' +
    'Service:  ' + service + '\n' +
    'AM:       ' + manager + '\n' +
    'Ref:      ' + customerId;

} else if (newStage === 'Completed') {
  actionType = 'email_customer';
  recipient = email;
  subject = 'Your project is complete — ' + company;
  body =
    'Hi ' + clientName + ',\n\n' +
    'We have completed ' + service + '. Thank you for working with us.\n\n' +
    'You will find all deliverables in your shared workspace. If anything\n' +
    'needs adjusting, reply to this email and ' + manager + ' will pick it up.\n\n' +
    'If you have a moment, we would appreciate your feedback.\n\n' +
    'Reference: ' + customerId + '\n\n' +
    'Thanks again,\n' + manager;

} else {
  // New Lead (card creation, handled by the first Zap) and Won have no
  // outbound action of their own in this spec.
  shouldAct = false;
  actionType = 'none';
}

output = {
  shouldAct: shouldAct,
  actionType: actionType,
  recipient: recipient,
  subject: subject,
  body: body,
  createTask: createTask,
  taskTitle: taskTitle,
  taskDueDate: taskDueDate,
  newStage: newStage,
  previousStage: previousStage,
  transition: (previousStage || '?') + ' → ' + newStage,
  stageIndex: STAGES.indexOf(newStage)
};

/**
 * ---------------------------------------------------------------------------
 * Why route in code rather than with six Paths
 * ---------------------------------------------------------------------------
 * Paths are the right tool when each branch does something structurally
 * different (Module 02 sends to different people via different apps). Here
 * every branch does the same thing — send one email — and only the content
 * differs. Routing in code keeps the Zap at three steps and puts all five
 * message templates in one reviewable file.
 *
 * Use Paths instead if your branches need genuinely different apps: e.g.
 * Slack for internal notifications and Gmail for customer email. In that case
 * keep this step and use `actionType` as the single Path condition.
 */
