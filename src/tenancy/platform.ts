// Platform-level (NOT tenant-scoped) reads, following the same narrow-export
// precedent as ./firms.ts. `compliance_approvals` records attorney / CPA /
// vendor-DPA / founder sign-offs on the product's own wording, rules and
// vendors — it belongs to no firm, so there is no tenantId to pass to
// withTenant(). This export is read-only and returns only that table.

import { rawDb } from "./db";
import { complianceApprovals } from "@/db/tables/foundation";

export type ComplianceApprovalRow = typeof complianceApprovals.$inferSelect;

export async function listComplianceApprovals(): Promise<ComplianceApprovalRow[]> {
  return rawDb.select().from(complianceApprovals);
}
