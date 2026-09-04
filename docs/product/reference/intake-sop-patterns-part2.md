# Reference part 2: practice-area routing, scheduling policy, and client onboarding

**Status:** reference material — not product content
**Added:** 2026-09-04
**Companion to:** `intake-sop-patterns.md` (part 1)
**Cards:** c12 (intake flow), c13 (triage classifier), c5 (integration layer), c3 (conflict engine), c4 (engagement letters)

## Provenance and handling

Same source as part 1 — photographs of a working Texas family-law firm's internal
intake SOP — covering the sections *after* where part 1 stopped. Firm name, staff
names, referral-partner names, email addresses, links and exact fee figures are
deliberately omitted; where a number matters structurally it is described as a
policy shape rather than a value.

Reference only. Not product copy, not to be shipped verbatim. Any canonical
script in the product needs writing from scratch plus attorney review (c26).

---

## 1. The jurisdiction gate is per practice area, not global

Part 1 recorded a hard list of accepted counties. Part 2 corrects that: the county
list applies to **family law**, while other practice areas are accepted **statewide**.

**Engine implication:** jurisdiction rules attach to the *practice area*, not the
firm. The data model (c19) needs jurisdiction scoping at matter-type level, and the
flow (c12) must classify practice area *before* it can evaluate the gate — which
inverts the ordering part 1 implied.

---

## 2. Referral-out is a first-class outcome

For practice areas the firm doesn't handle itself, intake still gathers the full
question set, then routes the enquiry to an external partner firm — **chosen by
geography** — and marks the record with a distinct disposition meaning
"did not hire — referred out".

There is a similar path for matters the firm handles only in some counties, and a
separate one for enquiries needing managing-attorney review before any answer.

**Engine implications:**
- The flow's terminal states are at least: scheduled, not eligible, declined
  (conflict), **referred out**, and pending internal review. This is more than
  c12 currently assumes.
- Referral routing is a configurable rules table (practice area × geography →
  destination), and the handoff is an outbound message with the gathered intake.
- Referred-out is a *reportable* outcome — firms will want to know volume and
  destination. Relevant to any analytics work.

---

## 3. Additional practice-area question sets

Beyond part 1's family-law branches:

- **Expunction / criminal record clearing:** date of birth, case number, charges,
  arrest location, how the case was disposed of, whether deferred adjudication or
  probation applied, other arrests or convictions. Followed by an **internal
  research step** — staff look the case up in the public judicial record to
  establish disposition, then send it to a managing attorney for an eligibility
  decision. The caller is told they'll hear back after review; nothing is promised
  on the call.
- **Personal injury:** injured party, case type (motor vehicle, premises, etc.),
  when and where the incident occurred, injuries, medical records, witnesses,
  whether the other party's insurer has been contacted and with what result. Ends
  in referral-out (section 2).
- **Mediation** (the firm's attorney acting as mediator): whether a case is
  pending and its number, county, opposing party, whether each side has counsel,
  and whether a full or half day is wanted.

**Engine implications:**
- Question sets are pluggable per practice area, as part 1 said — but two new node
  types appear: an **internal research task** (staff work between the call and the
  answer) and a **deferred eligibility decision** by a qualified human. The flow
  must be able to end in "we'll come back to you" without an appointment, and
  track that promise to closure.
- Different practice areas terminate in *different* kinds of outcome. The flow
  model needs pluggable terminal handlers, not one scheduling step.

---

## 4. A tighter conflict rule for mediation

If either party previously had an initial meeting with the firm, it cannot then act
as mediator between them — an explicit "do not schedule" with conflict as the
stated reason.

**Engine implication for c3:** conflicts are **role-sensitive**. The same prior
contact that's harmless in one engagement type disqualifies another. The conflict
engine needs to evaluate prior-contact records *against the role being sought*, not
just look for name matches. Together with part 1's tri-state finding, c3's design
needs a real rethink.

---

## 5. Out-of-scope taxonomy

The SOP names things it explicitly does **not** take, distinct from being
ineligible or conflicted:

- Limited-scope work — drafting or filling in documents only.
- Matters where the opposing party is a state child-protection agency.

Separately, several matter types skip the free meeting and go **straight to a paid
attorney consultation** (order modification and enforcement, pre/post-marital
agreements, name changes, adoptions).

**Engine implications:**
- An explicit not-served list, configurable per firm, evaluated as its own gate
  with its own message — distinct from "not eligible" and from "conflict".
- Meeting type (part 1, section on meeting types) is partly determined by
  **matter type**, not only by whether legal advice is requested. c12 should model
  meeting-type selection as a rules table over both.

---

## 6. Language routing

Non-English enquiries have their own path: check for an available team member who
speaks the language; if none, hand off to a **virtual receptionist service** that
completes the intake and returns it; then schedule with a language-matched staff
member, with a named attorney as the consult option.

**Engine implications:** language is a routing dimension alongside practice area
and geography, affecting both who handles intake and who the appointment is booked
with. Worth a card — nothing currently covers it, and for a commercial product in
Texas it is not optional.

---

## 7. Scheduling and consultation policy

Rules that constrain the booking step:

- Same-day appointments need confirmation; same-day bookings with the
  client-engagement team require a **minimum lead time** (a couple of hours) and a
  manual check of that team's calendar.
- **Payment before confirmation** for paid consultations — the appointment isn't
  confirmed until the fee is paid, with an exception path for cash at in-person
  meetings.
- If the caller says they've just paid, verify before booking.
- Callers may opt out of video for a phone call.
- **Self-scheduling fallback:** if the caller won't book on the call, send a
  scheduling-plus-payment link from a CRM template.
- **Cancellation policy:** no refunds except firm error; refund if the caller
  cancels before the consultation.
- **No-show policy** with a grace period from the scheduled start, after which the
  session may need rescheduling.

**Engine implications:**
- Booking is not "find a slot" — it's a policy engine over lead time, payment
  state, channel preference, and staff calendars. c12 and c23 both underestimate
  this.
- **Payment state gates confirmation**, so the engine needs a payment integration
  and a pending-payment state that can expire. Nothing on the board covers
  payments — a real gap.
- Cancellation, refund and no-show rules are per-firm configuration.

---

## 8. CRM field discipline

When intake gathers information but no appointment is booked, three fields are
updated: matter stage → a "did not schedule" value, record status → prospective
client, and practice area must be set. Elsewhere: all case details written to the
matter record **before** booking, and specific stage values that remove a record
from automation when a human takes it over.

**Engine implication:** the engine is not the system of record — it *drives* one.
Every terminal state maps to a defined set of field writes in the firm's CRM, and
that mapping is configuration. This is the concrete shape of c5's integration
layer, and it is more than "sync contacts".

---

## 9. A whole stage the board doesn't have: client onboarding

Everything above is pre-signature. The SOP continues past it into **onboarding a
signed client**, run as a scripted call:

- Confirm the client can access the **client portal** (a second system, separate
  from the intake CRM) — resend the activation link and wait while they set it up
  if not.
- Point them at an intake form inside the portal that must be completed before work
  starts.
- Check whether the engagement agreement is signed **in the intake CRM**, with
  different scripts for signed and unsigned, and confirm the matter type back.
- Walk through the client letter: communication policy (**one message thread in the
  portal**, not new threads), how to request meetings, channel options.
- **Emergency definition** — a short, explicit list of what counts (roughly four
  situations), with a different list depending on whether children are involved,
  and instructions to contact emergency services first where relevant.
- Office hours, plus an after-hours courtesy explanation for evening onboarding
  calls.
- **Billing:** retainer model, per-staff hourly rates named in the engagement
  agreement, **replenishment triggered when the retainer falls to half** its
  original amount, weekly invoices via the portal, a billing specialist as the
  contact for questions.
- Next steps: a strategy session with the legal team, and a confidentiality
  statement.

**Engine implications:**
- Onboarding is a **distinct stage with its own scripted flow, its own checklist
  state, and its own system integrations** — the intake engine's natural next
  surface, and where a lot of the repetitive work actually is.
- It depends on knowing engagement-agreement status, which links it to c4.
- Retainer replenishment at a threshold is a **rule an engine can own** — a
  monitored condition that fires a task or a client message.
- The emergency definition is a safety-critical script: it tells people when to
  call emergency services rather than the firm. If the product ever renders this,
  it must be firm-authored and attorney-reviewed, never model-generated. Flag for
  the UPL review (c1/c26).

---

## 10. Systems in play

The firm runs at least four: an **intake CRM** (lead capture, automation
sequences, email templates, engagement agreements), a **client portal / practice
management system** (client-facing messaging, intake forms, invoices, calendar), a
**scheduling tool**, and a **virtual receptionist service** for overflow and
language coverage.

**Engine implication for c5:** the integration surface is broader than the
practice-management tools c5 currently names, and the split matters — intake data
lands in the CRM, client-facing onboarding happens in the portal. A product that
only integrates one of the two would sit awkwardly in a firm shaped like this. It
also raises the strategic question of what the product *replaces* versus what it
sits alongside — worth deciding before c5 is designed.

---

## Candidate cards from part 2

On top of part 1's five:

6. **Referral-out routing** — rules table, outbound handoff, distinct disposition.
7. **Language routing** — availability check, fallback, language-matched booking.
8. **Booking policy engine** — lead time, payment state, channel, calendar checks.
9. **Payments** — nothing on the board covers taking a consultation fee, yet
   payment gates confirmation.
10. **Internal research / deferred eligibility node** — flow can pause for staff
    work and a human decision, then close the loop with the caller.
11. **Client onboarding flow** — the post-signature stage in section 9.
12. **Out-of-scope and matter-type rules** — not-served list, and matter-type-driven
    meeting selection.

Sections 1 and 4 are corrections to existing cards rather than new ones: the
jurisdiction gate (c12) and the conflict engine (c3) are both currently modelled
too simply.
