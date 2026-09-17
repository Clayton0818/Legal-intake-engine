# Audit Log & Compliance Trail — Requirements, Retention, and Integrity

**Status:** Design draft — engineering research and a recommended approach, not a finished implementation. Board card `c6`.
**Depends on:** ADR-0001 (`c18`, PR #5 — merged), `c2` (data privacy & retention policy, PR #2 — merged), `c9` (encryption & access control review, PR #6 — merged).
**Consumed by:** `c19` (data model), `c24` (admin console), `c20` (CI/CD).

## 1. What's already decided, and what's actually left

ADR-0001 §D6 already made the load-bearing call: workflow state runs on four Postgres tables, and one of them — `intake_events`, append-only, one row per state transition with actor, timestamp, and the rule that fired — **is** the audit log's capture mechanism. The ADR says this plainly: *"the audit log (`c6`) is already built... It is not a feature to add later; it is the storage design."*

That's true for capture. It is not true for the rest of what `c6`'s own card description asks for: *"Immutable record of every automated decision the intake engine makes, for bar compliance and malpractice defense."* Three things in that sentence aren't settled by D6 alone:

- **"Immutable"** is an intent, not yet a mechanism. An application-level `INSERT`-only convention is not the same guarantee as a database role that structurally cannot `UPDATE` or `DELETE` the table — and "for malpractice defense" specifically implies the record needs to survive a challenge to its own integrity, not just accidental modification.
- **"For bar compliance and malpractice defense"** implies a retention floor. `c2`'s retention policy governs the underlying intake data (client PII, matter facts); the audit trail governing *what the system did and why* has a different, and generally longer, retention rationale — it exists specifically to be pulled out years later in a malpractice claim, which is exactly the scenario `c2` doesn't optimize for.
- **Presentation** — being able to actually reconstruct a matter's decision timeline for a bar inquiry or a malpractice defense — is a UI/query surface. D6 gives you rows in a table; it doesn't give a staff member or an attorney a way to read them.

This document specifies those three things. It does not re-litigate D6, redesign the four workflow tables, or duplicate `c9`'s access-control taxonomy — it constrains all three at the one point they touch the audit trail specifically.

## 2. What must be captured (the completeness bar)

`intake_events` already captures "one row per state transition." For this to actually serve bar compliance and malpractice defense, three categories of event must be non-negotiable, because they are exactly the moments a firm would need to reconstruct after the fact:

- **Every gated decision the flow makes on the caller's behalf**, per `intake-flow.yaml`: the conflict-check outcome (clear / possible / definite) and which records it matched against; the out-of-scope and jurisdiction gate results; every disqualifier that fired (residency, order-age, and so on); every escalation (urgency, possible-conflict) and who it was handed to.
- **Every automated classification**, per the `c13` design spec (PR #8): the classifier's practice-area output and confidence, the advisory out-of-scope signal, and — because it is the one place that document deliberately hard-overrides everything else — whether `safetyFlag` fired. A safety escalation is precisely the kind of event a firm needs to be able to prove it acted on, later.
- **The configuration in effect at the time**, not just at query time. `firm-config` is mutable — thresholds, jurisdiction lists, and referral tables change over time — but a decision made under last year's config has to remain interpretable under *that* config, not whatever the firm has configured today. **This is the one real gap in D6 as written**: `intake_events` records the rule that fired, but not the config values that rule evaluated against. Recommendation: either snapshot the relevant config fragment into the event payload at write time, or version `firm-config` itself (each config change becomes a new row with an effective-from timestamp, and events reference the version in effect) so that "what did the rule actually see" is always answerable. The latter is more work but is the right long-term answer, since it also lets a firm audit *when* it changed a threshold — itself sometimes the compliance-relevant fact. Flagged as a `c19` decision, not resolved here.

What does **not** need to be captured here: raw caller free text is already covered by `c2`'s retention schedule and the `c13` spec's `privileged`-tier handling — the audit trail should reference it, not duplicate it inline, for the same reason `c13`'s hand-off section gives: two copies of privileged data drift, and one of them is harder to purge on a deletion request.

## 3. Immutability: from convention to structural guarantee

ADR-0001's general principle — under constraint 5 (the reviewer is not an engineer), prefer mistakes that are *loud* over designs that are merely *elegant* — applies directly here, the same way it did to D5's tenant isolation. "Don't write code that updates `intake_events`" is a convention; conventions are exactly what D5 argued against relying on for anything load-bearing.

**Recommendation, in order of how cheap each is:**

1. **The application's database role should not hold `UPDATE` or `DELETE` grants on `intake_events`, full stop.** This is the direct analogue of D5's "the application role must not hold `BYPASSRLS`" — the guarantee should live in database permissions, not application code discipline, so that a bug or a future contributor cannot silently defeat it.
2. **A required CI check**, alongside D5's cross-tenant isolation test: attempt an `UPDATE` or `DELETE` against `intake_events` using the application's own role and assert it fails. This is the same "structure plus one automated tripwire" pattern D5 uses, and it costs almost nothing once `c20` exists.
3. **Tamper-evidence beyond access control, for later.** Access control prevents *accidental or routine* modification; it doesn't prove after the fact that a row wasn't altered by someone with elevated database access (a compromised credential, a support engineer with emergency access). A hash-chain — each event's hash incorporates the previous event's hash, so altering any past row breaks every hash after it — is the standard answer to "prove this log wasn't tampered with," and it is cheap to add at write time. This document recommends it as a should-have, not a must-have for launch: it matters most in exactly the scenario (a malpractice claim, a bar inquiry) that is rare but is the entire reason `c6` exists, so the cost of skipping it should be a conscious choice, not an oversight. Flagged as an open question in §6.

## 4. Retention: why this is not `c2`'s retention schedule

`c2` sets retention for the underlying intake data — the facts a caller gave, largely so the firm and the vendor aren't holding privileged information longer than necessary. The audit trail's retention logic runs in the *opposite* direction: it exists so the firm can prove, potentially years later, what the system told a caller and why a decision went the way it did. Under-retaining it defeats the card's own purpose.

**Grounding in the actual limitations periods (Texas, consistent with `c1`'s scoping):** Texas legal-malpractice claims run on a two-year discovery rule — two years from when the client knew or should have known the representation was deficient — and breach-of-fiduciary-duty claims (which can be pled alongside malpractice on the same facts) run four years. Texas's own bar guidance (Opinion 627) declines to set a fixed retention period and instead tells attorneys to use professional judgment, informed by "all applicable statutes of limitation for claims against the client and the lawyer, including malpractice claims." In practice, firms commonly land on retention well past the bare statutory minimum — five years in Tennessee, ten in Kansas, and many firms independently converge on seven years (coincidentally aligned with IRS recordkeeping norms) precisely because discovery-rule claims and appeals can push the effective window out further than the nominal limitations period suggests.

**Recommendation:** the audit trail's retention floor should be tied to the *matter's* retention setting (firm-configured, per `c2`), not a separate fixed number — because the audit trail's value is inseparable from the matter it documents, and a firm that (correctly, per its own file-retention policy) keeps a matter's records for seven years gains nothing from an audit trail that's purged after two. Concretely: **audit events for a matter should never be eligible for deletion before the matter's own retention period expires**, and the two should be governed by the same per-firm retention configuration rather than two independently-tunable settings that can drift out of sync. Below that floor, firms remain free to set retention longer (there's a real argument for retaining audit data indefinitely, since storage cost is low and the downside of premature deletion is a lost malpractice defense) — this document does not recommend a firm-wide ceiling, only the floor.

**This needs the same attorney review as `c1`/`c2`/`c26`.** The specific number is a professional-judgment call Texas deliberately leaves to the lawyer per Opinion 627, not something this research pass should fix — see §6.

## 5. Access and presentation

**Access, building on `c9`'s taxonomy rather than inventing a new one:** audit data is a superset of the sensitive events in a matter — it includes the fact that a possible-conflict escalation happened, that a safety flag fired, that a particular staff member's access triggered a given event — and per `c9`'s recommended RBAC shape, read access to the raw audit trail should sit at a narrower tier than routine matter access, consistent with `c9`'s "break-glass only, no standing cross-tenant access" principle for internal staff. Write access is not a permissions question at all under §3's design — nothing holds write access to `intake_events` except the flow engine itself.

**Presentation is a `c24` requirement, not a `c6` one**, but it's worth stating plainly here so it isn't lost: the actual deliverable a firm needs from this card, at the point someone asks for it, is a *reconstructed timeline* for one matter — every gated decision, every classification, every escalation, in order, readable by a person who is not a database administrator. `c6`'s job is to make sure the underlying data supports that view (completeness per §2, integrity per §3, retention per §4); building the view itself belongs with the admin console.

## 6. Open questions for human review

1. **The retention floor's specific number.** This document ties audit retention to the matter's own retention setting rather than proposing an independent fixed period, per Texas Opinion 627's "professional judgment" framing — but the *matter* retention default itself (which `c2` also left open) needs the same attorney sign-off as `c1`/`c2`/`c26`, since it's the number this card's floor inherits.
2. **Config versioning (§2) vs. inline config snapshotting.** Versioning `firm-config` is the more complete answer but is real additional work for `c19`; snapshotting the relevant fragment per event is cheaper but duplicates data. Worth deciding once `c19` is actually being designed, not preemptively here.
3. **Hash-chaining (§3).** Recommended as a should-have; flagged rather than mandated because it adds implementation surface before there's a single real client record to protect. Revisit trigger: build it before the first real (non-synthetic) client data flows, per ADR-0001's own production-data gate — the same moment tamper-evidence starts actually mattering.

## Sources

- ADR-0001 (`docs/architecture/adr/0001-initial-technology-stack.md`) — §D6 workflow-table design, §D5's "structure over convention" pattern this document reuses for immutability.
- `docs/compliance/data-privacy-retention-policy.md` (`c2`) — retention framing this document deliberately does not duplicate, and ties audit retention to instead.
- `docs/product/spec/llm-triage-classifier.md` (`c13`) — `safetyFlag` and classifier-output fields this document requires be captured as audit events.
- [Sample File Retention Policy — Texas Bar Practice](https://www.texasbarpractice.com/law-practice-management/growing/sample-file-retention-policy/) — matter-closure as the retention trigger, and Texas's professional-judgment framing rather than a fixed statutory period.
- [When (And How) Can You Destroy Client Files? — Texas Lawyers' Insurance Exchange](https://www.tlie.org/760/) — Texas Opinion 627, the two-year malpractice discovery rule and four-year breach-of-fiduciary-duty period, and comparative state minimums (Tennessee 5 years, Kansas 10 years, common 7-year practice).

## Review notes

Nothing here overrides `c2`'s retention framework or `c9`'s access-control model — this document ties into both rather than replacing either. The two places most worth a second pair of eyes: whether tying audit retention to matter retention (§4) rather than a separate fixed period is the right call operationally, and whether hash-chaining (§3) should be pulled forward from "should-have" to a hard requirement given how central this card is to malpractice defense specifically.
