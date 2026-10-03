// Approval gates the Document engine depends on (c84 now; c39–c41, c49,
// c85–c90 later).
//
// Shared gates REUSED (never redefined here):
//   vendor.object_storage   (VENDOR_GATES.objectStorage)  — any vendor storage adapter, malware
//                                                           scanner and OCR call (c84, c49). The stub
//                                                           memory/local adapters keep bytes on our own
//                                                           infrastructure and need no vendor gate.
//   rules.retention_periods (RULE_GATES.retentionPeriods) — applying a retention period to a
//                                                           matter's documents (c90 destruction review).
//
// Nothing here is approved. Drafts are proposals for the reviewing attorney,
// not approved wording.

import { defineGate } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";

export { RULE_GATES, VENDOR_GATES };

export const DOCUMENT_COPY_GATES = {
  /**
   * c84/c49 — shown to a client whose portal upload was refused (infected,
   * unreadable, wrong type, too large). Neutral; never names the reason a
   * scanner gave.
   */
  uploadRejected: defineGate({
    key: "copy.document.upload_rejected",
    cardIds: ["c84", "c49"],
    reviewers: ["attorney"],
    description: "Message to a client whose uploaded file could not be accepted",
    draft: "We couldn't accept this file. Please check it and upload it again, or contact {firmName} if the problem continues.",
  }),
} as const;

/** Every gate this engine reads, for the admin approvals page. */
export const DOCUMENT_GATE_KEYS: readonly string[] = [
  VENDOR_GATES.objectStorage.key,
  RULE_GATES.retentionPeriods.key,
  ...Object.values(DOCUMENT_COPY_GATES).map((g) => g.key),
];
