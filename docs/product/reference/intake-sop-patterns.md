# Reference: a real family-law intake SOP, and what it implies for the engine

**Status:** reference material — not product content
**Added:** 2026-09-04
**Card:** c12 — *Conversational intake flow design* (Product, In Progress)
**Also feeds:** c13 — *LLM triage classifier*, c3 — *Conflict-check automation engine*

## Provenance and handling

This document is derived from photographs of a working intake SOP used by a Texas
family-law firm, captured from that firm's internal training system. It is
summarised here in generalised form.

**Handling rules:**

- The firm name, staff names, internal email addresses, scheduling links and exact
  fee figures from the source have been deliberately left out. Do not reintroduce
  them.
- Nothing here is product copy. It describes *what a real intake process does*, so
  we can build an engine that supports processes of this shape. It must not be
  shipped verbatim, sold, or presented as the product's own scripts.
- The source photographs are not in this repo (the images are firm-identifying, and
  binary files can't be pushed through our GitHub connector). They are held locally
  by the founder.

If we later want a canonical intake script *in the product*, it needs to be written
from scratch and reviewed by a licensed attorney — see card c26.

---

## Why this is useful

Until now the intake flow cards have been designed from first principles. This is
the first artefact we have that shows how a real firm actually runs intake end to
end, including the parts that are easy to forget: disqualification, conflict
checks, escalation, and follow-up cadence. Most of the structure generalises.

---

## The shape of the process

The SOP is a **branching script driven by a small number of decision points**, not a
flat questionnaire. In order:

1. **Caller classification.** First branch is *existing client / former client /
   potential new client (PNC)*. Each goes down a completely different path. Only
   the PNC path is intake proper.
2. **Contact capture.** Name (with spelling), email, best callback number,
   referral source.
3. **Jurisdiction gate.** Which county is the matter in? The firm serves an
   explicit list of counties; outside that list the matter is not accepted.
4. **Matter-type classification.** Which practice area, confirmed back to the
   caller. Different practice areas take different question sets.
5. **Conflict check.** Name of the opposing party is captured and checked against
   the CRM *before* going further. Three outcomes: clear, possible conflict,
   definite conflict.
6. **Practice-area qualifying questions.** Branch-specific (see below).
7. **Disqualification / escalation checks.** Certain answers stop the flow or route
   to a human.
8. **Scheduling**, with the meeting type determined by whether legal advice is
   required.
9. **Handoff.** A structured summary is sent to the attorney, and all details are
   written back to the CRM under the matter.
10. **Follow-up automation** if the caller doesn't schedule.

### Engine implication

Our flow model needs to be a **directed graph with typed nodes**, not a linear form.
At minimum: `classify`, `capture`, `gate`, `conflict-check`, `branch`,
`escalate`, `schedule`, `handoff`. Card c12 should specify this graph, and c19
(data model) needs to represent it.

---

## Decision points worth copying

### Jurisdiction gate
A hard list of accepted counties, checked early. Cheap to ask, prevents wasted
intake. **Engine:** per-firm configurable list of accepted jurisdictions, evaluated
before practice-area questions. Feeds c24 (configurable pipeline stages per firm).

### Conflict check — three-way outcome
This is the most important thing in the document, and richer than our current card
assumes. It is not a boolean:

| Outcome | Action in the SOP |
|---|---|
| No conflict | Continue intake |
| **Possible** conflict | Pause intake, tell the caller research is needed, offer a callback slot, escalate to an attorney for disposition |
| **Definite** conflict | Stop intake, do not schedule, give a referral to the state bar's lawyer referral service |

Notably, the opposing party is *also* checked for prior contact with the firm — if
the opposing party previously consulted, that's a conflict even though they aren't
a client.

**Engine implication for c3:** the conflict-check engine must return a tri-state
with a required human-escalation path for the middle state, and must check both
parties against both client *and* prior-consultation records. A binary
match/no-match design would be wrong.

### Residency / eligibility disqualifiers
Example from the divorce branch: a residency duration requirement, where a "no"
answer disqualifies outright.

**Engine implication:** questions need an optional `disqualifyIf` rule, and the flow
needs a terminal "not eligible" state distinct from "declined".

### Urgency escalation
If a court hearing is imminent (inside a short window), the SOP explicitly says
**do not schedule** — instead capture two specific facts (what prompted them to seek
counsel now, and whether they can pay a retainer immediately) and route to a senior
attorney for a capacity decision, with a reminder to call the caller back.

**Engine implication:** a time-sensitivity check that can override the normal
scheduling path and open a human task with an SLA. This is a genuine feature our
cards don't currently cover — worth its own card.

---

## Practice-area question sets

The SOP keeps separate question sets per matter type, and explicitly instructs the
intake person not to re-ask anything already answered.

- **Divorce:** marriage date, residency, whether a case is already pending, cause
  number, opposing counsel, upcoming hearing date, minor children and ages.
- **Other family law:** whether an existing order is in place, and whether the
  caller wants to *modify* or *enforce* it — these diverge into different question
  sets and different meeting types.
- **Custody:** ages of children, who they live with, residency duration.
- **Modification:** what specifically is being modified, plus a minimum time since
  the order was entered; some subjects are out of scope entirely.
- **Enforcement:** whether the thing being enforced is actually stated in the order.

**Engine implications:**
- Question sets are **per practice area**, versioned, and firm-configurable.
- The engine must track which facts are already known and suppress redundant
  questions — this is a real requirement for the conversational flow (c12) and a
  quality bar for the classifier (c13).
- Some branches route to a *paid* consultation rather than a free meeting, so the
  flow's output includes a **meeting type**, not just "book a slot".

---

## Meeting types

Two distinct outcomes, chosen by whether legal advice is needed:

1. **Complimentary initial meeting** — longer, with a non-attorney client
   engagement specialist, explicitly *no legal advice given*, covers situation,
   timeline, retainer expectations.
2. **Paid consultation** — shorter, with an attorney, includes strategy discussion.

The SOP has a prepared response for callers who push back on not getting legal
advice in the free meeting.

**Engine implication:** meeting type is a first-class output of the flow. The
distinction also matters for compliance (c1, UPL): the free meeting is defined by
the absence of legal advice, which is exactly the line our UPL review needs to
respect. The engine should never generate advice-like output in the intake path —
this is a concrete constraint for c13's prompt design, and evidence for the c1
review.

---

## Handoff

After scheduling, a structured summary is sent to the attorney containing: name,
consultation date/time, channel (phone or video), phone, email, and a detailed
summary. All case details are written back to the CRM under the matter *before*
the appointment is booked.

**Engine implication:** the handoff payload is a defined schema, and "write to CRM
before booking" is an ordering constraint, not a preference. Relevant to c4
(integration layer for practice-management tools) — Lawmatics is the CRM in this
SOP, which is a real data point for which integrations matter.

---

## Follow-up cadence

Automated follow-up sequences for callers who don't schedule, with **different
intervals per practice area** (a faster cadence for simpler matters, slower for
family law), typically four attempts over one to two weeks, ending in a
non-engagement email. Callers who give a specific follow-up date are removed from
automation and handled manually.

**Engine implications:**
- Per-practice-area, per-firm configurable cadences.
- A defined terminal "non-engagement" state and message.
- A manual-override state that suppresses automation — the engine must never keep
  auto-chasing someone a human has taken ownership of.

---

## Gaps this exposes in our current backlog

Things the SOP does that no current card covers:

1. **Urgency/hearing-date escalation path** with a human SLA.
2. **Eligibility disqualifiers** as a first-class concept (distinct from declining).
3. **Meeting-type selection** (free non-advice meeting vs. paid attorney consult)
   as a flow output.
4. **Follow-up cadence engine** with per-practice-area intervals and a manual
   override.
5. **Conflict check as tri-state** — c3 likely assumes binary; it needs updating.

Each of these is a candidate card. Recommend reviewing them before c12 is
considered done.
