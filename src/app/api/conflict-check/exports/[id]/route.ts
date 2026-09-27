import { conflictRoute, downloadResponse } from "@/app/api/conflict-check/_lib/route";
import { downloadExport } from "@/engines/conflict-check/logService";
import { assertUuidParam } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** Download a generated export (requester only, until the link expires). 202 while it is being built. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return downloadResponse(
    await conflictRoute("GET /api/conflict-check/exports/[id]", req, ({ tx, tenantId, access }) =>
      downloadExport(tx, { tenantId, exportId: assertUuidParam(id, "export id"), access })
    )
  );
}
