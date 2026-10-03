# c103 — Family Law pack (pilot practice area)

**Code:** `src/engines/all-engines/packs/family.ts` (data), gates in `src/engines/all-engines/gates.ts`. **Status: DRAFT, version 0.1.0.** Needs review by a licensed Texas family-law attorney before it is relied on (`rules.all-engines.family.pack_content`). Nothing in it is legal advice.

## What it contains
- **Matter types:** divorce, custody and visitation, child support, protective orders, modification, enforcement (mapped to the classifier's `family_*` labels; child support and protective orders are chosen by staff).
- **Intake questions (28):** safety first (are you safe; is it safe to contact you; harm or threats; children's safety), then parties by name before any case detail (spouse/other parent, other names, new partner, grandparents/relatives, other side's lawyer), then children, then existing court orders, protective orders, upcoming court dates and served papers, then the case and finances. Every prompt is a gated draft (`copy.all-engines.family.q.*`).
- **Safety / DV:** any concerning answer → emergency flow (c66, category `safety_dv`) and the client contact is marked DV-sensitive. Defaults for every family client: safe email required, no SMS, no voicemail, no sensitive content by email, never a shared device. Records are requested "only if it is safe to do so".
- **Conflict roles:** client, spouse, other parent, protective-order respondent, new partner, grandparent, other relative, opposing counsel, guardian ad litem — indexed; **children are not indexed by default** (c56 open question 3). An unnamed spouse/other parent/respondent keeps the check from coming back clear.
- **Documents:** folder template (client folders, restricted safety folder, pleadings, orders, disclosures, mediation, work product, billing); checklists for divorce disclosures and inventory, children (incl. parenting plan), protective orders, modification/enforcement; template references (petitions, parenting plan, inventory, disclosures, final orders) behind `rules.all-engines.family.starter_templates`.
- **Stages:** filing → service → temporary orders → disclosures → mediation → final hearing → final orders → after the order → closed; a separate protective-order track.
- **Task lists:** opening tasks (confirm safe contact, parties indexed, lawyer reviews reported court dates, send checklist, retainer check) and per-stage tasks. Workflow targets are business days and firm-editable; any task that touches a legal rule is a lawyer task pointing at a rule reference.
- **Billing:** retainer + hourly by default; hourly and flat fee offered; contingency withheld behind `rules.fee_agreement_terms`; retainer floor from firm settings; trust movements behind `rules.trust_accounting`.

## Texas rules: references only (lawyer tools, never client advice)
| Reference | Gate |
|---|---|
| Divorce waiting-period calculator | `rules.all-engines.family.divorce_waiting_period` |
| Residency and venue check | `rules.all-engines.family.residency_venue` |
| Answer date after service | `rules.court_deadlines` (shared) |
| Protective-order hearing / temporary-order timing | `rules.all-engines.family.protective_order_timing` |
| Child-support guideline calculator | `rules.all-engines.family.child_support_guidelines` |
| Standard parenting-time schedule | `rules.all-engines.family.possession_schedule` |
| Modification timing and grounds | `rules.all-engines.family.modification_eligibility` |
| Enforcement time limits | `rules.limitation_periods` (shared) |
| Statutory notices and forms | `rules.all-engines.family.statutory_forms` |

The pack holds **no** periods, percentages or form text (a test fails if any "N days/months/years" appears). The engine that owns each tool must call `requireApproval(gateKey)` and keep the values in its own gated config; results are proposed to a lawyer, never told to a client.

## For the attorney reviewer
Approve per gate with `npm run compliance -- approve --gate <key> --reviewer attorney --by "<name>"`. `npm run compliance -- list` shows 61 pending `copy.all-engines.family.*` sentences and 9 rule gates. Specific questions:
1. Is the question order right (safety → names → children → orders → case) and is anything asked that should wait until after engagement?
2. Is withholding contingency fees in family matters the right product default?
3. Which children/school/medical details should be collected before engagement, if any?
4. Wording of the safety notice and the response to a safety signal.
5. Whether children should ever be indexed for conflicts.
