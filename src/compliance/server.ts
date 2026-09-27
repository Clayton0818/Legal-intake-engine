// Server-side approval loading for API routes, server components and scripts.
//
//   await ensureServerApprovals();   // at the start of a request
//   legalCopy("copy.intake.ai_disclosure");  // now reflects compliance_approvals
//
// Loads the shared gates, points the approval snapshot at the database
// (compliance_approvals) and refreshes it at most once a minute. If the
// database cannot be read, EVERY gate is treated as pending (fail safe) and
// the error is logged — a request never proceeds on a stale "approved".

import "./gates";
import { ensureApprovalsLoaded, getApprovalSource, setApprovals, setApprovalSource } from "./approvals";
import { DbApprovalSource } from "./dbApprovalSource";

export async function ensureServerApprovals(maxAgeMs = 60_000): Promise<void> {
  if (!(getApprovalSource() instanceof DbApprovalSource)) setApprovalSource(new DbApprovalSource());
  try {
    await ensureApprovalsLoaded(maxAgeMs);
  } catch (err) {
    setApprovals([]);
    console.error(
      `[compliance] could not load approvals — treating every gate as pending: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
