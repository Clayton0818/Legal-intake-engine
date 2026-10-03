import { coreRoute } from "@/app/api/calendar-core/_lib/route";
import { listCalculations, runCalculation } from "@/engines/calendar-core/deadlines/service";
import { assertUuidParam, optBool, optString, readBody, reqDateTime, reqString } from "@/engines/calendar-core/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute("GET /api/calendar-core/matters/[matterId]/deadlines", async ({ tx, tenantId }) => ({
    calculations: await listCalculations(tx, tenantId, assertUuidParam(matterId, "matter id")),
  }));
}

/**
 * c92 — calculate deadlines from a trigger: { ruleSetKey, triggerKey, triggerAt, serviceMethod?, ruleKeys?, preview? }.
 * 423 until 'rules.court_deadlines' is approved. Results are PROPOSED events a lawyer confirms.
 */
export async function POST(req: Request, { params }: { params: Promise<{ matterId: string }> }) {
  const { matterId } = await params;
  return coreRoute(
    "POST /api/calendar-core/matters/[matterId]/deadlines",
    async ({ tx, tenantId, staff }) => {
      const body = await readBody(req);
      const ruleKeys = Array.isArray(body.ruleKeys) ? body.ruleKeys.filter((k): k is string => typeof k === "string") : undefined;
      return runCalculation(tx, {
        tenantId,
        staff,
        matterId: assertUuidParam(matterId, "matter id"),
        ruleSetKey: reqString(body, "ruleSetKey"),
        triggerKey: reqString(body, "triggerKey"),
        triggerAt: reqDateTime(body, "triggerAt"),
        serviceMethod: optString(body, "serviceMethod"),
        ruleKeys,
        preview: optBool(body, "preview") ?? false,
      });
    },
    { permission: "calendar.write", status: 201 }
  );
}
