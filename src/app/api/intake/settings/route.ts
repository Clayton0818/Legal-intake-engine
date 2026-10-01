// Intake engine settings (firm-editable numbers, not gates). Follow-ups have their own gated switch.
import { tenantRoute, HttpError } from "@/tenancy/route";
import { updateEngineSettings } from "@/core/firmSettings";
import { loadIntakeContext } from "@/engines/intake/common/context";
import { requireStaff, userActor } from "@/engines/intake/common/actors";
import { applyIntakeSettingsPatch, INTAKE_ENGINE } from "@/engines/intake/settings";
import { setFollowUpsEnabled } from "@/engines/intake/followUp/service";
import { bool, readJson, requireActingStaff, requireActingUserId } from "../_lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return tenantRoute("GET /api/intake/settings", async ({ tx, tenantId }) => {
    await requireActingStaff(tx, tenantId, req);
    return (await loadIntakeContext(tx, tenantId)).settings;
  });
}

export async function PATCH(req: Request) {
  return tenantRoute("PATCH /api/intake/settings", async ({ tx, tenantId }) => {
    const userId = requireActingUserId(req);
    await requireStaff(tx, tenantId, userId, ["firm_admin"], "change intake settings");
    const body = await readJson(req);
    const followUp = body.followUp as Record<string, unknown> | undefined;
    if (followUp && "enabled" in followUp) {
      throw new HttpError(400, "Switch follow-ups on or off with POST /api/intake/settings (action 'follow_ups'); it needs attorney review first.");
    }
    const ctx = await loadIntakeContext(tx, tenantId);
    let next;
    try {
      next = applyIntakeSettingsPatch(ctx.settings, body as Parameters<typeof applyIntakeSettingsPatch>[1]);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : "Invalid settings.");
    }
    const changed = Object.fromEntries(Object.keys(body).map((k) => [k, next[k as keyof typeof next]]));
    await updateEngineSettings(tx, tenantId, INTAKE_ENGINE, changed, userActor(userId));
    return next;
  });
}

/** { action: 'follow_ups', enabled } — enabling requires the barratry/advertising review (423 until approved). */
export async function POST(req: Request) {
  return tenantRoute("POST /api/intake/settings", async ({ tx, tenantId }) => {
    const body = await readJson(req);
    if (body.action !== "follow_ups") throw new HttpError(400, "action must be 'follow_ups'.");
    return setFollowUpsEnabled(tx, { tenantId, byUserId: requireActingUserId(req), enabled: bool(body, "enabled") });
  });
}
