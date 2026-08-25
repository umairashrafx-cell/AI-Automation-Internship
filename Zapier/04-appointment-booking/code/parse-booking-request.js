/**
 * Module 04 — AI Appointment Booking Assistant
 * Step: "Parse Booking Request"  (Code by Zapier → Run JavaScript)
 *
 * Normalises whatever the chatbot extracted into clean, comparable values, and
 * validates the request against clinic rules before anything touches the table.
 *
 * The chatbot does the *language* work ("tomorrow", "the skin doctor"); this
 * step does the *correctness* work. Keeping them separate means a model that
 * hallucinates a Sunday 8 PM slot still gets stopped here.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   doctorRaw     → {{Chatbot: doctor}}          "Dr. Sara" | "dermatologist" | "skin doctor"
 *   dateRaw       → {{Chatbot: preferred_date}}  ideally "2026-08-25"; also accepts "tomorrow", "today"
 *   timeRaw       → {{Chatbot: preferred_time}}  "4 PM" | "16:00" | "4:00 pm"
 *   patientName   → {{Chatbot: patient_name}}
 *   phone         → {{Chatbot: phone}}
 *   reason        → {{Chatbot: reason}}
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   doctor        String   canonical: "Dr. Ahmed" | "Dr. Sara" | "Dr. Ali"
 *   specialty     String
 *   date          String   "YYYY-MM-DD"
 *   time          String   "HH:MM" 24-hour
 *   slotKey       String   "Dr. Sara|2026-08-25|16:00"  ← used for the duplicate search
 *   displayDate   String   "Tuesday 25 August 2026"
 *   displayTime   String   "4:00 PM"
 *   isValid       Boolean  false when a clinic rule is broken
 *   validationError String empty when valid
 *   alternatives  String   comma-separated fallback times, e.g. "3:00 PM, 5:00 PM"
 */

// --- doctor resolution -----------------------------------------------------
var DOCTORS = [
  { name: 'Dr. Ahmed', specialty: 'General Physician',
    aliases: ['ahmed', 'ahmad', 'general physician', 'general', 'gp', 'physician', 'checkup', 'check up'] },
  { name: 'Dr. Sara',  specialty: 'Dermatologist',
    aliases: ['sara', 'sarah', 'dermatologist', 'dermatology', 'skin doctor', 'skin'] },
  { name: 'Dr. Ali',   specialty: 'Cardiologist',
    aliases: ['ali', 'cardiologist', 'cardiology', 'heart doctor', 'heart'] }
];

var doctorRaw = String(inputData.doctorRaw || '').toLowerCase();
var doctor = '';
var specialty = '';

for (var d = 0; d < DOCTORS.length; d++) {
  for (var a = 0; a < DOCTORS[d].aliases.length; a++) {
    if (doctorRaw.indexOf(DOCTORS[d].aliases[a]) !== -1) {
      doctor = DOCTORS[d].name;
      specialty = DOCTORS[d].specialty;
      break;
    }
  }
  if (doctor) { break; }
}

// --- date resolution -------------------------------------------------------
// The chatbot should already have resolved relative dates, but handle the
// common ones here too so a lazy model output doesn't book the wrong day.
var dateRaw = String(inputData.dateRaw || '').trim();
var today = new Date();
var targetDate = null;

function toISODate(dt) {
  var m = String(dt.getMonth() + 1);
  var day = String(dt.getDate());
  if (m.length < 2) { m = '0' + m; }
  if (day.length < 2) { day = '0' + day; }
  return dt.getFullYear() + '-' + m + '-' + day;
}

var lowerDate = dateRaw.toLowerCase();

if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
  var p = dateRaw.split('-');
  targetDate = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
} else if (lowerDate === 'today') {
  targetDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
} else if (lowerDate === 'tomorrow') {
  targetDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
} else if (lowerDate === 'day after tomorrow') {
  targetDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
} else if (dateRaw) {
  var parsed = new Date(dateRaw);
  if (!isNaN(parsed.getTime())) {
    targetDate = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }
}

// --- time resolution -------------------------------------------------------
// Accepts "4 PM", "4:30pm", "16:00", "16".
var timeRaw = String(inputData.timeRaw || '').trim().toLowerCase();
var hour = null;
var minute = 0;

var timeMatch = timeRaw.match(/(\d{1,2})\s*[:.]?\s*(\d{2})?\s*(am|pm)?/);
if (timeMatch) {
  hour = parseInt(timeMatch[1], 10);
  minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
  var meridiem = timeMatch[3];

  if (meridiem === 'pm' && hour < 12) { hour += 12; }
  if (meridiem === 'am' && hour === 12) { hour = 0; }
}

// --- validation against clinic rules ---------------------------------------
var OPEN_HOUR = 9;      // 9 AM
var CLOSE_HOUR = 19;    // 7 PM — last bookable slot starts at 18:00
var isValid = true;
var validationError = '';

if (!doctor) {
  isValid = false;
  validationError = 'Doctor not recognised. Available: Dr. Ahmed (General Physician), Dr. Sara (Dermatologist), Dr. Ali (Cardiologist).';
} else if (!targetDate) {
  isValid = false;
  validationError = 'Could not understand the requested date.';
} else if (hour === null || isNaN(hour)) {
  isValid = false;
  validationError = 'Could not understand the requested time.';
} else if (targetDate.getDay() === 0) {
  isValid = false;
  validationError = 'The clinic is closed on Sundays.';
} else if (hour < OPEN_HOUR || hour >= CLOSE_HOUR) {
  isValid = false;
  validationError = 'Requested time is outside clinic hours (9 AM to 7 PM).';
} else {
  // Reject dates in the past (compare date-only, ignore time of day)
  var todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (targetDate.getTime() < todayOnly.getTime()) {
    isValid = false;
    validationError = 'That date has already passed.';
  }
}

// --- formatting ------------------------------------------------------------
var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                   'July', 'August', 'September', 'October', 'November', 'December'];

function format12h(h, m) {
  var suffix = h >= 12 ? 'PM' : 'AM';
  var display = h % 12;
  if (display === 0) { display = 12; }
  var mm = String(m);
  if (mm.length < 2) { mm = '0' + mm; }
  return display + ':' + mm + ' ' + suffix;
}

var isoDate = targetDate ? toISODate(targetDate) : '';
var hh = String(hour === null ? '' : hour);
if (hh.length < 2) { hh = '0' + hh; }
var mm2 = String(minute);
if (mm2.length < 2) { mm2 = '0' + mm2; }
var time24 = (hour === null) ? '' : hh + ':' + mm2;

var displayDate = targetDate
  ? DAY_NAMES[targetDate.getDay()] + ' ' + targetDate.getDate() + ' ' +
    MONTH_NAMES[targetDate.getMonth()] + ' ' + targetDate.getFullYear()
  : '';

var displayTime = (hour === null) ? '' : format12h(hour, minute);

// --- alternative slots (one hour either side, kept inside opening hours) ----
var alternatives = [];
if (hour !== null && !isNaN(hour)) {
  if (hour - 1 >= OPEN_HOUR) { alternatives.push(format12h(hour - 1, 0)); }
  if (hour + 1 < CLOSE_HOUR) { alternatives.push(format12h(hour + 1, 0)); }
}

output = {
  doctor: doctor,
  specialty: specialty,
  date: isoDate,
  time: time24,
  slotKey: doctor + '|' + isoDate + '|' + time24,
  displayDate: displayDate,
  displayTime: displayTime,
  patientName: String(inputData.patientName || ''),
  phone: String(inputData.phone || ''),
  reason: String(inputData.reason || ''),
  isValid: isValid,
  validationError: validationError,
  alternatives: alternatives.join(', ')
};

/**
 * ---------------------------------------------------------------------------
 * Timezone note
 * ---------------------------------------------------------------------------
 * Code by Zapier runs in UTC. "Tomorrow" is therefore computed in UTC, which
 * can be a day off for a clinic in Asia/Karachi (UTC+5) late in the evening.
 *
 * Two fixes, either is fine for this build:
 *   1. Set the Zap's timezone in Zap Settings and let the chatbot resolve the
 *      date, passing an explicit YYYY-MM-DD in `dateRaw` (preferred — this
 *      code then takes the exact-date branch and never guesses).
 *   2. Add a fixed offset here before computing today:
 *          today = new Date(Date.now() + 5 * 60 * 60 * 1000);
 */
