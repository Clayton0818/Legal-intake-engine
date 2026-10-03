# c95 — Matter stages and closing per practice area (P1)

## What it does
- Lifecycles (`matter_stage_definitions`) per practice area, versioned, one active per area. Exactly one closing stage, which must be last.
- `matter_lifecycle` holds each matter's current stage (separate from the intake `matters.stage` enum, which only gets `closed` at the end). Every change is in `matter_stage_transitions` (append-only).
- Moving forward runs the stage's task lists (c94), optionally creates a task for the lawyer to send a client update (c54 sends it; this engine never writes to the client), and records a billing event (audit `stage.billing_event`, a record only, never a charge). Moving back needs a reason and does not re-run task lists.
- **Closing:** a lawyer starts it (creates the closing-checklist task for the Document engine's c90 checklist), confirms trust at zero (lawyer attestation until a shared trust-balance read exists), then completes it. Completion is refused, with the reasons listed, while the checklist is open, trust is unconfirmed, deadline tasks are open, future events are not cancelled, or limitation dates are open. On completion `matters.stage = 'closed'` and `closed_at` are set.
- **DRAFT Family Law lifecycle:** opened → petition prep → filed → served → temporary orders → discovery → mediation → trial prep → final orders → closed. Firm-editable; seeded as a draft.

## Routes
`stages` (GET/POST incl. `seed_family_draft`), `stages/[id]` (activate), `matters/[matterId]/stage` (GET/POST start/move), `matters/[matterId]/closing` (GET/POST start/trust_zero/complete/abandon).
