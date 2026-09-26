// Client-facing billing wording. PLACEHOLDERS ONLY.
//
// Every message a client reads about money (replenishment requests, payment
// reminders, refund letters) is the firm's own voice and its own liability,
// and the line between a neutral notice and a threat of withdrawal sits in the
// wording. So the product ships no real copy here: each key holds a clearly
// marked placeholder, and `approvedClientCopy()` refuses to return text until
// gate "client_copy_billing" is approved and the firm has supplied its own
// attorney-reviewed wording (firm_config_versions.config.billing.copy).

import { requireGates, type GateRegistry, COMPLIANCE_GATES } from "./approvals";

export type BillingCopyKey =
  | "retainer_replenishment_request" // c50
  | "retainer_early_warning" // c50
  | "installment_reminder" // c52
  | "installment_missed" // c52
  | "invoice_sent" // c79
  | "invoice_reminder" // c81
  | "refund_letter"; // c82

/** Facts each template may use. Deliberately minimal (c51: no case facts in email). */
export const COPY_FIELDS: Record<BillingCopyKey, string[]> = {
  retainer_replenishment_request: ["currentBalance", "minimumBalance", "amountNeeded", "portalLink"],
  retainer_early_warning: ["currentBalance", "minimumBalance", "portalLink"],
  installment_reminder: ["amountDue", "dueDate", "portalLink"],
  installment_missed: ["amountDue", "dueDate", "portalLink"],
  invoice_sent: ["invoiceNumber", "amountDue", "dueDate", "portalLink"],
  invoice_reminder: ["invoiceNumber", "amountDue", "dueDate", "portalLink"],
  refund_letter: ["refundAmount", "trustBalanceBefore", "finalInvoiceNumber"],
};

export const PLACEHOLDER_COPY: Record<BillingCopyKey, string> = {
  retainer_replenishment_request:
    "[PLACEHOLDER: attorney-approved replenishment request wording. Neutral; no mention of withdrawal unless the lawyer approved it for this matter.]",
  retainer_early_warning: "[PLACEHOLDER: attorney-approved low-balance early warning wording.]",
  installment_reminder: "[PLACEHOLDER: attorney-approved upcoming installment reminder wording.]",
  installment_missed: "[PLACEHOLDER: attorney-approved missed installment notice wording. Polite and factual.]",
  invoice_sent: "[PLACEHOLDER: attorney-approved new invoice notice wording.]",
  invoice_reminder: "[PLACEHOLDER: attorney-approved payment reminder wording. Polite, factual, never threatening.]",
  refund_letter: "[PLACEHOLDER: attorney-approved refund letter template, produced by the Document engine (c85).]",
};

export function isPlaceholder(text: string): boolean {
  return text.trim().startsWith("[PLACEHOLDER");
}

/**
 * Returns the firm's approved wording for `key`, or throws. Callers that send
 * anything to a client must go through this function.
 */
export function approvedClientCopy(
  key: BillingCopyKey,
  firmCopy: Partial<Record<BillingCopyKey, string>> | undefined,
  registry: GateRegistry = COMPLIANCE_GATES
): string {
  requireGates(["client_copy_billing"], `send client message "${key}"`, registry);
  const text = firmCopy?.[key];
  if (!text || isPlaceholder(text)) {
    throw new Error(`No firm-approved wording configured for "${key}". Placeholder copy is never sent.`);
  }
  return text;
}
