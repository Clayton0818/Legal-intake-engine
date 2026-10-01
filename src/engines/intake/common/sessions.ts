// Intake session + intake-engine side state (intake_session_state).

import { and, desc, eq } from "drizzle-orm";
import { firmConfigVersions, intakeSessions, matters, parties } from "@/db/schema";
import { intakeSessionState } from "@/db/tables/intake";
import type { TenantTx } from "@/tenancy/withTenant";
import { IntakeNotFoundError, IntakeRuleError } from "./errors";

export type IntakeSessionRow = typeof intakeSessions.$inferSelect;
export type SessionStateRow = typeof intakeSessionState.$inferSelect;
export type SessionStatePatch = Partial<Omit<typeof intakeSessionState.$inferInsert, "id" | "tenantId" | "intakeSessionId">>;

export interface SessionBundle {
  session: IntakeSessionRow;
  state: SessionStateRow;
}

export async function getSession(tx: TenantTx, tenantId: string, sessionId: string): Promise<IntakeSessionRow> {
  const [row] = await tx
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.tenantId, tenantId), eq(intakeSessions.id, sessionId)))
    .limit(1);
  if (!row) throw new IntakeNotFoundError("Intake session");
  return row;
}

export async function findState(tx: TenantTx, tenantId: string, sessionId: string): Promise<SessionStateRow | undefined> {
  const [row] = await tx
    .select()
    .from(intakeSessionState)
    .where(and(eq(intakeSessionState.tenantId, tenantId), eq(intakeSessionState.intakeSessionId, sessionId)))
    .limit(1);
  return row;
}

/**
 * The session plus its intake state. Sessions created by the older web-chat
 * route (before this engine) get a state row on first touch, channel web_chat.
 */
export async function getSessionBundle(tx: TenantTx, tenantId: string, sessionId: string): Promise<SessionBundle> {
  const session = await getSession(tx, tenantId, sessionId);
  let state = await findState(tx, tenantId, sessionId);
  if (!state) {
    const [created] = await tx
      .insert(intakeSessionState)
      .values({ tenantId, intakeSessionId: sessionId, channel: session.channel && isKnownChannel(session.channel) ? session.channel : "web_chat" })
      .onConflictDoNothing()
      .returning();
    state = created ?? (await findState(tx, tenantId, sessionId));
    if (!state) throw new Error("getSessionBundle: could not create intake state.");
  }
  return { session, state };
}

function isKnownChannel(channel: string): boolean {
  return ["web_chat", "web_form", "phone_ai", "phone_staff", "email", "sms", "referral", "walk_in", "phone_manual"].includes(channel);
}

export async function updateState(tx: TenantTx, tenantId: string, sessionId: string, patch: SessionStatePatch): Promise<SessionStateRow> {
  const [row] = await tx
    .update(intakeSessionState)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(intakeSessionState.tenantId, tenantId), eq(intakeSessionState.intakeSessionId, sessionId)))
    .returning();
  if (!row) throw new IntakeNotFoundError("Intake session state");
  return row;
}

/** The firm's current config version (intake_sessions.firm_config_version_id is NOT NULL). */
export async function currentFirmConfigVersionId(tx: TenantTx, tenantId: string): Promise<string> {
  const [config] = await tx
    .select({ id: firmConfigVersions.id })
    .from(firmConfigVersions)
    .where(eq(firmConfigVersions.tenantId, tenantId))
    .orderBy(desc(firmConfigVersions.effectiveFrom))
    .limit(1);
  if (!config) {
    // Same stance as src/app/api/intake/sessions/route.ts: never fabricate a config version.
    throw new IntakeRuleError("This firm has no active configuration yet; seed a firm_config_versions row before taking intake.");
  }
  return config.id;
}

export type MatterRow = typeof matters.$inferSelect;
export type PartyRow = typeof parties.$inferSelect;

export async function getMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<MatterRow> {
  const [row] = await tx.select().from(matters).where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId))).limit(1);
  if (!row) throw new IntakeNotFoundError("Matter");
  return row;
}

export async function getParty(tx: TenantTx, tenantId: string, partyId: string): Promise<PartyRow> {
  const [row] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))).limit(1);
  if (!row) throw new IntakeNotFoundError("Contact");
  return row;
}

/** The newest intake session linked to a matter, if any. */
export async function latestSessionForMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<IntakeSessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(intakeSessions)
    .where(and(eq(intakeSessions.tenantId, tenantId), eq(intakeSessions.matterId, matterId)))
    .orderBy(desc(intakeSessions.startedAt))
    .limit(1);
  return row;
}
