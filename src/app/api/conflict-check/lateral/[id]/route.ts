import { conflictRoute } from "@/app/api/conflict-check/_lib/route";
import {
  addPriorMatters,
  attestLateralList,
  attestNoPriorEmployment,
  getLateralCheck,
  recordHireDeparted,
} from "@/engines/conflict-check/lateralService";
import type { PriorMatterEntry } from "@/engines/conflict-check/lateral";
import { assertUuidParam, oneOf, readBody } from "@/engines/conflict-check/http";
import { ConflictError } from "@/engines/conflict-check/util";

export const dynamic = "force-dynamic";

/** One lateral check: entries for the hire and the conflicts role; status only for the firm admin. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("GET /api/conflict-check/lateral/[id]", req, ({ tx, tenantId, access }) =>
    getLateralCheck(tx, { tenantId, lateralCheckId: assertUuidParam(id, "lateral check id"), access })
  );
}

const ACTIONS = ["add_entries", "attest", "no_prior_employment", "departed"] as const;

function parseEntries(raw: unknown): PriorMatterEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ConflictError("'entries' must be a non-empty list.", 422);
  if (raw.length > 500) throw new ConflictError("Submit at most 500 entries at a time.", 422);
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      formerFirmName: typeof o.formerFirmName === "string" ? o.formerFirmName : null,
      clientNames: names(o.clientNames),
      adversePartyNames: names(o.adversePartyNames),
      subjectCategory: typeof o.subjectCategory === "string" ? o.subjectCategory : "",
      subjectNote: typeof o.subjectNote === "string" ? o.subjectNote : null,
      role: o.role === "staff" ? "staff" : "lawyer",
      fromYear: int(o.fromYear),
      toYear: int(o.toYear),
      stillOpenKnown: typeof o.stillOpenKnown === "boolean" ? o.stillOpenKnown : null,
    };
  });
}

/**
 * add_entries: the hire adds prior matters (names and general subject only; rejected text is not
 * stored); attest: the hire confirms the list, which runs the check; no_prior_employment and
 * departed: firm admin.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return conflictRoute("POST /api/conflict-check/lateral/[id]", req, async ({ tx, tenantId, access }) => {
    const body = await readBody(req);
    const lateralCheckId = assertUuidParam(id, "lateral check id");
    switch (oneOf(body, "action", ACTIONS)) {
      case "add_entries":
        return { entries: (await addPriorMatters(tx, { tenantId, lateralCheckId, entries: parseEntries(body.entries), access })).length };
      case "attest":
        return attestLateralList(tx, { tenantId, lateralCheckId, access });
      case "no_prior_employment":
        return attestNoPriorEmployment(tx, { tenantId, lateralCheckId, access });
      case "departed":
        return recordHireDeparted(tx, { tenantId, lateralCheckId, access });
    }
  });
}
