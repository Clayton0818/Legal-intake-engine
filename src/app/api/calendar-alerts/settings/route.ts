import { alertsRoute } from "@/app/api/calendar-alerts/_lib/route";
import { updateEngineSettings } from "@/core/firmSettings";
import { AlertRuleError } from "@/engines/calendar-alerts/common";
import { ENGINE, readAlertSettings, validateAlertSettingsPatch, type AlertSettings } from "@/engines/calendar-alerts/settings";
import { ALERT_GATE_KEYS, ALERT_SHARED_GATE_KEYS } from "@/engines/calendar-alerts/gates";
import { gateStatus } from "@/compliance/approvals";
import { readBody } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** This engine's settings (firm settings, not gates) plus the approval gates it waits on. */
export async function GET() {
  return alertsRoute("GET /api/calendar-alerts/settings", async ({ ctx }) => ({
    settings: ctx.alerts,
    firmTimers: {
      firmReplyHours: ctx.firm.firmReplyHours,
      clientPromiseHours: ctx.firm.clientPromiseHours,
      deadlineQuestionFlagHours: ctx.firm.deadlineQuestionFlagHours,
      deadlineQuestionReplyHours: ctx.firm.deadlineQuestionReplyHours,
      clientResponseWindowHours: ctx.firm.clientResponseWindowHours,
      dueSoonBusinessHours: ctx.firm.dueSoonBusinessHours,
      overdueGraceBusinessHours: ctx.firm.overdueGraceBusinessHours,
      courtNoticeAckMinutes: ctx.firm.courtNoticeAckMinutes,
      internalEmailDigest: ctx.firm.internalEmailDigest,
    },
    gates: [...ALERT_GATE_KEYS, ...ALERT_SHARED_GATE_KEYS].map((key) => {
      const s = gateStatus(key);
      return { key, description: s.gate.description, approved: s.approved, pendingReviewers: s.pendingReviewers };
    }),
  }));
}

/** Update engine settings (owner/admin): a partial AlertSettings object. Validated; logged. */
export async function PUT(req: Request) {
  return alertsRoute(
    "PUT /api/calendar-alerts/settings",
    async ({ tx, tenantId, staff }) => {
      const patch = (await readBody(req)) as Partial<AlertSettings>;
      const errors = validateAlertSettingsPatch(patch);
      if (errors.length > 0) throw new AlertRuleError(errors.join(" "));
      const firm = await updateEngineSettings(tx, tenantId, ENGINE, patch as Record<string, unknown>, { type: "user", userId: staff.userId });
      return readAlertSettings(firm);
    },
    { permission: "settings.manage" }
  );
}
