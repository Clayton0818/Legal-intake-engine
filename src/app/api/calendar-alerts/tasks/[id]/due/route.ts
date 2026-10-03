import { alertsRoute, type RouteParams } from "@/app/api/calendar-alerts/_lib/route";
import { redateTask } from "@/engines/calendar-alerts/overdue/service";
import { requireRole, ACTING_ROLES } from "@/engines/calendar-alerts/common";
import { assertUuidParam, readBody, reqDateTime, reqString } from "@/engines/calendar-alerts/http";

export const dynamic = "force-dynamic";

/** Change a task's due time: { dueAt, reason }. Refused past a linked court deadline (c45 rule 10). */
export async function POST(req: Request, { params }: RouteParams<"id">) {
  const { id } = await params;
  return alertsRoute(
    "POST /api/calendar-alerts/tasks/[id]/due",
    async ({ tx, tenantId, staff }) => {
      requireRole(staff, ACTING_ROLES, "change due dates");
      const body = await readBody(req);
      return redateTask(tx, { tenantId, taskId: assertUuidParam(id, "task id"), dueAt: reqDateTime(body, "dueAt"), by: { type: "user", userId: staff.userId }, reason: reqString(body, "reason", 2000) });
    },
    { permission: "ops.act" }
  );
}
