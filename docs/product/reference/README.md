# Reference material

Real-world source material informing the build. **None of this is product
content.** It describes how working law firms actually run intake, so the engine
can support processes of that shape.

## Handling rules

- Everything here is anonymised: no firm names, staff names, referral partners,
  email addresses, links, or exact fee figures. Do not reintroduce them.
- Do not ship any of it verbatim, quote it as product copy, or present it as the
  product's own scripts. It is a description of someone else's process.
- Any canonical intake or onboarding script *in the product* must be written from
  scratch and reviewed by a licensed attorney (card c26).

## Contents

| Doc | Covers | Primary cards |
|---|---|---|
| [`intake-sop-patterns.md`](intake-sop-patterns.md) | The core intake flow: caller classification, contact capture, jurisdiction gate, conflict check, family-law question sets, disqualifiers, urgency escalation, meeting types, attorney handoff, follow-up cadence | c12, c13, c3 |
| [`intake-sop-patterns-part2.md`](intake-sop-patterns-part2.md) | Practice-area routing (expunction, personal injury, mediation), referral-out, out-of-scope rules, language routing, booking and cancellation policy, CRM field discipline, and the post-signature client onboarding stage | c12, c13, c5, c3, c4 |

Source: photographs of a Texas family-law firm's internal training system,
supplied by the founder on 2026-09-04. The images are not in this repo — they are
firm-identifying, and the GitHub connector cannot push binary files.

## What this material changed

Between them, the two documents surfaced twelve candidate cards and two
corrections to existing ones. The corrections matter most:

- **Conflict checking (c3)** is modelled too simply. It is tri-state (clear /
  possible / definite, with the middle requiring human escalation) *and*
  role-sensitive (prior contact that's harmless for representation can disqualify
  the firm from mediating).
- **The jurisdiction gate (c12)** is per practice area, not per firm — so practice
  area must be classified before the gate can be evaluated.

The biggest genuine gap is **payments**: nothing on the board covers taking a
consultation fee, yet in this firm's process payment is what confirms an
appointment.

The second biggest is **client onboarding** — an entire post-signature stage with
its own scripted flow, checklist, and system integrations, which the board treats
as out of scope today.
