# c53 — Case health meter based on client-firm interaction, flagging matters that have become unhealthy

**Card:** c53 · Calendar & deadline engine · P1 · Product
**Status:** Draft spec.

## 1. Summary

Every open matter gets an internal health score (green/amber/red, 0–100 underneath) built from signals other cards already record, split into a firm-responsiveness sub-score and a client-engagement sub-score, each shown with its top reasons in plain words. When a matter turns red or drops sharply, the responsible lawyer and firm admin are flagged; the score only prompts a human to look and never triggers a legal step.

## 2. Users and problem

- **Responsible lawyer** wants to catch a matter going sideways before the client complains.
- **Firm admin/owner** wants one view of where attention is needed across all matters.
- Long silences toward the client and slow replies are common sources of bar complaints; the individual flags (c42–c47) show single events, not the pattern.

## 3. Scope

**In scope**
- Score model, sub-scores, reasons, trend detection, urgency ranking, thresholds and weights (firm-set), flags on transition, firm dashboard extending c33.

**Out of scope**
- New data capture (uses existing signals only).
- Client visibility (never).
- AI tone analysis of client messages: optional later phase, off by default, needs lawyer opt-in and the ADR-0001 D9 AI-vendor gate.
- Any automated action beyond flagging.

## 4. Behaviour

1. **Recompute** a matter's score nightly and within 15 minutes of a relevant event (reply sent, flag raised/cleared, task completed, client login), debounced.
2. **Firm responsiveness sub-score (0–100)** from, with proposed default weights:
   - reply times against c43/c44 targets (last 30 days) — 30%
   - open overdue firm tasks on the matter (c45) — 25%
   - stalled workflow items (c47) — 15%
   - business days since the last meaningful update to the client (c54 update or human reply) — 30%
3. **Client engagement sub-score (0–100)** from:
   - client reply times and open non-responses (c42) — 30%
   - overdue client tasks (c46) — 20%
   - missing documents (c49) — 15%
   - delayed sign-offs (c41) — 10%
   - retainer below the floor ($4,500 default, c50) or missed installments (c52) — 15%
   - business days since the client last logged in or replied — 10%
4. **Overall score** = the lower of the two sub-scores (proposed; so a problem on either side shows). Bands: **green ≥ 70, amber 40–69, red < 40** (firm settings).
5. **Signals not yet available** (their card not built, or not applicable, e.g. a fixed-fee matter has no retainer floor) are excluded and their weight redistributed; the reasons list shows "not measured: …".
6. **Reasons:** the top 3 contributing factors per sub-score in plain factual words, e.g. "client hasn't replied in 6 business days; 2 documents missing; last update to client 12 days ago".
7. **Trend:** store a daily snapshot. A drop of **≥ 20 points within 5 business days** (firm settings) is "falling sharply".
8. **Urgency ranking:** dashboard and ops-queue order = (100 − score) × multiplier, where the multiplier is **1.5** if the matter has a confirmed court deadline within 10 business days (c91/c44), else 1.0. The multiplier affects ordering only, not the score.
9. **Flag:** when a matter enters red or is falling sharply, raise one internal flag to the responsible lawyer and firm admin (matter page, ops queue c37, email per c51), logged. No repeat flag until the matter has left red / stabilised for **5 business days** and turned unhealthy again.
10. **Acknowledge:** the lawyer can acknowledge with a note and a check-back date; the flag clears, the score keeps updating, and the matter re-flags on a new transition after the check-back date.
11. **Dashboard:** firm-wide health list and distribution on `/admin/insights` (c33), filterable by lawyer, practice area, band, and trend.

**Edge cases**
- New matter with little history → shows "not enough data" (grey) for the first **10 business days**, no flag.
- Matter on hold with a c47 check-back → responsiveness signals for that stall are paused until the check-back date.
- Matter closed → score frozen and hidden from the active dashboard.

## 5. Business rules

1. Scores use only signals already recorded by other cards.
2. Every score displays its top reasons; no score is shown without reasons.
3. Weights, bands, trend threshold, multiplier and grace for new matters are **firm settings** with the defaults above.
4. Internal only: no client principal can read scores, snapshots or health flags (same enforcement as c45).
5. Reasons are factual and neutral; no labels about people (e.g. never "difficult client").
6. The score never triggers any legal step (withdrawal, non-engagement, fee action) or any client-facing message.
7. Tone analysis is off by default and cannot be enabled until lawyer opt-in and the D9 gate are recorded.
8. Every health flag, acknowledgement and settings change is logged.

## 6. Data model touchpoints

- **Reuse:** `matters` (stage, assigned_user_id, opened_at, closed_at), `firm_config_versions.config` (`health.*`), c33's insights route.
- **Reads (proposed by other cards):** `messages`, `tasks`, `flags`, `client_updates`, c49 document checklist, c50/c52 billing status, calendar entries (c91), client login events (c34).
- **Proposed:** `matter_health_snapshots` (`matter_id, computed_at, score, firm_subscore, client_subscore, band, reasons jsonb, signals jsonb, config_version_id`); `flags` with `subject_type = 'matter_health'`.

## 7. Notifications and visibility

- Responsible lawyer + firm admin: in-app, ops queue, email (non-urgent unless the multiplier applies; digest-eligible).
- Lawyers see their own matters' health; admins see all.
- Clients see nothing.

## 8. Dependencies

- **Needs first (for full value):** c42, c43, c44, c45, c46, c47, c54; optional signals from c41, c49, c50, c52; c91; c33 dashboard; c37; c51; c6. Can ship with a subset of signals thanks to rule 5 in §4.
- **Feeds:** c48 (workload/cadence could read health), c101 (reports).

## 9. Compliance and review flags (licensed Texas attorney)

- Internal scores and reasons may be sought in a later grievance, fee dispute or malpractice case: approve the factual-wording rules and snapshot retention (c2).
- Fairness: signals like "hasn't logged in" can reflect limited internet access, language or safety constraints (DV clients avoiding devices); confirm the score is framed as a prompt, not a judgment, and consider excluding login recency for DV-flagged matters.
- Tone analysis phase: separate review before any build.
- CPA: not required; c53 reads c50/c52 status only and never computes or moves trust money.

## 10. Acceptance criteria

1. **Given** a matter where the client hasn't replied in 6 business days and 2 documents are missing, **then** its client sub-score reasons list both in plain words.
2. **Given** a matter moves from amber to red, **then** one internal flag goes to lawyer and admin (in-app, ops queue, email) and is logged.
3. **Given** a score drops 25 points in 3 business days while staying amber, **then** it is flagged as falling sharply.
4. **Given** two red matters with equal scores, one with a confirmed hearing in 5 business days, **then** that one ranks higher on the dashboard.
5. **Given** a signed-in client, **then** no health score, reason or flag is reachable through any client API or portal page.
6. **Given** c49 is not built yet, **then** the missing-documents signal shows "not measured" and weights are redistributed.
7. **Given** a red matter, **then** no client message, task or legal step is created automatically.

## 11. Open questions for Clayton

1. Overall score = lower of the two sub-scores (proposed) or a weighted average?
2. Confirm default weights, bands (70/40) and trend threshold (20 points / 5 business days).
3. Exclude "last login" from DV-flagged matters?
4. Should firm admins see health on all matters, or only on matters where a flag has fired?
