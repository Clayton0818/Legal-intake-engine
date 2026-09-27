// c61 — lateral hires: the prior-matter list, the check before the start
// date, and matter access until it is complete. Database side.

import { and, eq, isNull } from "drizzle-orm";
import { users } from "@/db/schema";
import { conflictChecks, lateralChecks, lateralPriorMatters } from "@/db/tables/conflict-check";
import { audit, createTask, getFirmSettings, normalizeName, raiseFlag, toBusinessCalendar } from "@/core";
import { legalCopy } from "@/compliance/approvals";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, can, listConflictAttorneys, listFirmAdmins, screenedSubjectIds, type ConflictAccess } from "./access";
import { evaluateChecks, runConflictCheck } from "./checks";
import { CONFLICT_COPY_GATES } from "./gates";
import {
  lateralChecksComplete,
  lateralDueAt,
  lateralMatterAccess,
  screenPriorMatterEntry,
  startDatePassedIncomplete,
  type LateralStatus,
  type PriorMatterEntry,
} from "./lateral";
import { ENGINE, readConflictSettings } from "./settings";
import type { SearchedName } from "./types";
import { actorFor, cancelTaskIfOpen, completeTaskIfOpen, ConflictError } from "./util";

export type LateralCheckRow = typeof lateralChecks.$inferSelect;

async function getLateral(tx: TenantTx, tenantId: string, id: string): Promise<LateralCheckRow> {
  const [row] = await tx.select().from(lateralChecks).where(and(eq(lateralChecks.tenantId, tenantId), eq(lateralChecks.id, id))).limit(1);
  if (!row) throw new ConflictError("Lateral check not found.", 404);
  return row;
}

/** The hire themselves, or the conflicts role, may read/add to a list (c61 rule 6). */
function assertListAccess(access: ConflictAccess, lateral: LateralCheckRow): void {
  if (access.userId === lateral.userId) return;
  assertCan(access, "lateral.view_lists");
}

/** Firm admin starts onboarding for an invited user with a start date (c61 §4.1). */
export async function createLateralCheck(
  tx: TenantTx,
  input: { tenantId: string; userId: string; startDate: string; formerFirmNames?: string[]; access: ConflictAccess; now?: Date }
): Promise<LateralCheckRow> {
  assertCan(input.access, "lateral.manage");
  const now = input.now ?? new Date();
  const firmSettings = await getFirmSettings(tx, input.tenantId);
  const settings = readConflictSettings(firmSettings);
  const calendar = toBusinessCalendar(firmSettings);
  const [hire] = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, input.tenantId), eq(users.id, input.userId))).limit(1);
  if (!hire) throw new ConflictError("User not found.", 404);

  const dueAt = lateralDueAt(input.startDate, settings.lateralDueBusinessDaysBeforeStart, calendar);
  const attorneys = await listConflictAttorneys(tx, input.tenantId);
  const task = await createTask(
    tx,
    {
      tenantId: input.tenantId,
      kind: "conflict-check.lateral_list_due",
      title: "Submit your prior-matter list for the conflict check",
      description: legalCopy(CONFLICT_COPY_GATES.lateralFormInstructions.key),
      owner: { type: "user", userId: input.userId },
      supervisorUserId: attorneys.designated ?? (await listFirmAdmins(tx, input.tenantId))[0] ?? null,
      due: { at: dueAt < now ? now : dueAt, clock: "business" },
      sourceCard: "c61",
      engine: ENGINE,
      createdBy: actorFor(input.access),
    },
    { now, calendar }
  );
  const [row] = await tx
    .insert(lateralChecks)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      startDate: input.startDate,
      dueAt,
      formerFirmNames: input.formerFirmNames ?? [],
      submitTaskId: task.id,
      createdByUserId: input.access.userId,
    })
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "lateral.created",
    entityType: "lateral_check",
    entityId: row!.id,
    actor: actorFor(input.access),
    payload: { userId: input.userId, startDate: input.startDate, dueAt: dueAt.toISOString() },
  });
  return row!;
}

/** Admin attests the hire has no prior legal employment (c61 rule 1). */
export async function attestNoPriorEmployment(tx: TenantTx, input: { tenantId: string; lateralCheckId: string; access: ConflictAccess; now?: Date }) {
  assertCan(input.access, "lateral.manage");
  const now = input.now ?? new Date();
  const lateral = await getLateral(tx, input.tenantId, input.lateralCheckId);
  if (lateral.status !== "awaiting_list") throw new ConflictError(`Lateral check is ${lateral.status}.`);
  const [row] = await tx
    .update(lateralChecks)
    .set({ status: "no_prior_employment", noPriorEmploymentAttestedByUserId: input.access.userId, attestedAt: now, completedAt: now })
    .where(eq(lateralChecks.id, lateral.id))
    .returning();
  await cancelTaskIfOpen(tx, { tenantId: input.tenantId, taskId: lateral.submitTaskId, by: actorFor(input.access), reason: "No prior legal employment attested" });
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "lateral.no_prior_employment", entityType: "lateral_check", entityId: lateral.id, actor: actorFor(input.access) });
  return row!;
}

/**
 * The hire adds prior matters (form or CSV rows). Entries with more than
 * names and a general subject are refused with the reasons (the rejected text
 * is not stored). Additions after attestation are checked immediately (c61 §4.4).
 */
export async function addPriorMatters(
  tx: TenantTx,
  input: { tenantId: string; lateralCheckId: string; entries: PriorMatterEntry[]; access: ConflictAccess; now?: Date }
) {
  const now = input.now ?? new Date();
  const lateral = await getLateral(tx, input.tenantId, input.lateralCheckId);
  assertListAccess(input.access, lateral);
  if (lateral.status === "no_prior_employment") throw new ConflictError("This hire was attested as having no prior legal employment.");
  if (input.entries.length === 0) throw new ConflictError("Add at least one prior matter.", 422);
  const settings = readConflictSettings(await getFirmSettings(tx, input.tenantId));

  const problems = input.entries.flatMap((e, i) => screenPriorMatterEntry(e, settings.lateralEntryMaxChars).problems.map((p) => `Entry ${i + 1}: ${p}`));
  if (problems.length > 0) throw new ConflictError("Some entries need to be shortened to names and a general subject.", 422, problems);

  const attested = lateral.attestedAt !== null;
  const startedAlready = now.toISOString().slice(0, 10) >= lateral.startDate;
  const rows = await tx
    .insert(lateralPriorMatters)
    .values(
      input.entries.map((e) => ({
        tenantId: input.tenantId,
        lateralCheckId: lateral.id,
        formerFirmName: e.formerFirmName?.trim() || null,
        clientNames: e.clientNames.map((n) => n.trim()).filter(Boolean),
        adversePartyNames: e.adversePartyNames.map((n) => n.trim()).filter(Boolean),
        normalizedNames: [...e.clientNames, ...e.adversePartyNames].map(normalizeName).filter(Boolean),
        subjectCategory: e.subjectCategory,
        subjectNote: e.subjectNote?.trim() || null,
        role: e.role,
        fromYear: e.fromYear ?? null,
        toYear: e.toYear ?? null,
        stillOpenKnown: e.stillOpenKnown ?? null,
        addedAfterStart: startedAlready,
      }))
    )
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "lateral.entries_added",
    entityType: "lateral_check",
    entityId: lateral.id,
    actor: actorFor(input.access),
    payload: { count: rows.length, afterAttestation: attested },
  });
  if (attested) await runLateralCheck(tx, lateral, rows, input.access, now);
  return rows;
}

/** The hire confirms the list is complete (timestamped attestation), which runs the check. */
export async function attestLateralList(tx: TenantTx, input: { tenantId: string; lateralCheckId: string; access: ConflictAccess; now?: Date }) {
  const now = input.now ?? new Date();
  const lateral = await getLateral(tx, input.tenantId, input.lateralCheckId);
  if (input.access.userId !== lateral.userId) throw new ConflictError("Only the hire can attest their own list.", 403);
  if (lateral.status !== "awaiting_list") throw new ConflictError(`Lateral check is ${lateral.status}.`);
  const entries = await tx.select().from(lateralPriorMatters).where(and(eq(lateralPriorMatters.tenantId, input.tenantId), eq(lateralPriorMatters.lateralCheckId, lateral.id)));
  await tx.update(lateralChecks).set({ attestedAt: now, status: "checking" }).where(eq(lateralChecks.id, lateral.id));
  await completeTaskIfOpen(tx, { tenantId: input.tenantId, taskId: lateral.submitTaskId, by: actorFor(input.access), reason: "List submitted and attested", at: now });
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "lateral.attested", entityType: "lateral_check", entityId: lateral.id, actor: actorFor(input.access), payload: { entries: entries.length } });
  return runLateralCheck(tx, { ...lateral, attestedAt: now, status: "checking" }, entries, input.access, now);
}

async function runLateralCheck(
  tx: TenantTx,
  lateral: LateralCheckRow,
  entries: Array<typeof lateralPriorMatters.$inferSelect>,
  access: ConflictAccess,
  now: Date
) {
  const searched: SearchedName[] = entries.flatMap((e) => [
    ...e.clientNames.map((name) => ({ name, role: "lateral_client" })),
    ...e.adversePartyNames.map((name) => ({ name, role: "lateral_adverse" })),
  ]);
  if (searched.length > 0) {
    // Hits create conflict checks with trigger 'lateral_hire' and go to the conflicts attorney (c61 §4.3).
    await runConflictCheck(tx, {
      tenantId: lateral.tenantId,
      trigger: "lateral_hire",
      searched,
      lateralCheckId: lateral.id,
      triggeredBy: actorFor(access),
      sources: ["party"],
      now,
    });
  }
  return refreshLateralStatus(tx, lateral.tenantId, lateral.id, now);
}

/** Recompute a lateral check's status from its conflict checks. */
export async function refreshLateralStatus(tx: TenantTx, tenantId: string, lateralCheckId: string, now = new Date()): Promise<LateralCheckRow> {
  const lateral = await getLateral(tx, tenantId, lateralCheckId);
  if (lateral.status === "awaiting_list" || lateral.status === "no_prior_employment") return lateral;
  const checks = await tx.select().from(conflictChecks).where(and(eq(conflictChecks.tenantId, tenantId), eq(conflictChecks.lateralCheckId, lateralCheckId)));
  const results = await evaluateChecks(tx, tenantId, checks);
  const complete = lateralChecksComplete(results);
  const status: LateralStatus = complete ? "complete" : "awaiting_decisions";
  if (status === lateral.status) return lateral;
  const [row] = await tx
    .update(lateralChecks)
    .set({ status, completedAt: complete ? now : null })
    .where(eq(lateralChecks.id, lateral.id))
    .returning();
  await audit(tx, { tenantId, engine: ENGINE, action: `lateral.${status}`, entityType: "lateral_check", entityId: lateral.id });
  return row!;
}

/** The hire left the firm: the list is kept and still searched (c61 rule 7). */
export async function recordHireDeparted(tx: TenantTx, input: { tenantId: string; lateralCheckId: string; access: ConflictAccess; at?: Date }) {
  assertCan(input.access, "lateral.manage");
  const [row] = await tx
    .update(lateralChecks)
    .set({ hireDepartedAt: input.at ?? new Date() })
    .where(and(eq(lateralChecks.tenantId, input.tenantId), eq(lateralChecks.id, input.lateralCheckId)))
    .returning();
  if (!row) throw new ConflictError("Lateral check not found.", 404);
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "lateral.hire_departed", entityType: "lateral_check", entityId: row.id, actor: actorFor(input.access) });
  return row;
}

/** A lateral check with its entries (hire or conflicts role), or status only (firm admin). */
export async function getLateralCheck(tx: TenantTx, input: { tenantId: string; lateralCheckId: string; access: ConflictAccess }) {
  const lateral = await getLateral(tx, input.tenantId, input.lateralCheckId);
  const mayReadList = input.access.userId === lateral.userId || can(input.access, "lateral.view_lists");
  if (!mayReadList && !can(input.access, "lateral.manage")) throw new ConflictError("Not allowed.", 403);
  const entries = mayReadList
    ? await tx.select().from(lateralPriorMatters).where(and(eq(lateralPriorMatters.tenantId, input.tenantId), eq(lateralPriorMatters.lateralCheckId, lateral.id)))
    : null;
  return { lateral, entries, instructions: legalCopy(CONFLICT_COPY_GATES.lateralFormInstructions.key) };
}

export async function listLateralChecks(tx: TenantTx, tenantId: string, access: ConflictAccess) {
  if (!can(access, "lateral.manage") && !can(access, "lateral.view_lists")) throw new ConflictError("Not allowed.", 403);
  return tx
    .select({
      id: lateralChecks.id,
      userId: lateralChecks.userId,
      userName: users.displayName,
      startDate: lateralChecks.startDate,
      dueAt: lateralChecks.dueAt,
      status: lateralChecks.status,
      attestedAt: lateralChecks.attestedAt,
      completedAt: lateralChecks.completedAt,
    })
    .from(lateralChecks)
    .innerJoin(users, eq(users.id, lateralChecks.userId))
    .where(eq(lateralChecks.tenantId, tenantId));
}

/**
 * Which matters a user may access as far as conflicts are concerned: lateral
 * restriction (c61 rule 3) plus screens (c60). Other engines call this via
 * GET /api/conflict-check/access/[userId] until a shared permission layer exists.
 */
export async function matterAccessFor(tx: TenantTx, tenantId: string, userId: string) {
  const settings = readConflictSettings(await getFirmSettings(tx, tenantId));
  const [lateral] = await tx
    .select({ status: lateralChecks.status })
    .from(lateralChecks)
    .where(and(eq(lateralChecks.tenantId, tenantId), eq(lateralChecks.userId, userId), isNull(lateralChecks.hireDepartedAt)))
    .limit(1);
  const access = lateralMatterAccess((lateral?.status as LateralStatus | undefined) ?? null, settings.lateralAccessExceptionMatterIds);
  const screened = await screenedSubjectIds(tx, tenantId, userId);
  return { ...access, screenedSubjectIds: [...screened] };
}

/** Worker: start date reached before the check is complete → flag owner and conflicts attorney once (c61 §4.4). */
export async function flagLateStartDates(tx: TenantTx, tenantId: string, now: Date): Promise<number> {
  const firmSettings = await getFirmSettings(tx, tenantId);
  const open = await tx
    .select()
    .from(lateralChecks)
    .where(and(eq(lateralChecks.tenantId, tenantId), isNull(lateralChecks.startDateFlaggedAt)));
  let flagged = 0;
  for (const l of open) {
    if (!startDatePassedIncomplete(l.status as LateralStatus, l.startDate, now, firmSettings.timeZone)) continue;
    const [attorneys, admins] = await Promise.all([listConflictAttorneys(tx, tenantId), listFirmAdmins(tx, tenantId)]);
    const recipients = [...new Set([...(attorneys.designated ? [attorneys.designated] : []), ...admins])];
    if (recipients.length > 0) {
      await raiseFlag(
        tx,
        {
          tenantId,
          type: "conflict-check.lateral_start_before_complete",
          severity: "high",
          audience: "internal",
          title: "A new hire's start date arrived before their conflict check was complete",
          summary: "Their account has no matter access until the check is complete (except the firm's exception list).",
          details: { lateralCheckId: l.id, status: l.status },
          recipients: { userIds: recipients },
          dedupeKey: `conflict-check.lateral_start:${l.id}`,
          sourceCard: "c61",
          engine: ENGINE,
        },
        { now }
      );
    }
    await tx.update(lateralChecks).set({ startDateFlaggedAt: now }).where(eq(lateralChecks.id, l.id));
    flagged++;
  }
  return flagged;
}
