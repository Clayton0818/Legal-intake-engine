# flow/

The intake decision-graph engine (ADR-0001 §D2 module layout). This is where `docs/product/spec/intake-flow.yaml` gets interpreted at runtime — node transitions, gate evaluation, the conflict-check hand-off — reading against a `firm_config_versions` row for the per-firm parameters.

Empty pending: `c3` (conflict-check engine, tri-state/role-sensitive) and the broader flow-execution engine implied by `c12`'s spec. Both read/write `intake_sessions` and `intake_events` via `withTenant()` — see `src/tenancy/`.
