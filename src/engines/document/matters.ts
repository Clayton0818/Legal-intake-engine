// Matter / party / recipient lookups shared by the Document engine's services.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { firms, matterParties, matters, parties, users } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError } from "./common";

export type MatterRow = typeof matters.$inferSelect;
export type PartyRow = typeof parties.$inferSelect;

export async function loadMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<MatterRow> {
  const [m] = await tx.select().from(matters).where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId))).limit(1);
  if (!m) throw new DocumentError("Matter not found.", 404);
  return m;
}

export async function loadParty(tx: TenantTx, tenantId: string, partyId: string): Promise<PartyRow> {
  const [p] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId))).limit(1);
  if (!p) throw new DocumentError("Contact not found.", 404);
  return p;
}

/** The client parties of a matter: the primary party plus any current 'client' role. */
export async function clientPartyIds(tx: TenantTx, tenantId: string, matter: Pick<MatterRow, "id" | "primaryPartyId">): Promise<string[]> {
  const rows = await tx
    .select({ partyId: matterParties.partyId })
    .from(matterParties)
    .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matter.id), eq(matterParties.role, "client"), isNull(matterParties.endedAt)));
  return [...new Set([matter.primaryPartyId, ...rows.map((r) => r.partyId)])];
}

/** True when the party is a client on the matter (portal access boundary). */
export async function isClientOnMatter(tx: TenantTx, tenantId: string, partyId: string, matterId: string): Promise<boolean> {
  const m = await loadMatter(tx, tenantId, matterId);
  return (await clientPartyIds(tx, tenantId, m)).includes(partyId);
}

export async function firmAdminIds(tx: TenantTx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "firm_admin"), eq(users.status, "active")));
  return rows.map((r) => r.id);
}

/** Who hears about a firm-side problem on a matter: the responsible lawyer, else the firm admins. */
export async function responsibleRecipients(tx: TenantTx, tenantId: string, matter: Pick<MatterRow, "assignedUserId">, alsoAdmins = false): Promise<string[]> {
  const admins = alsoAdmins || !matter.assignedUserId ? await firmAdminIds(tx, tenantId) : [];
  return [...new Set([...(matter.assignedUserId ? [matter.assignedUserId] : []), ...admins])];
}

export async function firmName(tx: TenantTx, tenantId: string): Promise<string> {
  const [f] = await tx.select({ name: firms.name }).from(firms).where(eq(firms.id, tenantId)).limit(1);
  return f?.name ?? "the firm";
}

export async function activeAttorneyIds(tx: TenantTx, tenantId: string, among?: string[]): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.role, "attorney"),
        eq(users.status, "active"),
        ...(among && among.length > 0 ? [inArray(users.id, among)] : [])
      )
    );
  return rows.map((r) => r.id);
}
