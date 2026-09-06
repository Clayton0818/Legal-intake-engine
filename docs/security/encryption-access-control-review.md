# Encryption & Access Control Review

**Board card:** `c9` — Encryption & access control review
**Track:** Security
**Status:** Research and recommended approach. This is engineering/security guidance informed by public standards and public summaries of professional-responsibility ethics opinions — **not legal advice**. Sections referencing bar rules or ethics opinions should go to the same licensed attorney reviewing `c1`, `c2`, `c8`, and `c26` before anything here is relied on operationally.
**Depends on / builds on:** `c2` (data privacy & retention policy), `c8` (multi-tenant architecture & data isolation)
**Feeds into:** `c18` (technology stack ADR), `c19` (core data model), `c6` (audit log), `c10` (terms of service / AI disclosures)

---

## 1. Why this card matters for this product specifically

Most SaaS products treat encryption and access control as generic hygiene. Three things make it higher-stakes here:

1. **The data is privileged, not just personal.** Intake conversations routinely contain the same category of information that would be privileged if the caller had already retained the firm — case facts, health details, immigration status, family circumstances. `c2` (data privacy & retention policy) already established that attorney-client privilege can attach to pre-engagement consultations under the "prospective client" doctrine (ABA Model Rule 1.18) even before a firm decides to take the matter. A confidentiality or access-control failure here is not just a privacy incident; it risks being a privilege waiver and a bar-discipline matter simultaneously.
2. **Multi-tenancy raises the stakes of any access-control bug.** `c8` recommended a pooled, shared-schema-plus-Row-Level-Security architecture for cost and operational reasons, with `tenant_id` as a first-class scoping requirement everywhere. That recommendation is conditional on access control actually being airtight — RLS is a *data*-layer isolation mechanism, but it does nothing if an application-layer bug, an over-privileged service account, or a support tool lets one firm's staff query another firm's matters. Tenant firms using this product can also be adverse to each other (opposing counsel on the same case), which is a threat model ordinary B2B SaaS multi-tenancy doesn't usually have to consider.
3. **Lawyers have an affirmative, evolving competence duty here, not just a data-processor obligation.** ABA Model Rule 1.6(c) requires a lawyer to "make reasonable efforts to prevent the inadvertent or unauthorized disclosure of, or unauthorized access to, information relating to the representation of a client." ABA Formal Opinion 483 (2018) extended this into an affirmative duty to *monitor* for breaches, not just to build preventive controls, and to notify clients when a breach involves material confidential information or significantly impairs the lawyer's ability to perform legal services. Because firms are relying on this product as part of "the representation," this product's security posture is effectively downstream of every subscribing attorney's own Rule 1.6(c) obligations — a security gap here becomes an ethics problem for every firm on the platform, not just a vendor incident for us.

Texas Disciplinary Rule 1.05 (confidentiality), notably, does **not** itself specify technical safeguards — it governs when disclosure is permitted, not how data must be secured technically. The technical-safeguard expectations come from Model Rule 1.6(c) (adopted with Texas-specific numbering and some variation — the exact current Texas text needs attorney confirmation since Texas's rules were amended in 2025) and from opinions interpreting it, not from Rule 1.05 itself. This review does not attempt to resolve the exact current Texas rule text; that confirmation belongs to the `c1`/`c26` attorney review.

---

## 2. Threat model (summary)

| Threat | Primary control |
|---|---|
| Data intercepted in transit (network eavesdropping, MITM) | TLS everywhere, cert pinning for mobile/native clients if built |
| Data exfiltrated from storage (stolen backup, compromised disk, misconfigured bucket) | Encryption at rest, encrypted backups, restrictive storage ACLs |
| One tenant firm's staff or systems accessing another tenant's data | RLS (per `c8`) + application-layer tenant scoping + access control enforced at every layer, not just the database |
| Compromised internal (our) staff or support-tool credentials used for cross-tenant snooping | No standing cross-tenant access; break-glass only, logged, time-boxed, and itself an auditable event (feeds `c6`) |
| Compromised firm-side account (phished attorney/staff login) used to access matters outside that person's assignment | Role-based access control scoped within the tenant, MFA, session controls |
| AI/LLM vendor retaining or training on privileged intake content | Vendor contractual controls (ties to `c2`'s DPA recommendation) plus technical controls (no client data in prompts sent to a training-enabled endpoint, redaction where feasible) |
| Credential/key compromise (leaked API key, database credential, encryption key) | Centralized secrets management, key rotation, least-privilege service accounts, no long-lived credentials in code or config |
| Insider threat with legitimate access misusing it | Audit logging (hand-off to `c6`), anomaly detection as a later-phase control, not a v1 blocker |

---

## 3. Encryption requirements

### 3.1 Encryption in transit

- **TLS 1.3 as the floor for all external traffic** (client ↔ API, any browser-facing surface, webhook endpoints). TLS 1.2 may be accepted only as a compatibility fallback if a specific integration partner requires it, and that exception should be logged and revisited, not silently permanent.
- **Internal service-to-service traffic should also be encrypted**, not just the public edge — mutual TLS (mTLS) between internal services is the recommended default once the stack decision (`c18`) picks a deployment topology that supports it (e.g., a service mesh or a managed mTLS layer), rather than trusting an internal network boundary as the security perimeter. "Internal network = trusted" is not a safe assumption in a multi-tenant system handling privileged data.
- **Database connections must use TLS**, including for any pooled connection layer — this is directly relevant to the connection-pooling caveat `c8` already flagged (a pooler that terminates TLS incorrectly or multiplexes connections without care is also where tenant-scoping session variables can leak).

### 3.2 Encryption at rest

- **NIST SP 800-53 Rev. 5 control SC-28** ("Protection of Information at Rest") is the relevant federal baseline reference even though this product isn't itself subject to FedRAMP; its SC-28(1) enhancement — cryptographic protection of data at rest — is a reasonable minimum bar to hold this product to given the sensitivity of the data. Concretely: full-disk/volume encryption on all storage, database-level encryption (transparent data encryption or equivalent) at minimum, with application-layer (field-level) encryption reserved for the highest-sensitivity fields (see below).
- **Backups must be encrypted with the same or stronger standard as production data**, and backup access must go through the same access-control review as production access — a common gap is treating backups as lower-risk because they're "just for disaster recovery."
- **Field-level (application-layer) encryption should be considered, not assumed unnecessary, for the narrowest, highest-sensitivity fields** — e.g., anything the intake spec (`c12`'s `question-bank.yaml`) flags with a PII classification indicating health, immigration status, or minors' information. Field-level encryption adds real engineering cost (searchability, indexing, and key-management complexity all get harder), so this should be scoped narrowly and decided jointly with `c19` (data model) rather than applied blanket. Recommendation: default to strong storage-level encryption for everything, and evaluate field-level encryption only for the specific fields the `c19` data model owner and this review agree carry the highest re-identification or privilege risk.
- **Algorithm baseline:** AES-256 (or the stack's equivalent modern authenticated-encryption cipher, e.g. AES-256-GCM) for symmetric encryption; avoid rolling custom cryptography — use the encryption primitives provided by the chosen cloud provider's KMS or a well-maintained library, not a hand-rolled implementation.

### 3.3 A timing note worth flagging now: FIPS 140-2 → 140-3

NIST's Cryptographic Module Validation Program (CMVP) moves FIPS 140-2-validated module certificates from "Active" to "Historical" status on **September 21, 2026** — a few weeks from when this review is being written. This isn't a hard "everything breaks" cliff (historical-status modules keep functioning), but it matters for a vendor-selection decision landing this close to the date:

- If `c18`'s eventual stack choice includes any component whose FIPS validation matters (e.g., a government or highly-regulated-sector customer segment later, or a cloud provider's compliance posture), the stack ADR should confirm the provider's KMS/HSM offering is already using FIPS 140-3-validated modules, not 140-2, since new deployments after the transition should not be built on soon-to-be-historical validation.
- This product is not currently targeting government clients, so FIPS validation itself is not a hard requirement today — it's flagged here so it isn't accidentally locked in via a vendor choice made in `c18` without anyone noticing the timing.

### 3.4 Key management

- Use a managed KMS (cloud-provider-native, e.g., AWS KMS/GCP Cloud KMS/Azure Key Vault, or an equivalent once `c18` picks a provider) rather than self-managed key storage. Self-hosting an HSM or key-management layer is not justified at this product's current stage.
- **Envelope encryption**: data-encryption keys generated per record/tenant class and themselves encrypted by a master key held in the KMS, so key rotation doesn't require re-encrypting all data.
- **Key rotation** on a defined schedule (commonly annual for master keys, more frequent for data keys depending on the KMS's native rotation support) — this should be a configured KMS policy, not a manual process.
- **Separation of duties**: the people/roles who can administer the KMS (create/rotate/disable keys) should not be the same standing role as those with day-to-day data access — this ties into the RBAC model in Section 4.
- If a per-tenant encryption key strategy is adopted (stronger isolation, more operational complexity — a real option worth `c18`/`c19` weighing against the shared-schema RLS model `c8` recommended), that decision should be made explicitly rather than defaulting into either approach.

---

## 4. Access control

### 4.1 Model: RBAC scoped within tenant, no standing cross-tenant access

This section assumes and builds on `c8`'s architecture recommendation (pooled multi-tenant, RLS-enforced, `tenant_id` as a universal scoping key). Access control here has two distinct layers that must both hold:

1. **Tenant-boundary access control** — no user or service, internal or firm-side, gets standing access across tenants. `c8` already established this for internal staff ("break-glass only, no standing cross-tenant access"); this review confirms that requirement and extends it to every service account and integration, not just human staff.
2. **Within-tenant role-based access control** — inside a given firm's tenant, not everyone should see everything. Recommended baseline roles (firm-configurable, matching the `firm-config.example.yaml` pattern established in `c12`'s spec):
   - **Firm Admin** — manages firm users, configuration, integrations; not necessarily broader data access than Attorney/Staff roles by default.
   - **Attorney** — full access to matters and intake records within the firm.
   - **Intake Staff** — access scoped to active intake records; the data model (`c19`) should support restricting staff access to matters *not yet* assigned to a specific attorney if a firm wants that boundary, since some firms will want staff triage without full matter visibility.
   - **Read-only / Reporting** — for firm roles that need visibility (e.g., office manager) without edit rights.
   - **API/Integration service account** — scoped to the specific fields and operations a given practice-management integration (`c5`) actually needs, not a blanket firm-admin-equivalent token.

   This is a recommended starting taxonomy, not a final one — `c19` (data model) is where these roles become real enforceable entities, and firms will likely need to customize labels the same way the board's own columns are firm-configurable (per `c14`'s pattern). The requirement this review is setting is the *shape* (least-privilege, role-scoped, firm-configurable) not the literal role names.

3. **Internal (our) staff access is a third, more restrictive tier**: no standing per-tenant access at all. Support and engineering access to a specific tenant's data should require a break-glass workflow — explicit justification, time-boxed grant, and an audit log entry (feeding `c6`) — not a permanently-provisioned admin account that happens to span tenants.

### 4.2 Authentication

- **Multi-factor authentication (MFA) should be required, not optional, for all firm-side accounts with write access to matter data**, and for all internal staff accounts entirely. This is a stronger stance than "offer MFA" — given the privilege exposure discussed in Section 1, password-only auth is not an adequate baseline for this product category.
- **Service-to-service authentication** should use short-lived credentials (OAuth2 client-credentials flow with short token TTLs, or mTLS client certificates) rather than long-lived static API keys, wherever the stack (`c18`) supports it without disproportionate complexity.
- Session timeout and re-authentication policies should be firm-configurable within a secure default (e.g., a default idle timeout in the 15–30 minute range for staff sessions handling matter data), consistent with handling privileged information, while recognizing intake staff may need longer active sessions during a live conversation — this is a product/UX tradeoff for `c12`'s flow owner and this review to reconcile, not purely a security-team call.

### 4.3 Authorization enforcement — defense in depth, not just RLS

`c8` was explicit that RLS has real gaps (`BYPASSRLS`/superuser bypass, and connection-pooling session-variable leakage) and that **application-level scoping stays mandatory even with RLS enabled**. This review reinforces that as a hard requirement, not a nice-to-have: every data access path (API layer, any admin/support tooling, any reporting/export feature, any AI/LLM call that reads matter data) must independently enforce tenant and role scoping, so that a single-layer failure — a missing `WHERE tenant_id = ...` clause, a misconfigured RLS policy, a support tool built without scoping — is not sufficient on its own to leak data across tenants or roles.

### 4.4 The AI/LLM layer specifically

Building on `c2`'s citation of ABA Formal Opinion 512 (generative AI, 2024) and its warning about cross-tenant leakage through self-learning models:

- Any LLM/AI provider used for classification (`c13`) or conversation (`c12`) must be contractually and technically prevented from training on submitted data, or from retaining it beyond the operationally necessary window — this is the same requirement `c2` flagged for the vendor DPA, restated here as an access-control/architecture requirement: the AI call itself is a data-access event and needs the same tenant-scoping discipline as a database query.
- Prompts sent to the LLM should be constructed so they cannot accidentally include another tenant's context (e.g., via a shared conversation cache, shared embeddings, or shared fine-tuning) — this is an architecture requirement for whoever builds `c13`, not just a vendor-contract question.

---

## 5. Audit logging — hand-off, not a duplicate deliverable

Access control is only as trustworthy as the ability to verify it after the fact. Every authentication event, every cross-tenant break-glass access, every role change, and every data export should be logged immutably. This review treats the *requirements* for what must be logged as in scope; the audit log system itself is `c6`'s deliverable ("Audit log & compliance trail"), and this section is the handoff: `c6` should treat every access-control event enumerated in Sections 4.1–4.3 as a required log event, not derive its own list independently.

---

## 6. What this review does not decide

- **No technology stack or vendor is chosen here.** This constrains `c18` (e.g., "the KMS must support envelope encryption and native rotation," "the deployment topology should support mTLS between services") without picking a cloud provider.
- **No final RBAC schema.** `c19` (data model) is where roles, permissions, and scoping become real schema and enforcement code.
- **No resolution of the Texas Rule 1.6(c)-equivalent exact current text** — flagged for the `c1`/`c26` attorney review, not resolved here.
- **No SOC 2 / independent audit commitment.** Worth raising as a future go-to-market requirement once the product has paying firm customers who will ask for it (likely relevant to `c30`, pilot-firm conversations, and `c7`, pricing/packaging, since some firms will treat SOC 2 as a purchase gate) — out of scope for this review, which is about the underlying controls, not the compliance certification built on top of them.

---

## 7. Open questions for human review

1. **Field-level encryption scope** — which specific fields (per `c12`'s `question-bank.yaml` PII classifications) justify the added complexity of application-layer encryption, versus relying on strong storage-level encryption alone? Needs a joint call with whoever builds `c19`.
2. **Per-tenant vs. shared encryption keys** — real tradeoff between isolation strength and operational complexity; not resolved here, needs a decision alongside `c18`/`c19`.
3. **Exact current Texas Rule 1.6(c)-equivalent text and any Texas-specific technology-competence guidance** post the 2025 rule amendments referenced in the `c1` PR — needs attorney confirmation, since this review relied on the general ABA Model Rule text and public secondary summaries rather than the current official Texas rule text.
4. **Session-timeout defaults for intake staff** — the tradeoff between security (short timeout) and usability during live intake conversations (Section 4.2) is a product decision as much as a security one.
5. **Whether SOC 2 Type II is a near-term goal** — affects how much of this review's recommendations need to be formalized into auditable policy now versus later (Section 6).

---

## Sources

- ABA Model Rule 1.6(c) and its "reasonable efforts" factors — summarized via [Petronella Cybersecurity: Law Firm Cybersecurity, ABA 1.6(c) Compliance Guide](https://petronellatech.com/blog/cybersecurity-for-law-firms-aba-compliance-and-data-protection-guide/) and [IADC: Safeguarding Client Data — Attorneys' Legal and Ethical Duties](https://www.iadclaw.org/assets/1/7/7_(ETHICS)_Ries_Safeguarding_Client_Data.pdf)
- ABA Formal Opinion 483 (2018), data breach obligations — summarized via [National Law Review: Formal Opinion 483](https://natlawreview.com/article/formal-opinion-483-aba-s-new-breach-notification-obligations-lawyers-and-law-firms)
- Texas Disciplinary Rule of Professional Conduct 1.05 (Confidentiality of Information) — [University of Houston Law Center, TRPC 1.05](https://www.law.uh.edu/libraries/ethics/trpc/1.05.html); Texas rule amendments context from the `c1` PR's citation of [Approval of Amendments to Texas Disciplinary Rules of Professional Conduct (2025)](https://www.sos.state.tx.us/texreg/archive/March212025/In%20Addition/202500834-1.pdf)
- NIST SP 800-53 Rev. 5, control SC-28 (Protection of Information at Rest) — [CSF Tools: SC-28](https://csf.tools/reference/nist-sp-800-53/r5/sc/sc-28/)
- FIPS 140-2 → 140-3 CMVP transition, September 21, 2026 sunset of Active status — [AMP Inc: FIPS 140-2 Expiration Date 2026](https://ampinc.com/fips-140-2-expiration-date-2026/)
- Role-based access control / least privilege framing — [Security Boulevard: Designing Least Privilege Access Using IAM and RBAC](https://securityboulevard.com/2026/08/designing-least-privilege-access-using-iam-and-rbac/)
- ABA Formal Opinion 512 (generative AI, 2024) — as previously cited and summarized in the `c2` PR (data privacy & retention policy); not re-fetched independently for this review, cross-referenced for consistency.
