// c48 — assignment: preview/history (internal), run auto-assignment, supervisor override.
import { tenantRoute } from "@/tenancy/route";
import { getAssignmentHistory, overrideAssignment, previewAssignment, runAutoAssignment } from "@/engines/intake/assignment/service";
import { SUPERVISOR_ROLES } from "@/engines/intake/common/actors";
import { readJson, requireActingStaff, requireActingUserId, str, uuid } from "../../../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("GET /api/intake/matters/[id]/assignment", async ({ tx, tenantId }) => {
    // Routing logic and workload data are internal only (c48 rule 10).
    await requireActingStaff(tx, tenantId, req);
    const matterId = uuid(id, "matter id");
    return { preview: await previewAssignment(tx, tenantId, matterId), history: await getAssignmentHistory(tx, tenantId, matterId) };
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("POST /api/intake/matters/[id]/assignment", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req, SUPERVISOR_ROLES, "run auto-assignment");
    return runAutoAssignment(tx, { tenantId, matterId: uuid(id, "matter id"), trigger: "manual_run" });
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return tenantRoute("PUT /api/intake/matters/[id]/assignment", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    return overrideAssignment(tx, { tenantId, matterId: uuid(id, "matter id"), byUserId: requireActingUserId(req), assigneeUserId: uuid(body.assigneeUserId, "assigneeUserId"), reason: str(body, "reason") });
  });
}
