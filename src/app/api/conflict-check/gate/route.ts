import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import { checkConflictGate, getGate } from "@/engines/conflict-check/checks";
import { GATED_ACTIONS } from "@/engines/conflict-check/decisions";
import { oneOf, readBody, reqUuid } from "@/engines/conflict-check/http";
import type { GateSubject } from "@/engines/conflict-check/types";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

const SUBJECT_TYPES = ["intake_session", "matter"] as const;

function subjectFromQuery(url: URL): GateSubject {
  const type = url.searchParams.get("subjectType");
  const id = url.searchParams.get("subjectId") ?? "";
  if (type !== "intake_session" && type !== "matter") throw new ConflictError("subjectType must be intake_session or matter.", 422);
  return { type, id: reqUuid({ id }, "id") };
}

/** Gate status for an intake session or matter: 'open' | 'closed' + machine reason (no party details). */
export async function GET(req: Request) {
  return conflictRoute("GET /api/conflict-check/gate", req, ({ tx, tenantId }) => getGate(tx, tenantId, subjectFromQuery(new URL(req.url))));
}

/**
 * Server-side check before a downstream action (engagement agreement, assignment, scheduling,
 * trust deposit, payment, matter opening). A refusal is logged (c59 acceptance 2). Callers must
 * not proceed unless `allowed` is true.
 */
export async function POST(req: Request) {
  return conflictRoute("POST /api/conflict-check/gate", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const type = oneOf(body, "subjectType", SUBJECT_TYPES);
    return checkConflictGate(tx, {
      tenantId,
      subject: { type, id: reqUuid(body, "subjectId") },
      action: oneOf(body, "action", GATED_ACTIONS),
      actor: { type: "user", userId: access.userId },
    });
  });
}
