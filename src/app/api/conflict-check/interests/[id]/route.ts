import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { endDisclosure } from "@/engines/conflict-check/interestService";
import { assertUuidParam } from "@/engines/conflict-check/http";

export const dynamic = "force-dynamic";

/** End an interest (it stops being matched; the record is kept). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("DELETE /api/conflict-check/interests/[id]", req, async ({ tx, tenantId, access }) => {
    const row = await endDisclosure(tx, { tenantId, disclosureId: assertUuidParam(id, "disclosure id"), access });
    return { id: row.id, active: row.active, endsOn: row.endsOn };
  });
}
