// c14 — the firm's pipeline stages (read: staff; edit: firm_admin, versioned).
import { tenantRoute, HttpError } from "@/tenancy/route";
import { getCurrentPipeline, listPipelineVersions, savePipeline } from "@/engines/intake/pipeline/service";
import type { PipelineStageDef } from "@/engines/intake/pipeline/stages";
import { readJson, requireActingStaff, requireActingUserId } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/pipeline", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    const history = new URL(req.url).searchParams.get("history") === "1";
    return history ? listPipelineVersions(tx, tenantId) : getCurrentPipeline(tx, tenantId);
  });
}

export async function PUT(req: Request) {
  return tenantRoute("PUT /api/intake/pipeline", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    if (!Array.isArray(body.stages)) throw new HttpError(400, "'stages' must be an array.");
    if (typeof body.expectedVersion !== "number") throw new HttpError(400, "'expectedVersion' is required.");
    const moves = body.moves && typeof body.moves === "object" ? (body.moves as Record<string, string>) : {};
    return savePipeline(tx, { tenantId, byUserId: requireActingUserId(req), stages: body.stages as PipelineStageDef[], expectedVersion: body.expectedVersion, moves });
  });
}
