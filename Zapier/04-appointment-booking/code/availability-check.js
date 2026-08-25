/**
 * Module 04 — AI Appointment Booking Assistant
 * Step: "Check Availability"  (Code by Zapier → Run JavaScript)
 *
 * Decides whether the requested slot is free, and — this is the extra challenge
 * in the task sheet — prevents double booking.
 *
 * ---------------------------------------------------------------------------
 * Place this AFTER a search step
 * ---------------------------------------------------------------------------
 *     Zapier Tables → Find Record(s)  (Appointments)
 *       Doctor  equals  {{Parse: doctor}}
 *       Date    equals  {{Parse: date}}
 *       Time    equals  {{Parse: time}}
 *       "Create if not found" → OFF
 *
 * Zapier's Find Record returns the matched record's fields (empty when nothing
 * matched), so the presence of an Appointment ID is the signal that the slot
 * is taken.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   existingAppointmentId → {{Find Record: Appointment ID}}  empty when free
 *   existingStatus        → {{Find Record: Status}}          optional
 *   doctor                → {{Parse: doctor}}
 *   date                  → {{Parse: date}}
 *   time                  → {{Parse: time}}
 *   displayDate           → {{Parse: displayDate}}
 *   displayTime           → {{Parse: displayTime}}
 *   alternatives          → {{Parse: alternatives}}
 *   isValid               → {{Parse: isValid}}
 *   validationError       → {{Parse: validationError}}
 *   lastAppointmentId     → {{Find Last Appointment: Appointment ID}}
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   isAvailable        Boolean  true only when the slot is bookable
 *   canBook            Boolean  isValid AND isAvailable — the Path condition
 *   appointmentId      String   next ID, e.g. "APT-0058" (only meaningful if canBook)
 *   botMessage         String   exact sentence for the chatbot to say back
 *   reason             String   free | taken | invalid
 */

// A cancelled appointment does not block the slot — it should be re-bookable.
var CANCELLED_STATUSES = ['cancelled', 'canceled', 'no show', 'no-show'];

var existingId = String(inputData.existingAppointmentId || '').trim();
var existingStatus = String(inputData.existingStatus || '').trim().toLowerCase();

var slotOccupied = existingId !== '';
if (slotOccupied && CANCELLED_STATUSES.indexOf(existingStatus) !== -1) {
  slotOccupied = false;
}

// isValid arrives from Zapier as a string "true"/"false", not a real boolean.
var isValid = String(inputData.isValid) === 'true' || inputData.isValid === true;

var isAvailable = !slotOccupied;
var canBook = isValid && isAvailable;

// --- next appointment ID ---------------------------------------------------
var sequence = 1;
var lastId = String(inputData.lastAppointmentId || '').trim();
if (lastId) {
  var lastSeq = parseInt(lastId.split('-').pop(), 10);
  if (!isNaN(lastSeq)) {
    sequence = lastSeq + 1;
  }
}
var padded = String(sequence);
while (padded.length < 4) {
  padded = '0' + padded;
}
var appointmentId = 'APT-' + padded;

// --- the message the bot says back -----------------------------------------
var reason;
var botMessage;

var doctor = String(inputData.doctor || 'the doctor');
var displayDate = String(inputData.displayDate || '');
var displayTime = String(inputData.displayTime || '');
var alternatives = String(inputData.alternatives || '').trim();

if (!isValid) {
  reason = 'invalid';
  botMessage = String(inputData.validationError || 'That request could not be processed.');
} else if (slotOccupied) {
  reason = 'taken';
  // Exact wording required by the task sheet, with real alternatives filled in.
  if (alternatives) {
    var parts = alternatives.split(',');
    if (parts.length >= 2) {
      botMessage = 'That slot is unavailable. Would you like ' +
                   parts[0].trim() + ' or ' + parts[1].trim() + ' instead?';
    } else {
      botMessage = 'That slot is unavailable. Would you like ' +
                   parts[0].trim() + ' instead?';
    }
  } else {
    botMessage = 'That slot is unavailable. Would you like a different time?';
  }
} else {
  reason = 'free';
  botMessage = doctor + ' is free on ' + displayDate + ' at ' + displayTime +
               '. Shall I book it?';
}

output = {
  isAvailable: isAvailable,
  canBook: canBook,
  appointmentId: appointmentId,
  reason: reason,
  botMessage: botMessage,
  doctor: doctor,
  date: String(inputData.date || ''),
  time: String(inputData.time || ''),
  displayDate: displayDate,
  displayTime: displayTime,
  alternatives: alternatives,
  createdAt: new Date().toISOString()
};

/**
 * ---------------------------------------------------------------------------
 * Extra challenge: preventing double booking
 * ---------------------------------------------------------------------------
 * Three layers, and you want all three:
 *
 * 1. This check. The Find Record step + `canBook` gate means the Create Record
 *    action sits behind a Path that only runs when the slot is genuinely free.
 *
 * 2. The system prompt. The bot is explicitly forbidden from saying "booked"
 *    before the tool has run. Without this, a model will happily confirm a
 *    booking it never made.
 *
 * 3. A uniqueness guard on the table. Add a `Slot Key` text column populated
 *    with {{Parse: slotKey}} ("Dr. Sara|2026-08-25|16:00"). Search on that one
 *    column instead of three — a single exact-match lookup can't be defeated
 *    by "16:00" vs "4:00 PM" formatting drift, which is the realistic way this
 *    check fails in practice.
 *
 * A fourth layer for a production build would be an idempotency check: search
 * for an appointment with the same phone + date + time before creating, so a
 * patient who taps "confirm" twice doesn't get two records.
 */
