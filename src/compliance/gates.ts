// Shared approval gates used by more than one engine. Engine-specific gates
// belong in src/engines/<slug>/gates.ts; engines must REUSE these keys rather
// than defining their own gate for the same vendor or rule set.
//
// Nothing here is approved. Every gate below is closed until a reviewer's
// sign-off is recorded in `compliance_approvals` (src/compliance/cli.ts).
// Drafts are proposals for the reviewer, not approved wording.

import { defineGate } from "./approvals";

// ---------------------------------------------------------------------------
// External vendors (each is a subprocessor that needs a signed DPA before real
// client data reaches it — ADR-0001 D9, c10 §3.5). Code talks to the vendor
// only through an interface whose stub adapter records instead of sending.
// ---------------------------------------------------------------------------

export const VENDOR_GATES = {
  email: defineGate({
    key: "vendor.email",
    cardIds: ["c51", "c42", "c54"],
    reviewers: ["vendor_dpa"],
    description: "Email delivery provider (subprocessor; DPA, firm-domain sending)",
  }),
  sms: defineGate({
    key: "vendor.sms",
    cardIds: ["c42", "c51", "c65", "c67", "c70"],
    reviewers: ["vendor_dpa", "attorney"],
    description: "SMS provider (subprocessor; DPA, TCPA consent rules reviewed)",
  }),
  aiModel: defineGate({
    key: "vendor.ai_model",
    cardIds: ["c35", "c13", "c53", "c77"],
    reviewers: ["vendor_dpa"],
    description: "AI model vendor (no training on inputs, documented retention, signed DPA — ADR-0001 D9)",
  }),
  calendarSync: defineGate({
    key: "vendor.calendar_sync",
    cardIds: ["c91", "c67"],
    reviewers: ["vendor_dpa"],
    description: "Microsoft 365 / Google calendar sync",
  }),
  mailboxAccess: defineGate({
    key: "vendor.mailbox_access",
    cardIds: ["c64", "c87"],
    reviewers: ["vendor_dpa", "attorney"],
    description: "Read access to firm and lawyer mailboxes (privileged mail)",
  }),
  efiling: defineGate({
    key: "vendor.efiling",
    cardIds: ["c86", "c64"],
    reviewers: ["vendor_dpa"],
    description: "Court e-filing provider (eFileTexas / CM-ECF)",
  }),
  paymentProcessor: defineGate({
    key: "vendor.payment_processor",
    cardIds: ["c80", "c67", "c52"],
    reviewers: ["vendor_dpa", "cpa"],
    description: "Card / bank payment processor (trust-safe; fees never from trust; PCI)",
  }),
  esignature: defineGate({
    key: "vendor.esignature",
    cardIds: ["c4", "c39", "c41", "c59"],
    reviewers: ["vendor_dpa"],
    description: "E-signature provider",
  }),
  objectStorage: defineGate({
    key: "vendor.object_storage",
    cardIds: ["c84", "c49"],
    reviewers: ["vendor_dpa", "founder_decision"],
    description: "Document object storage and virus scanning (storage ADR addendum)",
  }),
  voice: defineGate({
    key: "vendor.voice",
    cardIds: ["c65"],
    reviewers: ["vendor_dpa", "attorney"],
    description: "Phone / call-recording provider (recording-consent rules reviewed)",
  }),
  accountingExport: defineGate({
    key: "vendor.accounting_export",
    cardIds: ["c83"],
    reviewers: ["vendor_dpa", "cpa"],
    description: "QuickBooks Online / Xero export",
  }),
} as const;

// ---------------------------------------------------------------------------
// Legal / accounting rule sets shared across engines. Code that APPLIES one of
// these rules calls requireApproval(key) first. Rule VALUES (tables, periods)
// belong in the engine's own gated config, never hard-coded as settled law.
// ---------------------------------------------------------------------------

export const RULE_GATES = {
  trustAccounting: defineGate({
    key: "rules.trust_accounting",
    cardIds: ["c75", "c50", "c52", "c76", "c80", "c82", "c67", "c68"],
    reviewers: ["attorney", "cpa"],
    description: "Texas trust-account (IOLTA) rules — any movement of trust money",
  }),
  conflictRules: defineGate({
    key: "rules.conflicts",
    cardIds: ["c55", "c3", "c58", "c59", "c60"],
    reviewers: ["attorney"],
    description: "Texas conflict-of-interest rule table (Rules 1.06, 1.09, 1.10, 1.18)",
  }),
  courtDeadlines: defineGate({
    key: "rules.court_deadlines",
    cardIds: ["c92", "c64", "c44"],
    reviewers: ["attorney"],
    description: "Court-rule deadline calculations (incl. TRCP 21a e-service timing)",
  }),
  limitationPeriods: defineGate({
    key: "rules.limitation_periods",
    cardIds: ["c93", "c105", "c66"],
    reviewers: ["attorney"],
    description: "Statute-of-limitations periods and reminder rules",
  }),
  feeAgreementTerms: defineGate({
    key: "rules.fee_agreement_terms",
    cardIds: ["c39", "c52", "c50", "c105"],
    reviewers: ["attorney"],
    description: "Fee-agreement terms (fixed fee, evergreen retainer floor, contingency)",
  }),
  retentionPeriods: defineGate({
    key: "rules.retention_periods",
    cardIds: ["c2", "c6", "c90"],
    reviewers: ["attorney"],
    description: "Record retention and destruction periods",
  }),
} as const;

// ---------------------------------------------------------------------------
// Client-facing notification wording (c51: minimal content, portal link only).
// Used by src/core/notify.ts. The first line "Subject: …" becomes the email
// subject. Tokens: {firmName}, {portalUrl}.
// ---------------------------------------------------------------------------

export const NOTIFY_COPY_GATES = {
  flagUpdate: defineGate({
    key: "notify.client.flag_update",
    cardIds: ["c51", "c42", "c46", "c49", "c50"],
    reviewers: ["attorney"],
    description: "Minimal client email/in-app text for a client-side flag",
    draft:
      "Subject: An update on your matter with {firmName}\n\n" +
      "There is an update on your matter. Please sign in to your secure client portal to view it: {portalUrl}\n\n" +
      "For your privacy, this email does not include details of your matter.",
  }),
  genericUpdate: defineGate({
    key: "notify.client.generic_update",
    cardIds: ["c54", "c51"],
    reviewers: ["attorney"],
    description: "Minimal client email announcing a new client update in the portal",
    draft:
      "Subject: New message from {firmName}\n\n" +
      "You have a new update from {firmName}. Please sign in to your secure client portal to read it: {portalUrl}",
  }),
  reminder: defineGate({
    key: "notify.client.reminder",
    cardIds: ["c42", "c46", "c52", "c81"],
    reviewers: ["attorney"],
    description: "Neutral client reminder (no legal-consequence language)",
    draft:
      "Subject: A reminder from {firmName}\n\n" +
      "There is an item waiting for you in your secure client portal: {portalUrl}",
  }),
} as const;

export const CORE_GATE_KEYS = [
  ...Object.values(VENDOR_GATES),
  ...Object.values(RULE_GATES),
  ...Object.values(NOTIFY_COPY_GATES),
].map((g) => g.key);
