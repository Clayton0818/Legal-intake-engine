// Read-only matter lookups shared by the calendar-core services.

import { and, eq } from "drizzle-orm";
import { matters } from "@/db/schema";
import type { TenantTx } from "@/tenancy/withTenant";
import { notFound } from "./errors";

export type MatterRow = typeof matters.$inferSelect;

export async function getMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<MatterRow> {
  const [row] = await tx.select().from(matters).where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId))).limit(1);
  if (!row) throw notFound("Matter");
  return row;
}

export async function findMatter(tx: TenantTx, tenantId: string, matterId: string): Promise<MatterRow | undefined> {
  const [row] = await tx.select().from(matters).where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId))).limit(1);
  return row;
}
