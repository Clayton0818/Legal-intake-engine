// The prospective matter behind an intake session. A matter row exists from
// the moment intake needs one (booking, assignment, opening); it stays at
// stage 'prospective' until a product step moves it. Being a prospective
// matter is NOT representation (c68 rule 9).

import { and, eq } from "drizzle-orm";
import { intakeSessions, matterParties, matters } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { practiceAreaForClassifierLabel } from "@/core/practiceAreas";
import { IntakeRuleError } from "./errors";
import { recordIntakeEvent } from "./events";
import { getSessionBundle, getMatter, type MatterRow } from "./sessions";

/** Pure: the practice area implied by a session's classifier output. */
export function practiceAreaFromClassifier(classifierOutput: unknown): string | null {
  const c = (classifierOutput ?? {}) as Record<string, unknown>;
  return practiceAreaForClassifierLabel(typeof c.practiceArea === "string" ? c.practiceArea : null) ?? null;
}

/** Return the session's matter, creating the prospective matter (caller as a party) on first need. */
export async function ensureProspectiveMatter(tx: TenantTx, tenantId: string, intakeSessionId: string, now = new Date()): Promise<MatterRow> {
  const { session, state } = await getSessionBundle(tx, tenantId, intakeSessionId);
  if (session.matterId) return getMatter(tx, tenantId, session.matterId);
  if (!state.partyId) throw new IntakeRuleError("This inquiry has no contact yet; collect the person's name first.");
  const [matter] = await tx
    .insert(matters)
    .values({ tenantId, primaryPartyId: state.partyId, practiceArea: practiceAreaFromClassifier(session.classifierOutput), stage: "prospective" })
    .returning();
  if (!matter) throw new Error("ensureProspectiveMatter: insert failed.");
  await tx
    .insert(matterParties)
    .values({ tenantId, matterId: matter.id, partyId: state.partyId, role: "caller", addedAt: now })
    .onConflictDoNothing();
  await tx.update(intakeSessions).set({ matterId: matter.id }).where(and(eq(intakeSessions.tenantId, tenantId), eq(intakeSessions.id, session.id)));
  await recordIntakeEvent(tx, {
    tenantId,
    intakeSessionId: session.id,
    matterId: matter.id,
    eventType: "prospective_matter_created",
    firmConfigVersionId: session.firmConfigVersionId,
    entityType: "matter",
    entityId: matter.id,
  });
  return matter;
}
