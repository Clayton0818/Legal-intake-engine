// c97 — each lawyer's private disclosure list, checked against new matters.
// Visible only to that lawyer and the conflicts role; firm owner/admin see
// status only (last confirmed date, count) — not firm-configurable (rule 1).

import { and, eq, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { interestDisclosureConfirmations, interestDisclosures } from "@/db/tables/conflict-check";
import { audit, createTask, getFirmSettings, getTask, normalizeName, toBusinessCalendar } from "@/core";
import { legalCopy } from "@/compliance/approvals";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, can, listConflictAttorneys, type ConflictAccess } from "./access";
import { runConflictCheck } from "./checks";
import { CONFLICT_COPY_GATES } from "./gates";
import { mustKeepList, reconfirmDueAt, validateDisclosure, type DisclosureInput } from "./interests";
import { ENGINE, readConflictSettings } from "./settings";
import { actorFor, completeTaskIfOpen, ConflictError } from "./util";

export type DisclosureRow = typeof interestDisclosures.$inferSelect;

/** The lawyer's own list, with the attorney-reviewed instructions. */
export async function listMyDisclosures(tx: TenantTx, input: { tenantId: string; access: ConflictAccess }) {
  const rows = await tx
    .select()
    .from(interestDisclosures)
    .where(and(eq(interestDisclosures.tenantId, input.tenantId), eq(interestDisclosures.userId, input.access.userId)));
  const [confirmation] = await tx
    .select()
    .from(interestDisclosureConfirmations)
    .where(and(eq(interestDisclosureConfirmations.tenantId, input.tenantId), eq(interestDisclosureConfirmations.userId, input.access.userId)))
    .limit(1);
  return {
    instructions: legalCopy(CONFLICT_COPY_GATES.interestFormInstructions.key),
    disclosures: rows,
    lastConfirmedAt: confirmation?.confirmedAt ?? null,
    nextDueAt: confirmation?.nextDueAt ?? null,
  };
}

/** Another lawyer's list: conflicts role only (c97 rule 1). Viewing is logged without contents. */
export async function listDisclosuresOf(tx: TenantTx, input: { tenantId: string; userId: string; access: ConflictAccess }) {
  assertCan(input.access, "log.view_interests");
  const rows = await tx
    .select()
    .from(interestDisclosures)
    .where(and(eq(interestDisclosures.tenantId, input.tenantId), eq(interestDisclosures.userId, input.userId)));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "interest.list_viewed",
    entityType: "user",
    entityId: input.userId,
    actor: actorFor(input.access),
  });
  return rows;
}

/**
 * Add an interest to your own list. On save it is checked against current
 * parties and open matters (c97 §4.1.4, §4.3); hits go only to the conflicts
 * attorney, and matched open matters close for NEW actions until decided.
 */
export async function addDisclosure(tx: TenantTx, input: { tenantId: string; access: ConflictAccess; disclosure: DisclosureInput; now?: Date }) {
  const errors = validateDisclosure(input.disclosure);
  if (errors.length > 0) throw new ConflictError("The disclosure cannot be saved.", 422, errors);
  const now = input.now ?? new Date();
  const d = input.disclosure;
  const [row] = await tx
    .insert(interestDisclosures)
    .values({
      tenantId: input.tenantId,
      userId: input.access.userId,
      interestType: d.interestType,
      name: d.name.trim(),
      normalizedName: normalizeName(d.name),
      relationship: d.relationship.trim(),
      identifiers: d.identifiers ?? {},
      startsOn: d.startsOn ?? null,
      endsOn: d.endsOn ?? null,
    })
    .returning();
  // c97 rule 7: the audit trail records THAT a disclosure changed, not its contents.
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "interest.added",
    entityType: "interest_disclosure",
    entityId: row!.id,
    actor: actorFor(input.access),
    payload: { interestType: d.interestType },
  });
  await runConflictCheck(tx, {
    tenantId: input.tenantId,
    trigger: "interest",
    searched: [{ name: d.name, role: "lawyer_interest" }],
    interestDisclosureId: row!.id,
    interestOwnerUserId: input.access.userId,
    closeAffectedMatters: true,
    sources: ["party"],
    triggeredBy: actorFor(input.access),
    now,
  });
  // The lawyer is told only that the entry was saved; whether it hit anything is for the conflicts attorney.
  return { disclosure: row! };
}

/** End an interest (or disable matching when the lawyer leaves). */
export async function endDisclosure(tx: TenantTx, input: { tenantId: string; disclosureId: string; access: ConflictAccess; endsOn?: string }) {
  const [row] = await tx
    .select()
    .from(interestDisclosures)
    .where(and(eq(interestDisclosures.tenantId, input.tenantId), eq(interestDisclosures.id, input.disclosureId)))
    .limit(1);
  if (!row) throw new ConflictError("Disclosure not found.", 404);
  if (row.userId !== input.access.userId && !can(input.access, "log.view_interests")) throw new ConflictError("Not allowed.", 403);
  const [updated] = await tx
    .update(interestDisclosures)
    .set({ active: false, endsOn: input.endsOn ?? new Date().toISOString().slice(0, 10), updatedAt: new Date() })
    .where(eq(interestDisclosures.id, row.id))
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "interest.ended", entityType: "interest_disclosure", entityId: row.id, actor: actorFor(input.access) });
  return updated!;
}

/** The lawyer confirms the list is current (c97 §4.1.5). */
export async function confirmDisclosures(tx: TenantTx, input: { tenantId: string; access: ConflictAccess; now?: Date }) {
  const now = input.now ?? new Date();
  const settings = readConflictSettings(await getFirmSettings(tx, input.tenantId));
  const nextDueAt = reconfirmDueAt(now, settings.interestReconfirmMonths);
  const [existing] = await tx
    .select()
    .from(interestDisclosureConfirmations)
    .where(and(eq(interestDisclosureConfirmations.tenantId, input.tenantId), eq(interestDisclosureConfirmations.userId, input.access.userId)))
    .limit(1);
  await completeTaskIfOpen(tx, { tenantId: input.tenantId, taskId: existing?.reminderTaskId, by: actorFor(input.access), reason: "Disclosure list confirmed", at: now });
  const [row] = await tx
    .insert(interestDisclosureConfirmations)
    .values({ tenantId: input.tenantId, userId: input.access.userId, confirmedAt: now, nextDueAt })
    .onConflictDoUpdate({
      target: [interestDisclosureConfirmations.tenantId, interestDisclosureConfirmations.userId],
      set: { confirmedAt: now, nextDueAt, reminderTaskId: null },
    })
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "interest.confirmed", entityType: "user", entityId: input.access.userId, actor: actorFor(input.access) });
  return row!;
}

/** Status for the firm owner/admin: counts and last confirmation, never contents. */
export async function disclosureStatus(tx: TenantTx, input: { tenantId: string; access: ConflictAccess }) {
  assertCan(input.access, "health.view");
  return tx
    .select({
      userId: users.id,
      displayName: users.displayName,
      activeCount: sql<number>`(select count(*) from interest_disclosures d where d.user_id = ${users.id} and d.active)`,
      lastConfirmedAt: interestDisclosureConfirmations.confirmedAt,
      nextDueAt: interestDisclosureConfirmations.nextDueAt,
    })
    .from(users)
    .leftJoin(
      interestDisclosureConfirmations,
      and(eq(interestDisclosureConfirmations.userId, users.id), eq(interestDisclosureConfirmations.tenantId, users.tenantId))
    )
    .where(and(eq(users.tenantId, input.tenantId), eq(users.status, "active")));
}

/**
 * Worker: lawyers whose list is due for re-confirmation (or who never
 * confirmed) get an internal task; the conflicts attorney supervises, so
 * c45's overdue handling escalates to them after the grace period.
 */
export async function queueReconfirmations(tx: TenantTx, tenantId: string, now: Date): Promise<number> {
  const firmSettings = await getFirmSettings(tx, tenantId);
  const calendar = toBusinessCalendar(firmSettings);
  const attorneys = await listConflictAttorneys(tx, tenantId);
  const rows = await tx
    .select({
      userId: users.id,
      role: users.role,
      confirmationId: interestDisclosureConfirmations.id,
      nextDueAt: interestDisclosureConfirmations.nextDueAt,
      reminderTaskId: interestDisclosureConfirmations.reminderTaskId,
    })
    .from(users)
    .leftJoin(
      interestDisclosureConfirmations,
      and(eq(interestDisclosureConfirmations.userId, users.id), eq(interestDisclosureConfirmations.tenantId, users.tenantId))
    )
    .where(and(eq(users.tenantId, tenantId), eq(users.status, "active")));
  let queued = 0;
  for (const r of rows) {
    if (!mustKeepList(r.role)) continue;
    if (r.nextDueAt && r.nextDueAt.getTime() > now.getTime()) continue;
    if (r.reminderTaskId) {
      const t = await getTask(tx, tenantId, r.reminderTaskId);
      if (t?.status === "open") continue;
    }
    const task = await createTask(
      tx,
      {
        tenantId,
        kind: "conflict-check.interest_reconfirm",
        title: "Confirm your private interest-disclosure list is current",
        owner: { type: "user", userId: r.userId },
        supervisorUserId: attorneys.designated && attorneys.designated !== r.userId ? attorneys.designated : attorneys.backups[0] ?? null,
        due: { hours: 40, clock: "business", from: now },
        sourceCard: "c97",
        engine: ENGINE,
      },
      { now, calendar }
    );
    await tx
      .insert(interestDisclosureConfirmations)
      .values({ tenantId, userId: r.userId, confirmedAt: null, nextDueAt: now, reminderTaskId: task.id })
      .onConflictDoUpdate({
        target: [interestDisclosureConfirmations.tenantId, interestDisclosureConfirmations.userId],
        set: { reminderTaskId: task.id },
      });
    queued++;
  }
  return queued;
}
