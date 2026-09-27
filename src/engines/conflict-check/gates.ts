// Approval gates owned by the Conflict-check engine (c56, c59, c61, c62, c63, c97).
//
// Nothing here is approved. Until a reviewer signs off (npm run compliance --
// approve …), client-facing wording renders as a visible
// "[PENDING ATTORNEY REVIEW …]" placeholder and gated actions are blocked and
// logged. Drafts below are PROPOSALS for the reviewing Texas attorney, not
// approved wording.
//
// Shared gates reused (never redefined here):
//   rules.conflicts          (RULE_GATES.conflictRules)   — the c55 rule table: waivability, definite vs possible
//   rules.retention_periods  (RULE_GATES.retentionPeriods) — purge of declined-inquiry narrative (c62 / c2)
//   vendor.esignature        (VENDOR_GATES.esignature)    — sending waivers for signature (c59)
//   vendor.email             (via src/core/notify.ts)     — every email this engine queues
//   vendor.ai_model          (VENDOR_GATES.aiModel)       — AI screening of lateral entries (not called yet)

import { defineGate } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";

export { RULE_GATES, VENDOR_GATES };

export const CONFLICT_COPY_GATES = {
  /** c59 §4.1.4 — neutral message while a conflicts review is pending. */
  pendingReview: defineGate({
    key: "copy.conflict-check.pending_review",
    cardIds: ["c59"],
    reviewers: ["attorney"],
    description:
      "Neutral message to a prospective client while an internal conflicts review is pending (must not reveal any party, other matter, or the word 'conflict' unless approved)",
    draft:
      "Thank you for your patience. Before {firmName} can take the next step, we need to complete an internal review. " +
      "We will be in touch as soon as it is finished.",
  }),
  /** c59 §4.4.3 — minimal email/in-app notice that a document needs the client's signature. */
  waiverSignatureRequest: defineGate({
    key: "copy.conflict-check.waiver_signature_request",
    cardIds: ["c59"],
    reviewers: ["attorney"],
    description: "Minimal notice that a document is waiting for the client's signature (no content in the email)",
    draft:
      "Subject: A document from {firmName} needs your signature\n\n" +
      "A document is waiting for your review and signature in your secure client portal: {portalUrl}",
  }),
  /** c59 §4.4.1 — skeleton of the written-consent waiver; the conflicts attorney completes each client's copy. */
  waiverTemplate: defineGate({
    key: "copy.conflict-check.waiver_template",
    cardIds: ["c59"],
    reviewers: ["attorney"],
    description:
      "Written-consent (conflict waiver) template: 'informed consent' / 'confirmed in writing' under the Texas rules as adopted Oct 1, 2024; must not disclose another client's confidential information",
    draft:
      "CONSENT TO REPRESENTATION\n\n" +
      "Client: {clientName}\nFirm: {firmName}\nDate: {date}\n\n" +
      "[The conflicts attorney describes here, for this client only, the circumstances this client is entitled to know, " +
      "the material risks, and the reasonably available alternatives.]\n\n" +
      "I have read this document, had the opportunity to ask questions and to consult another lawyer, and I consent.\n\n" +
      "Client signature: ____________________   Date: __________\n" +
      "For the firm: ____________________   Date: __________",
  }),
  /** c62 — the neutral non-engagement letter. The template has NO field for conflict, other parties or case facts. */
  nonEngagementLetter: defineGate({
    key: "copy.conflict-check.non_engagement_letter",
    cardIds: ["c62"],
    reviewers: ["attorney"],
    description:
      "Neutral non-engagement letter: firm will not represent; no attorney-client relationship formed; time limits may apply so consult another lawyer promptly; no opinion on the merits (never mentions a conflict or any other person)",
    draft:
      "{date}\n\nDear {prospectName},\n\n" +
      "Thank you for contacting {firmName} on {contactDate}. After review, {firmName} is not able to represent you in this matter.\n\n" +
      "No attorney-client relationship has been formed between you and {firmName}, and we have not given you any opinion about your matter or its merits.\n\n" +
      "Legal matters can be affected by time limits. If you wish to pursue this matter, you should promptly consult another lawyer.\n\n" +
      "{referralBlock}" +
      "Sincerely,\n{firmName}",
  }),
  /** c62 §4.2.3 — optional referral paragraph appended to the letter. */
  nonEngagementReferral: defineGate({
    key: "copy.conflict-check.non_engagement_referral",
    cardIds: ["c62"],
    reviewers: ["attorney"],
    description: "Optional referral paragraph in the non-engagement letter (no legal commentary or deadline estimates)",
    draft: "If it helps, you may contact {referralName} ({referralContact}) to find another lawyer.\n\n",
  }),
  /** c62 §4.3 — minimal email telling the prospect a letter is available through the secure link. */
  nonEngagementNotice: defineGate({
    key: "copy.conflict-check.non_engagement_notice",
    cardIds: ["c62"],
    reviewers: ["attorney"],
    description: "Minimal email to a prospect that a letter from the firm is available at a secure link (no content in the email)",
    draft: "Subject: A letter from {firmName}\n\nA letter from {firmName} is available for you here: {portalUrl}",
  }),
  /** c61 §4.2.2 — instruction on the lateral-hire prior-matter form. */
  lateralFormInstructions: defineGate({
    key: "copy.conflict-check.lateral_form_instructions",
    cardIds: ["c61"],
    reviewers: ["attorney"],
    description:
      "Instruction to a new hire listing prior matters: names and general subject only; how much a lateral may disclose (Rule 1.05 / 1.10)",
    draft:
      "List each matter you worked on at a previous firm: the client name(s), the adverse party name(s), a general subject " +
      "(for example 'divorce' or 'custody modification'), your role and approximate years. Do NOT enter facts, strategy, " +
      "amounts or any other confidential information.",
  }),
  /** c97 §4.1 — instruction on the lawyer's private disclosure list. */
  interestFormInstructions: defineGate({
    key: "copy.conflict-check.interest_form_instructions",
    cardIds: ["c97"],
    reviewers: ["attorney"],
    description:
      "Instruction on a lawyer's private interest-disclosure list (which business, family and financial interests must be listed under Rules 1.06(b)(2) and 1.08)",
    draft:
      "List businesses you own or help run, boards you sit on, close family relationships and investments that could affect " +
      "your independent judgment. Do not enter amounts. Only you and the firm's conflicts attorney can see this list.",
  }),
} as const;

export const CONFLICT_RULE_GATES = {
  /**
   * c59 §4.3.5 / open question 2 — may a conflicts attorney override the rule
   * table's "not waivable" result ("rule table does not fit these facts")?
   * Until approved, a not-waivable result is a HARD block on 'proceed with
   * consent' (the spec's recommended pilot behaviour).
   */
  ruleTableOverride: defineGate({
    key: "rules.conflict-check.rule_table_override",
    cardIds: ["c59"],
    reviewers: ["attorney", "founder_decision"],
    description: "Allow a logged override of the rule table's 'not waivable' result (otherwise a hard block)",
  }),
  /** c63 §9 — what conflict records may go to a malpractice insurer or the bar. Gates 'full' (named) exports. */
  exportDisclosure: defineGate({
    key: "rules.conflict-check.export_disclosure",
    cardIds: ["c63"],
    reviewers: ["attorney"],
    description: "Which conflict records (with party names) may be disclosed to insurers or in a bar inquiry",
  }),
  /**
   * c56 §9.1 / c62 §4.4 — keeping prospective-client and third-party names
   * indefinitely for conflicts, and removing an index entry after a deletion
   * request. Removal of an entry is blocked until approved (keeping is the
   * fail-safe for conflict checking).
   */
  indexRetention: defineGate({
    key: "rules.conflict-check.index_retention",
    cardIds: ["c56", "c62"],
    reviewers: ["attorney"],
    description:
      "Retention of prospective-client and third-party names in the conflicts index, and the conflicts-retention override for deletion requests (Rule 1.18, TDPSA)",
  }),
  /** c61 §9 — which nonlawyer staff must be checked, and screening conditions under Rule 1.10. */
  lateralScreening: defineGate({
    key: "rules.conflict-check.lateral_screening",
    cardIds: ["c61"],
    reviewers: ["attorney"],
    description: "Rule 1.10 screening conditions and notices for lateral hires, and how the rules apply to nonlawyer staff",
  }),
} as const;

export const CONFLICT_GATE_KEYS = [
  ...Object.values(CONFLICT_COPY_GATES),
  ...Object.values(CONFLICT_RULE_GATES),
].map((g) => g.key);
