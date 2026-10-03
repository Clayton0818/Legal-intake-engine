import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { getFirmSettings, updateEngineSettings } from "@/core";
import { actorOf } from "@/engines/calendar-core/actors";
import { invalid } from "@/engines/calendar-core/errors";
import { readBody } from "@/engines/calendar-core/http";
import { ENGINE, readCalendarCoreSettings, validateCalendarCoreSettingsPatch } from "@/engines/calendar-core/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return coreRoute("GET /api/calendar-core/settings", async ({ tx, tenantId }) => readCalendarCoreSettings(await getFirmSettings(tx, tenantId)));
}

/** Firm admin: update reminder intervals, verifiers, court holidays, … (logged by the core). */
export async function PATCH(req: Request) {
  return coreRoute(
    "PATCH /api/calendar-core/settings",
    async ({ tx, tenantId, staff }) => {
      const { values, errors } = validateCalendarCoreSettingsPatch(await readBody(req));
      if (errors.length > 0) throw invalid("Some settings are not valid.", errors);
      return readCalendarCoreSettings(await updateEngineSettings(tx, tenantId, ENGINE, values as Record<string, unknown>, actorOf(staff)));
    },
    { permission: "settings.manage" }
  );
}
