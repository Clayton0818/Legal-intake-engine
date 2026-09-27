// Server-only: approvals from the platform-level `compliance_approvals` table.
// The app role can only SELECT that table; sign-offs are recorded by an
// operator through src/compliance/cli.ts with the elevated migrations role.

import type { ApprovalRecord, ApprovalSource, ReviewerKind } from "./approvals";

export class DbApprovalSource implements ApprovalSource {
  readonly name = "database";

  async load(): Promise<ApprovalRecord[]> {
    // Lazy import so merely importing this file never opens a connection
    // (src/tenancy/db.ts throws at import time without DATABASE_URL).
    const { listComplianceApprovals } = await import("@/tenancy/platform");
    const rows = await listComplianceApprovals();
    return rows.map((row) => ({
      gateKey: row.gateKey,
      reviewerKind: row.reviewerKind as ReviewerKind,
      approvedByName: row.approvedByName,
      approvedAt: row.approvedAt,
      notes: row.notes,
      approvedText: row.approvedText,
      draftHash: row.draftHash,
      revokedAt: row.revokedAt,
    }));
  }
}
