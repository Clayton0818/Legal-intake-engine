# Intake flow specification

A machine-readable definition of what the intake engine asks, in what order,
and how it decides. This is the artefact `c12` (conversational intake flow
design) produces, and the thing `c19` (core data model) and `c13` (triage
classifier) get built against.

**This is a specification, not product code.** It deliberately does not live in
`src/` and makes no assumption about the stack — the stack decision (`c18`) is
still open, and nothing here presupposes it.

## Files

| File | What it is |
|---|---|
| `question-bank.yaml` | The field catalogue. Every fact intake can capture: id, type, validation, whether it's derived, and a PII classification. |
| `intake-flow.yaml` | The decision graph: typed nodes, gates, branch conditions, disqualifiers, rules, terminal states, and follow-up. |
| `firm-config.example.yaml` | Everything a firm can differ on, filled in with illustrative values to prove the config surface is sufficient. |
| `validate_spec.py` | Consistency checker. Run it after any edit. |

## Validate before committing

```bash
pip install pyyaml
python3 validate_spec.py .
```

It checks ten things: field types are declared; fields referenced by nodes
exist; every `next`/`goto`/`on_fail`/`default`/outcome resolves to a real node
or terminal; every node is reachable from the entry; every terminal is reached
by some edge; rules referenced are declared; conditional fields are actually
captured by their node; enum literals in branch conditions are legal for that
field; derived fields are never captured; and no node is a dead end.

Exit code 0 means clean. The checker has been verified against deliberately
broken copies of the spec — it is not a rubber stamp.

Current state: **27 nodes, 10 terminals, 51 fields, 13 rules, all reachable, 0
errors.**

## The three ideas worth understanding

**1. Flow shape and firm parameters are separated.** `intake-flow.yaml` is the
shape of the process — the same for every firm. `firm-config.example.yaml` is
the parameters — counties, thresholds, fees, cadences, referral destinations,
which matter types always need an attorney. If making a firm behave differently
requires editing the flow file, that's a bug in this split, not a feature
request.

**2. There are ten terminal states, not two.** Intake does not end in
"booked or didn't book". It ends in one of: scheduled (free meeting), scheduled
(paid consult), pending payment, pending internal review, referred out,
declined for conflict, not eligible, out of scope, did not schedule, or
abandoned. Each implies different CRM writes, different follow-up, and
different reporting. Collapsing them is the single easiest way to build the
wrong product.

**3. Some nodes wait for a human.** `research_task` and `escalate` suspend the
flow pending staff work or an attorney's decision. The engine's job there is
not to decide — it's to hold the promise made to the caller and track it to an
answer. Three SLAs exist for exactly this.

## Wording is not in this spec

Every field says *what* to capture, never *how to ask it*. That's deliberate:

- Script wording is a firm's own voice and its own liability. The reference
  material this spec was derived from is another firm's proprietary copy and
  must not be reused (see `../reference/README.md`).
- The line between gathering facts and giving legal advice sits in the wording,
  which is why it needs attorney review (`c1`, `c26`) rather than being
  generated.

So the product needs a separate, firm-authored, attorney-reviewed script layer
that binds to these field ids. Keeping the two apart means the logic can be
tested and changed without re-reviewing legal language every time.

## Provenance

Derived from the anonymised reference material in `../reference/`, which came
from photographs of a working Texas family-law firm's intake SOP. The logic
generalises; none of that firm's wording, names, partners or fees appear here
or in the example config.

## Known gaps

Things the spec models the *edges* of but does not fully define, each a
candidate card:

- **Payments.** `payment_state` gates confirmation of a paid consult, but no
  payment integration is specified. Nothing on the board covers this.
- **Client onboarding.** The post-signature stage (portal activation,
  engagement agreement, billing setup) is out of scope here — see
  `../reference/intake-sop-patterns-part2.md` §9.
- **The conflict engine itself.** `conflict_rules` defines the interface —
  tri-state, role-sensitive — but `c3` owns the implementation, and its current
  card description assumes a boolean.
- **Existing and former client paths.** `existing_caller_handoff` is a stub;
  those callers are not intake and need their own routing.
