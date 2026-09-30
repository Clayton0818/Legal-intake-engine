// Approval gates owned by the Document engine (c4, c39, c40, c41, c49, c84, c85, c86, c87, c90).
//
// Nothing here is approved. Until a reviewer signs off (npm run compliance --
// approve …), client-facing wording renders as a visible
// "[PENDING ATTORNEY REVIEW …]" placeholder and gated actions are blocked
// and logged. Drafts are PROPOSALS for the reviewing Texas attorney.
//
// Shared gates reused (never redefined here):
//   vendor.object_storage   — real object storage for document bytes (c84); in-DB encrypted stub until then
//   vendor.ai_model         — OCR of scans/photos (c84) and "looks like the requested document" checks (c49)
//   vendor.esignature       — sending envelopes through a signature vendor (c4)
//   vendor.efiling          — eFileTexas / CM-ECF submission (c86)
//   vendor.mailbox_access   — reading firm mailboxes to file matter email (c87)
//   vendor.email            — every email queued through src/core/notify.ts
//   rules.fee_agreement_terms — sending an engagement agreement with fee terms (c39)
//   rules.trust_accounting  — the retainer-to-trust hand-off at engagement and trust-at-zero checks (c39, c90)
//   rules.retention_periods — destroying a closed file after its retention period (c90)
//   rules.court_deadlines   — nothing here computes a court deadline; alerts use lawyer-confirmed dates only

import { defineGate } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";

export { RULE_GATES, VENDOR_GATES };

const CLIENT_EMAIL_FOOTER = "For your privacy, this email does not include details of your matter.";

/** Client-facing wording (all attorney-reviewed). Notification copies use {firmName} and {portalUrl}; first line is the subject. */
export const DOCUMENT_COPY_GATES = {
  signatureRequest: defineGate({
    key: "copy.document.notify.signature_request",
    cardIds: ["c4", "c39"],
    reviewers: ["attorney"],
    description: "Minimal client email: a document is ready to review and sign in the portal (no document content, no fees)",
    draft:
      "Subject: A document from {firmName} is ready for you\n\n" +
      "A document from {firmName} is ready for you to review in your secure client portal: {portalUrl}\n\n" +
      CLIENT_EMAIL_FOOTER,
  }),
  reviewRequest: defineGate({
    key: "copy.document.notify.review_request",
    cardIds: ["c41"],
    reviewers: ["attorney"],
    description: "Minimal client email: please review and approve a document in the portal (no legal-consequence language)",
    draft:
      "Subject: Please review a document from {firmName}\n\n" +
      "{firmName} has a document waiting for your review in your secure client portal: {portalUrl}\n\n" +
      CLIENT_EMAIL_FOOTER,
  }),
  documentRequest: defineGate({
    key: "copy.document.notify.document_request",
    cardIds: ["c49"],
    reviewers: ["attorney"],
    description: "Minimal client email: the firm has asked for documents; upload them in the portal",
    draft:
      "Subject: {firmName} has asked for some documents\n\n" +
      "There are documents {firmName} needs from you. You can see the list and upload them in your secure client portal: {portalUrl}\n\n" +
      CLIENT_EMAIL_FOOTER,
  }),
  esignConsent: defineGate({
    key: "copy.document.esign_consent",
    cardIds: ["c4", "c39", "c41"],
    reviewers: ["attorney"],
    description:
      "Client consent to sign electronically before the first signature (Tex. Bus. & Com. Code §322.005(b) — agreement to transact electronically; paper copy on request)",
    draft:
      "I agree to review and sign documents from {firmName} electronically. I understand my electronic signature has the same effect as signing on paper, " +
      "and that I can ask {firmName} for a paper copy instead.",
  }),
  signoffStatement: defineGate({
    key: "copy.document.signoff_statement",
    cardIds: ["c41"],
    reviewers: ["attorney"],
    description: "What the client confirms when approving a document before filing (review-only, recorded approval)",
    draft: "I have reviewed version {version} of \"{documentName}\" and approve it for filing.",
  }),
  signoffReplaced: defineGate({
    key: "copy.document.signoff_replaced",
    cardIds: ["c41"],
    reviewers: ["attorney"],
    description: "Portal notice when a document the client was reviewing is replaced by a newer version",
    draft: "This document was replaced by a newer version. Please review the latest version instead.",
  }),
  agreementUpdating: defineGate({
    key: "copy.document.agreement_updating",
    cardIds: ["c39"],
    reviewers: ["attorney"],
    description: "Neutral portal notice when an unsigned engagement agreement is voided (never says why)",
    draft: "Your agreement is being updated. We will let you know when a new version is ready.",
  }),
  uploadRejected: defineGate({
    key: "copy.document.upload_rejected",
    cardIds: ["c49", "c84"],
    reviewers: ["attorney"],
    description: "Neutral message when an upload fails the virus scan or cannot be opened",
    draft: "We couldn't accept this file. Please upload it again.",
  }),
  assistantRoutesToLawyer: defineGate({
    key: "copy.document.assistant_routes_to_lawyer",
    cardIds: ["c4", "c39", "c41"],
    reviewers: ["attorney"],
    description: "What the assistant says when a client asks what a document means or whether to sign (no advice; routed to the lawyer)",
    draft: "That's a question for your lawyer. I've passed it on and they will reply to you.",
  }),
  aiDisclosureClause: defineGate({
    key: "copy.document.engagement_ai_disclosure",
    cardIds: ["c39", "c10"],
    reviewers: ["attorney"],
    description: "The firm's AI-disclosure clause inserted into every engagement agreement (c10 §4.6)",
  }),
  closingOriginalsReceipt: defineGate({
    key: "copy.document.originals_receipt",
    cardIds: ["c90"],
    reviewers: ["attorney"],
    description: "Receipt text for original documents returned to the client at closing",
    draft: "{firmName} returned the original documents listed below to {clientName} on {date}.",
  }),
} as const;

/** Legal-rule logic owned by this engine. */
export const DOCUMENT_RULE_GATES = {
  /** c41 open question 9: filing without the client's sign-off. */
  fileWithoutSignoff: defineGate({
    key: "rules.document.file_without_signoff",
    cardIds: ["c41", "c86"],
    reviewers: ["attorney"],
    description: "Whether (and when) a lawyer may file a document without the client's sign-off, with a logged reason",
  }),
  /** c4 §9 / c41 open question 11: which document types may be e-signed or click-approved. */
  electronicSignatureUse: defineGate({
    key: "rules.document.electronic_signature_use",
    cardIds: ["c4", "c39", "c41"],
    reviewers: ["attorney"],
    description: "UETA consent approach and the list of document types that may be e-signed / click-approved (Tex. Bus. & Com. Code ch. 322)",
  }),
} as const;

/** Founder decisions that change behaviour; closed until the founder records a decision. */
export const DOCUMENT_DECISION_GATES = {
  /** c39 open question 4: card says signature → retained; spec follows c68 (lawyer opens the matter). */
  signatureSetsRetained: defineGate({
    key: "decision.document.signature_sets_retained",
    cardIds: ["c39", "c68"],
    reviewers: ["founder_decision"],
    description:
      "On a fully signed engagement agreement, set the matter to 'retained' and close the intake session (card c39 wording) instead of waiting for the lawyer to open it through c68",
  }),
  /** c86: filing vendor terms and per-filing costs. */
  efilingTermsAndCosts: defineGate({
    key: "decision.document.efiling_terms_and_costs",
    cardIds: ["c86"],
    reviewers: ["founder_decision", "attorney"],
    description: "E-filing service-provider terms, per-filing costs and who pays them (reviewed before any real submission)",
  }),
} as const;

export const DOCUMENT_GATE_KEYS: readonly string[] = [
  ...Object.values(DOCUMENT_COPY_GATES),
  ...Object.values(DOCUMENT_RULE_GATES),
  ...Object.values(DOCUMENT_DECISION_GATES),
].map((g) => g.key);

/** Shared gates this engine depends on (for the admin page). */
export const DOCUMENT_SHARED_GATE_KEYS: readonly string[] = [
  VENDOR_GATES.objectStorage.key,
  VENDOR_GATES.aiModel.key,
  VENDOR_GATES.esignature.key,
  VENDOR_GATES.efiling.key,
  VENDOR_GATES.mailboxAccess.key,
  VENDOR_GATES.email.key,
  RULE_GATES.feeAgreementTerms.key,
  RULE_GATES.trustAccounting.key,
  RULE_GATES.retentionPeriods.key,
];
