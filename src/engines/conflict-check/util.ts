// Small shared helpers for the Conflict-check engine's database services.

import { and, eq } from "drizzle-orm";
import { tasks } from "@/db/tables/foundation";
import { cancelTask, completeTask, getTask, type Actor } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import type { ConflictAccess } from "./access";
import { ENGINE } from "./settings";

export function actorFor(by: ConflictAccess | Actor | undefined | null): Actor {
  if (!by) return { type: "system" };
  return "caps" in by ? { type: "user", userId: by.userId } : by;
}

/** Complete a task only if it is still open (no error when someone already closed it). */
export async function completeTaskIfOpen(
  tx: TenantTx,
  input: { tenantId: string; taskId: string | null | undefined; by: Actor; reason: string; at?: Date }
): Promise<boolean> {
  if (!input.taskId) return false;
  const task = await getTask(tx, input.tenantId, input.taskId);
  if (!task || task.status !== "open") return false;
  await completeTask(tx, { tenantId: input.tenantId, taskId: input.taskId, by: input.by, reason: input.reason, engine: ENGINE, at: input.at });
  return true;
}

export async function cancelTaskIfOpen(
  tx: TenantTx,
  input: { tenantId: string; taskId: string | null | undefined; by: Actor; reason: string }
): Promise<boolean> {
  if (!input.taskId) return false;
  const task = await getTask(tx, input.tenantId, input.taskId);
  if (!task || task.status !== "open") return false;
  await cancelTask(tx, { tenantId: input.tenantId, taskId: input.taskId, by: input.by, reason: input.reason, engine: ENGINE });
  return true;
}

/** Complete every open task of `kind` that points at `sourceRef` (e.g. a waiver's signature follow-up). */
export async function completeTasksByRef(
  tx: TenantTx,
  input: { tenantId: string; kind: string; sourceRef: string; by: Actor; reason: string; at?: Date }
): Promise<number> {
  const open = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, input.tenantId), eq(tasks.kind, input.kind), eq(tasks.sourceRef, input.sourceRef), eq(tasks.status, "open")));
  for (const t of open) {
    await completeTask(tx, { tenantId: input.tenantId, taskId: t.id, by: input.by, reason: input.reason, engine: ENGINE, at: input.at });
  }
  return open.length;
}

/** A client-safe error with an HTTP status, for route handlers. */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly details?: string[]
  ) {
    super(message);
    this.name = "ConflictError";
  }
}
