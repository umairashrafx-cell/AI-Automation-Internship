# Module 04 — AI Appointment Booking Assistant

**Category:** Chatbot
**Hint architecture:** `Chatbot → AI extraction → Table search → Filter → Create record → Confirmation`

---

## Scenario

Build an AI chatbot for a fictional clinic (**CityCare Clinic**). The chatbot should help users book appointments.

---

## What the bot collects

- Patient Name
- Phone
- Doctor / Specialist
- Preferred Date
- Preferred Time
- Reason for Appointment

## Available doctors

| Doctor | Specialty |
|--------|-----------|
| Dr. Ahmed | General Physician |
| Dr. Sara | Dermatologist |
| Dr. Ali | Cardiologist |

Clinic hours used throughout: **Mon–Sat, 9 AM – 7 PM**, hourly slots, closed Sunday.

---

## The workflow

> **User:** *"I want to see Dr. Sara tomorrow at 4 PM."*

The chatbot must:

1. **Understand the doctor** — "Dr. Sara" / "the skin doctor" / "dermatologist" all resolve to Dr. Sara
2. **Convert "tomorrow" into an actual date** — `2026-08-25`
3. **Extract time** — `16:00`
4. **Check availability** — search the Appointments table
5. **If available → ask for patient details**
6. **Create appointment**
7. **Confirm booking**

Steps 1–3 are split between the chatbot (language) and [`code/parse-booking-request.js`](code/parse-booking-request.js) (normalisation + clinic-rule validation). Steps 4 and the double-booking guard live in [`code/availability-check.js`](code/availability-check.js).

---

## Part 1 — Build the chatbot

Zapier → **Chatbots** → *Create Chatbot*.

| Setting | Value |
|---------|-------|
| Name | `CityCare Booking Assistant` |
| Greeting | "Hi — I can book you an appointment at CityCare Clinic. Which doctor would you like to see, and when?" |
| Directive | paste from [`prompts/system-prompt.md`](prompts/system-prompt.md) |
| Creativity | **Low** |
| Data collection | `patient_name`, `phone`, `doctor`, `preferred_date`, `preferred_time`, `reason` |

Add a **Zapier action** as a tool on the chatbot so it can call the booking Zap. Instruct the bot to send `preferred_date` as `YYYY-MM-DD` — it has today's date in context and resolves relative dates far more reliably than a regex can.

---

## Part 2 — The Table

**Create:** `Appointments` — import [`schema/appointments-table.csv`](schema/appointments-table.csv)

| Column | Type |
|--------|------|
| Appointment ID | Text |
| Patient | Text |
| Phone | Text |
| Doctor | Dropdown — Dr. Ahmed / Dr. Sara / Dr. Ali |
| Date | Date |
| Time | Text (`HH:MM`, 24-hour) |
| Reason | Long text |
| Status | Dropdown — Confirmed / Completed / Cancelled / No Show |

**Recommended extra column:** `Slot Key` (Text) — `Dr. Sara|2026-08-25|16:00`. Searching one exact-match column is far more reliable than matching three, and it is what makes the double-booking guard hold up. See the note at the bottom of `availability-check.js`.

---

## Part 3 — The Zap

**Zap name:** `Clinic Booking — Check & Create`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **Booking request** | Webhooks → *Catch Hook* (or Chatbots → *New Data Collected*) | receives the six collected fields |
| 2 | **Parse Booking Request** | Code by Zapier | [`code/parse-booking-request.js`](code/parse-booking-request.js) |
| 3 | **Search Slot** | Zapier Tables → *Find Record* | `Slot Key` equals step 2 `slotKey` · "create if not found" **OFF** |
| 4 | **Find Last Appointment** | Zapier Tables → *Find Record* | sort `Appointment ID` desc, limit 1 |
| 5 | **Check Availability** | Code by Zapier | [`code/availability-check.js`](code/availability-check.js) |
| 6 | **Route** | Paths by Zapier | two paths, below |

### Path A — Slot free → book it

**Condition:** step 5 `canBook` **(Boolean) is true**

1. Zapier Tables → *Create Record* (`Appointments`)

| Column | Maps from |
|--------|-----------|
| Appointment ID | step 5 → `appointmentId` |
| Patient | step 2 → `patientName` |
| Phone | step 2 → `phone` |
| Doctor | step 2 → `doctor` |
| Date | step 2 → `date` |
| Time | step 2 → `time` |
| Reason | step 2 → `reason` |
| Status | static: `Confirmed` |
| Slot Key | step 2 → `slotKey` |

2. Return the confirmation to the chatbot / SMS:

```
You're booked. Appointment ID {{step5.appointmentId}},
{{step2.doctor}} on {{step2.displayDate}} at {{step2.displayTime}}.
We'll send a reminder to {{step2.phone}}.
Please arrive 10 minutes early.
```

### Path B — Slot taken or request invalid

**Condition:** step 5 `canBook` **(Boolean) is false**

Return `{{step5.botMessage}}` to the chatbot. **No record is created.**

`botMessage` already contains the exact wording the task sheet asks for, with real alternatives substituted in:

> *"That slot is unavailable. Would you like 3 PM or 5 PM instead?"*

---

## If unavailable

The chatbot **must NOT book the appointment.** Instead:

> *"That slot is unavailable. Would you like 3 PM or 5 PM instead?"*

This is enforced structurally, not just by prompting: the Create Record action sits inside Path A, and Path A only runs when `canBook` is true. Even if the model insists the slot is free, there is no path from Path B to a created record.

---

## Extra challenge — prevent double booking

Three layers, all implemented:

| Layer | Where | What it stops |
|-------|-------|---------------|
| **1. Slot search + gate** | step 3 + `canBook` in step 5 | Two patients booking the same doctor/date/time |
| **2. Prompt constraint** | [`prompts/system-prompt.md`](prompts/system-prompt.md) | The bot *claiming* a booking it never made |
| **3. Slot Key column** | table schema | Format drift — `16:00` vs `4:00 PM` vs `4 PM` silently failing to match |

A cancelled appointment deliberately does **not** block its slot — `availability-check.js` treats `Cancelled` / `No Show` as free so the time becomes re-bookable.

---

## Testing checklist

| User message | Expected outcome |
|--------------|------------------|
| "Dr. Sara tomorrow at 4 PM" (slot free) | Confirms date back, collects details, creates `APT-XXXX`, confirms |
| "Dr. Sara tomorrow at 4 PM" (slot taken) | *"That slot is unavailable. Would you like 3 PM or 5 PM instead?"* — no record created |
| "The skin doctor on the 25th at 16:00" | Resolves to Dr. Sara, 2026-08-25, 16:00 |
| "The heart doctor next Monday at 10" | Resolves to Dr. Ali, correct date, 10:00 |
| "Dr. Sara on Sunday at 2 PM" | Refused — clinic closed Sunday |
| "Dr. Ahmed tomorrow at 8 PM" | Refused — outside 9 AM–7 PM |
| "Dr. Ahmed yesterday at 10 AM" | Refused — date has passed |
| "Dr. Khan tomorrow at 3 PM" | Refused — doctor not recognised, lists the three doctors |
| "I have chest pain, is it serious?" | No diagnosis; suggests booking Dr. Ali |
| Book a taken slot, then book its alternative | Alternative is **re-checked**, not assumed free |

Row 10 is the one people skip and shouldn't — offering "3 PM or 5 PM" and then booking 3 PM without checking it reintroduces the exact double-booking bug the module is about.

---

## Files

```
04-appointment-booking/
├── README.md
├── prompts/
│   └── system-prompt.md
├── code/
│   ├── parse-booking-request.js   ← step 2
│   └── availability-check.js      ← step 5
└── schema/
    ├── appointments-table.csv
    └── appointments-table.json
```
