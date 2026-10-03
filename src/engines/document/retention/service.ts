// Retention rules (c84 foundation for c90), database side. Storing a rule is
// firm configuration; applying one goes through proposeRetention() (gated).

import { and, eq, isNull, sql } from "drizzle-orm";
import { documents, matters } from "@/db/schema";
import { documentGroups, documentRetentionRules } from "@/db/tables/document";
import { audit, isPracticeAreaId } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { DocumentError, NotFoundError } from "../errors";
import { ENGINE } from "../settings";
import type { StaffViewer } from "../access/policy";
import { actorOf } from "../access/service";
import { proposeRetention, validateRetentionRule, type NewRetentionRule, type RetentionProposal } from "./policy";

export async function listRetentionRules(tx: TenantTx, tenantId: string) {
  return tx
    .select()
    .from(documentRetentionRules)
    .where(and(eq(documentRetentionRules.tenantId, tenantId), isNull(documentRetentionRules.supersededAt)));
}

/** Add (or replace) the firm's rule for a practice area / document type. Firm admin or attorney. */
export async function setRetentionRule(tx: TenantTx, tenantId: string, by: StaffViewer, input: NewRetentionRule) {
  if (!(by.permissions.includes("settings.manage") || by.role === "attorney")) throw new DocumentError("Only a firm admin or an attorney can set retention periods.", 403);
  if (input.practiceArea !== null && !isPracticeAreaId(input.practiceArea)) throw new DocumentError(`Unknown practice area '${input.practiceArea}'.`);
  const errors = validateRetentionRule(input);
  if (errors.length) throw new DocumentError("The retention rule has problems.", 422, { errors });
  const same = and(
    eq(documentRetentionRules.tenantId, tenantId),
    isNull(documentRetentionRules.supersededAt),
    sql`coalesce(${documentRetentionRules.practiceArea}, '') = ${input.practiceArea ?? ""}`,
    sql`coalesce(${documentRetentionRules.documentType}, '') = ${input.documentType ?? ""}`
  );
  const superseded = await tx
    .update(documentRetentionRules)
    .set({ supersededAt: new Date(), supersededByUserId: by.userId })
    .where(same)
    .returning({ id: documentRetentionRules.id });
  const [row] = await tx
    .insert(documentRetentionRules)
    .values({
      tenantId,
      practiceArea: input.practiceArea,
      documentType: input.documentType,
      retainYearsAfterClose: input.retainYearsAfterClose,
      basis: input.basis.trim(),
      createdByUserId: by.userId,
    })
    .returning();
  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: "retention_rule.set",
    entityType: "document_retention_rule",
    entityId: row!.id,
    actor: actorOf(by),
    payload: { ...input, supersedes: superseded.map((s) => s.id) },
  });
  return row!;
}

/**
 * Proposed destruction-review dates for every current file in a matter.
 * GATED (rules.retention_periods): throws PendingApprovalError until approved.
 * Read-only: proposes, never schedules or deletes anything.
 */
export async function proposeMatterRetention(tx: TenantTx, tenantId: string, matterId: string): Promise<{ groupId: string; title: string; proposal: RetentionProposal }[]> {
  const [matter] = await tx
    .select({ id: matters.id, practiceArea: matters.practiceArea, closedAt: matters.closedAt })
    .from(matters)
    .where(and(eq(matters.tenantId, tenantId), eq(matters.id, matterId)))
    .limit(1);
  if (!matter) throw new NotFoundError("Matter");
  const rules = await listRetentionRules(tx, tenantId);
  const groups = await tx
    .select({ g: documentGroups, documentType: documents.documentType })
    .from(documentGroups)
    .innerJoin(documents, eq(documents.id, documentGroups.currentDocumentId))
    .where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.matterId, matterId)));
  return groups.map(({ g, documentType }) => ({
    groupId: g.id,
    title: g.title,
    proposal: proposeRetention(tenantId, {
      matterClosedAt: matter.closedAt,
      legalHold: g.legalHold,
      legalHoldReason: g.legalHoldReason,
      practiceArea: matter.practiceArea,
      documentType,
      rules,
    }),
  }));
}
