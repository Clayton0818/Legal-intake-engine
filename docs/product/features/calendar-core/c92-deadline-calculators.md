# c92 — Deadline calculators from court rules (P1)

## What it does
- Rule sets (`deadline_rule_sets`) are versioned firm config: triggers, non-court weekdays, court holidays, an optional late-service cutoff (e.g. a 5 p.m. e-service rule), and rules made of steps (`add`/`subtract` calendar days, court days, weeks, months, years; `next_weekday`; `roll` forward/backward off non-court days; `add_for_service_method`). Each rule needs a citation.
- A version is usable only when (1) `rules.court_deadlines` is approved and (2) a firm lawyer approved that exact version with a note of what they checked. Approved versions are never edited; editing creates a new draft.
- `POST /api/calendar-core/matters/[matterId]/deadlines` calculates from a trigger. `preview: true` only shows results; otherwise each result becomes a **proposed** calendar event (`source: deadline_calculator`) with the step-by-step explanation and warnings in its description. A lawyer confirms each through c91. Every run is stored (`deadline_calculations`, append-only).
- Firm court holidays come from the engine setting `courtHolidays`, added to each rule set's own list.
- Licensed provider: `CourtRulesProvider` + stub, gated on `rules.calendar-core.licensed_rules_provider`; imports land as drafts.
- An `EXAMPLE` Texas rule set (unverified, citations marked VERIFY) can be imported as a draft to show the mechanism.

The calculator is a tool for the lawyer. Nothing here tells a client a deadline (c44).

## Routes
`deadline-rules` (GET/POST incl. `import_example`, `import_provider`), `deadline-rules/[id]` (GET, POST approve/retire), `matters/[matterId]/deadlines` (GET/POST).
