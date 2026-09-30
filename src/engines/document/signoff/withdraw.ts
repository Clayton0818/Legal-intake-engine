// c41 rule 3: any new version cancels outstanding sign-offs on older versions.
// Kept separate (tables + core only) so the document store can call it
// without importing the rest of the sign-off service.

import { and, eq, inArray, ne } from "drizzle-orm";
import { audit, cancelTask, type Actor } from "@/core";
import { documentSignoffResponses, documentSignoffs } from "@/db/tables/document";
import type { TenantTx } from "@/tenancy/withTenant";
import { ENGINE } from "../common";

export const OPEN_SIGNOFF_STATUSES = ["attorney_approved", "awaiting_client", "client_approved", "client_commented"] as const;

export async function withdrawOutstandingSignoffs(
  tx: TenantTx,
  args: { tenantId: string; versionGroupId: string; exceptDocumentId: string; reason: string; by: Actor; at?: Date }
): Promise<number> {
  const at = args.at ?? new Date();
  const open = await tx
    .select()
    .from(documentSignoffs)
    .where(
      and(
        eq(documentSignoffs.tenantId, args.tenantId),
        eq(documentSignoffs.versionGroupId, args.versionGroupId),
        ne(documentSignoffs.documentId, args.exceptDocumentId),
        inArray(documentSignoffs.status, [...OPEN_SIGNOFF_STATUSES])
      )
    );
  for (const s of open) {
    await tx
      .update(documentSignoffs)
      .set({ status: "withdrawn", withdrawnReason: args.reason, updatedAt: at })
      .where(eq(documentSignoffs.id, s.id));
    const responses = await tx
      .select()
      .from(documentSignoffResponses)
      .where(and(eq(documentSignoffResponses.tenantId, args.tenantId), eq(documentSignoffResponses.signoffId, s.id)));
    for (const r of responses) {
      if (r.status === "pending" || r.status === "approved" || r.status === "commented") {
        await tx.update(documentSignoffResponses).set({ status: "withdrawn" }).where(eq(documentSignoffResponses.id, r.id));
      }
      if (r.taskId) {
        try {
          await cancelTask(tx, { tenantId: args.tenantId, taskId: r.taskId, by: args.by, reason: args.reason, engine: ENGINE });
        } catch {
          // already closed
        }
      }
    }
    await audit(tx, {
      tenantId: args.tenantId,
      engine: ENGINE,
      action: "signoff.withdrawn",
      entityType: "document_signoff",
      entityId: s.id,
      matterId: s.matterId,
      actor: args.by,
      reason: args.reason,
      payload: { documentId: s.documentId, previousStatus: s.status },
      occurredAt: at,
    });
  }
  return open.length;
}
