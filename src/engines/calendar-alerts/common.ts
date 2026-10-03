// Shared DB helpers of the calendar-alerts engine: who to tell, periodic-job
// bookkeeping, and the two delivery wrappers that add the c51 rules the core
// does not apply by itself:
//   notifyClient()  client notices: in-app always; email only from a verified
//                   firm domain and within the per-client daily cap (urgent
//                   notices are never capped).
//   raiseAlert()    raiseFlag() + the firm's daily-digest choice for
//                   NON-URGENT INTERNAL flags (the in-app row is immediate; the
//                   email joins the recipient's digest instead).

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { matters, users } from "@/db/schema";
import { notificationOutbox } from "@/db/tables/foundation";
import { alertDigestItems, alertJobRuns } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { fromLocal, toLocal } from "@/core/businessHours";
import { enqueueNotification, type NotificationRow } from "@/core/notify";
import { raiseFlag, type FlagRow, type RaiseFlagInput } from "@/core/flags";
import { getFirmSettings, type FirmSettings } from "@/core/firmSettings";
import { audit } from "@/core/audit";
import { ENGINE, readAlertSettings, type AlertSettings } from "./settings";

export class AlertRuleError extends Error {
  constructor(
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "AlertRuleError";
  }
}

export interface EngineContext {
  firm: FirmSettings;
  alerts: AlertSettings;
}

export async function loadContext(tx: TenantTx, tenantId: string): Promise<EngineContext> {
  const firm = await getFirmSettings(tx, tenantId);
  return { firm, alerts: readAlertSettings(firm) };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export async function listFirmAdminIds(tx: TenantTx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "firm_admin"), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

/** Only ACTIVE users of the firm, in input order. */
export async function activeUserIds(tx: TenantTx, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<string[]> {
  const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (wanted.length === 0) return [];
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.id, wanted), eq(users.status, "active")));
  const ok = new Set(rows.map((r) => r.id));
  return wanted.filter((id) => ok.has(id));
}

export interface MatterInfo {
  id: string;
  primaryPartyId: string;
  assignedUserId: string | null;
  stage: string;
  closedAt: Date | null;
  openedAt: Date;
}

export async function getMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<MatterInfo> {
  const [m] = await tx
    .select({
      id: matters.id,
      primaryPartyId: matters.primaryPartyId,
      assignedUserId: matters.assignedUserId,
      stage: matters.stage,
      closedAt: matters.closedAt,
      openedAt: matters.openedAt,
    })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!m) throw new AlertRuleError(`Matter ${matterId} not found.`, 404);
  return m;
}

/** The matter's responsible lawyer if that user is active, else null. */
export async function responsibleLawyer(tx: TenantTx, tenantId: string, matter: Pick<MatterInfo, "assignedUserId">): Promise<string | null> {
  const [id] = await activeUserIds(tx, tenantId, [matter.assignedUserId]);
  return id ?? null;
}

export interface People {
  admins: string[];
  managing: string[];
  owners: string[];
}

/** Firm admins, managing attorneys and firm owners (the last two fall back to admins). */
export async function loadPeople(tx: TenantTx, tenantId: string, alerts: AlertSettings): Promise<People> {
  const admins = await listFirmAdminIds(tx, tenantId);
  const managing = await activeUserIds(tx, tenantId, alerts.managingAttorneyUserIds);
  const owners = await activeUserIds(tx, tenantId, alerts.firmOwnerUserIds);
  return { admins, managing: managing.length ? managing : admins, owners: owners.length ? owners : admins };
}

export async function backupFor(tx: TenantTx, tenantId: string, alerts: AlertSettings, lawyerId: string | null): Promise<string | null> {
  if (!lawyerId) return null;
  const [id] = await activeUserIds(tx, tenantId, [alerts.backupLawyerByUser[lawyerId]]);
  return id ?? null;
}

// ---------------------------------------------------------------------------
// Periodic jobs (hourly stall sweep, nightly health, daily digest)
// ---------------------------------------------------------------------------

export async function lastJobRun(tx: TenantTx, tenantId: string, job: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: alertJobRuns.lastRunAt })
    .from(alertJobRuns)
    .where(and(eq(alertJobRuns.tenantId, tenantId), eq(alertJobRuns.job, job)))
    .limit(1);
  return row?.at ?? null;
}

export async function markJobRun(tx: TenantTx, tenantId: string, job: string, at: Date, summary: Record<string, unknown> = {}): Promise<void> {
  await tx
    .insert(alertJobRuns)
    .values({ tenantId, job, lastRunAt: at, lastSummary: summary })
    .onConflictDoUpdate({ target: [alertJobRuns.tenantId, alertJobRuns.job], set: { lastRunAt: at, lastSummary: summary } });
}

/** Pure: has at least `intervalMs` passed since the last run? */
export function jobIsDue(last: Date | null, now: Date, intervalMs: number): boolean {
  return last === null || now.getTime() - last.getTime() >= intervalMs;
}

/** Start of the local day of `at` in `timeZone`. */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  const l = toLocal(at, timeZone);
  return fromLocal(l.year, l.month, l.day, 0, 0, timeZone);
}

// ---------------------------------------------------------------------------
// c51 delivery wrappers
// ---------------------------------------------------------------------------

export interface ClientNoticeResult {
  inApp: NotificationRow;
  email: NotificationRow | null;
  emailSkippedReason: string | null;
}

/** Pure: should this client notice also be emailed? */
export function clientEmailDecision(input: {
  senderDomainVerified: boolean;
  urgent: boolean;
  sentToday: number;
  dailyCap: number;
}): { email: boolean; reason: string | null } {
  if (!input.senderDomainVerified) {
    return { email: false, reason: "The firm's sending domain is not verified; client email is blocked (in-app only)." };
  }
  if (!input.urgent && input.sentToday >= input.dailyCap) {
    return { email: false, reason: `Daily client email limit (${input.dailyCap}) reached; delivered in the portal only.` };
  }
  return { email: true, reason: null };
}

export async function notifyClient(
  tx: TenantTx,
  ctx: EngineContext,
  input: {
    tenantId: string;
    partyId: string;
    matterId: string | null;
    templateKey: string;
    payload?: Record<string, unknown>;
    urgent?: boolean;
    sensitive?: boolean;
    dedupeKey: string;
    now: Date;
    admins?: string[];
  }
): Promise<ClientNoticeResult> {
  const base = {
    tenantId: input.tenantId,
    recipient: { type: "party" as const, partyId: input.partyId },
    templateKey: input.templateKey,
    payload: input.payload ?? {},
    matterId: input.matterId,
    urgent: input.urgent ?? false,
    sensitive: input.sensitive ?? false,
  };
  const inApp = await enqueueNotification(tx, { ...base, channel: "in_app", dedupeKey: `${input.dedupeKey}:in_app` }, { now: input.now });

  const dayStart = startOfLocalDay(input.now, ctx.firm.timeZone);
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.tenantId, input.tenantId),
        eq(notificationOutbox.recipientPartyId, input.partyId),
        eq(notificationOutbox.channel, "email"),
        eq(notificationOutbox.urgent, false),
        gte(notificationOutbox.createdAt, dayStart)
      )
    );
  const decision = clientEmailDecision({
    senderDomainVerified: ctx.alerts.senderDomainVerified,
    urgent: input.urgent ?? false,
    sentToday: count?.n ?? 0,
    dailyCap: ctx.alerts.clientEmailDailyCap,
  });
  if (!decision.email) {
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "client_email.skipped",
      entityType: "notification",
      entityId: inApp.id,
      matterId: input.matterId,
      reason: decision.reason,
    });
    if (!ctx.alerts.senderDomainVerified) {
      const admins = input.admins ?? (await listFirmAdminIds(tx, input.tenantId));
      if (admins.length > 0) {
        await raiseFlag(
          tx,
          {
            tenantId: input.tenantId,
            type: "calendar-alerts.verify_email_domain",
            severity: "warning",
            audience: "internal",
            title: "Verify your email domain",
            summary: "Client emails are blocked until the firm's sending domain is verified (c51). Clients still see notices in the portal.",
            recipients: { userIds: admins },
            dedupeKey: "calendar-alerts.verify_email_domain",
            sourceCard: "c51",
            engine: ENGINE,
          },
          { now: input.now }
        );
      }
    }
    return { inApp, email: null, emailSkippedReason: decision.reason };
  }
  const email = await enqueueNotification(tx, { ...base, channel: "email", dedupeKey: `${input.dedupeKey}:email` }, { now: input.now });
  return { inApp, email, emailSkippedReason: null };
}

/**
 * raiseFlag() with the firm's digest choice (c51 noise control): a
 * non-urgent INTERNAL flag is delivered in-app now and its email joins each
 * recipient's daily digest. Urgent and client-facing flags always email now.
 */
export async function raiseAlert(
  tx: TenantTx,
  ctx: EngineContext,
  input: RaiseFlagInput,
  now: Date
): Promise<{ flag: FlagRow; created: boolean }> {
  const digest = ctx.firm.internalEmailDigest && input.audience === "internal" && !input.urgent;
  const res = await raiseFlag(tx, { engine: ENGINE, ...input, ...(digest ? { channels: ["in_app"] } : {}) }, { now });
  if (digest && res.created) {
    for (const userId of res.flag.recipientUserIds) {
      await tx.insert(alertDigestItems).values({ tenantId: input.tenantId, userId, flagId: res.flag.id, createdAt: now }).onConflictDoNothing();
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Staff (roles are always read from the firm's own users row, never trusted from a request)
// ---------------------------------------------------------------------------

export interface Staff {
  userId: string;
  role: string;
  displayName: string;
}

export async function loadStaff(tx: TenantTx, tenantId: string, userId: string): Promise<Staff> {
  const [row] = await tx
    .select({ id: users.id, role: users.role, status: users.status, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
    .limit(1);
  if (!row || row.status !== "active") throw new AlertRuleError("Unknown or inactive user.", 403);
  return { userId: row.id, role: row.role, displayName: row.displayName };
}

/** Roles that may act on client communication and alerts (not read_only / integration accounts). */
export const ACTING_ROLES: readonly string[] = ["firm_admin", "attorney", "intake_staff"];

export function requireRole(staff: Pick<Staff, "role">, roles: readonly string[], what: string): void {
  if (!roles.includes(staff.role)) throw new AlertRuleError(`Your role cannot ${what}.`, 403);
}

export function isFirmAdmin(staff: Pick<Staff, "role">): boolean {
  return staff.role === "firm_admin";
}
