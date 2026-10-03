import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam } from "@/engines/document/http";
import { proposeMatterRetention } from "@/engines/document/retention/service";
import { DocumentError } from "@/engines/document/errors";

export const dynamic = "force-dynamic";

/**
 * c84/c90 — PROPOSED destruction-review dates for a matter's files, from the
 * firm's retention rules. Gated on rules.retention_periods (423 until an
 * attorney approves). Proposes only; nothing is scheduled or deleted.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return documentRoute("GET /api/document/matters/[matterId]/retention", async (c) => {
    if (!c.viewer.permissions.includes("documents.approve") && !c.viewer.permissions.includes("settings.manage")) {
      throw new DocumentError("Only an attorney or firm admin can review retention.", 403);
    }
    return proposeMatterRetention(c.tx, c.tenantId, assertUuidParam(matterId, "matter id"));
  });
}
