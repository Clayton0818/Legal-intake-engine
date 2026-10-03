// c92 — rule-set versions and calculations (database).
//
// Applying a calculation needs BOTH the product-level gate
// 'rules.court_deadlines' (requireApproval — throws and is logged/423 while
// pending) AND a firm-lawyer-approved rule-set version. Results are inserted
// as PROPOSED calendar events (source 'deadline_calculator'); a lawyer
// confirms each one through the calendar (c91) before it counts.

import { and, desc, eq, max } from "drizzle-orm";
import { deadlineCalculations, deadlineRuleSets, type DeadlineCalcResult } from "@/db/tables/calendar-core";
import type { TenantTx } from "@/tenancy/withTenant";
import { requireApproval } from "@/compliance/approvals";
import { RULE_GATES } from "@/compliance/gates";
import { audit, getFirmSettings } from "@/core";
import { actorOf, requireLawyer, requireTemplateManager, requireWriter, type Staff } from "../actors";
import { conflict, invalid, notFound } from "../errors";
import { getMatter } from "../matters";
import { ENGINE, readCalendarCoreSettings } from "../settings";
import { insertEvent } from "../calendar/service";
import { CALENDAR_CORE_RULE_GATES } from "../gates";
import { calculateDeadlines } from "./calculator";
import { EXAMPLE_RULE_SET, getCourtRulesProvider, validateRuleSetConfig, type DeadlineRuleSetConfig } from "./ruleSets";

export type RuleSetRow = typeof deadlineRuleSets.$inferSelect;

export async function listRuleSets(tx: TenantTx, tenantId: string) {
  return tx.select().from(deadlineRuleSets).where(eq(deadlineRuleSets.tenantId, tenantId)).orderBy(deadlineRuleSets.key, desc(deadlineRuleSets.version));
}

export async function getRuleSet(tx: TenantTx, tenantId: string, id: string): Promise<RuleSetRow> {
  const [row] = await tx.select().from(deadlineRuleSets).where(and(eq(deadlineRuleSets.tenantId, tenantId), eq(deadlineRuleSets.id, id))).limit(1);
  if (!row) throw notFound("Rule set");
  return row;
}

/** Save a rule set as a NEW draft version. */
export async function saveRuleSetDraft(
  tx: TenantTx,
  input: {
    tenantId: string;
    staff: Staff;
    key: string;
    name: string;
    jurisdiction: string;
    court?: string | null;
    config: DeadlineRuleSetConfig;
    origin?: "firm_config" | "licensed_provider" | "example";
  }
): Promise<RuleSetRow> {
  requireTemplateManager(input.staff);
  if (!/^[a-z0-9][a-z0-9_-]{1,59}$/.test(input.key)) throw invalid("The rule-set key is not valid.");
  if (!input.name?.trim() || !input.jurisdiction?.trim()) throw invalid("Name and jurisdiction are required.");
  const errors = validateRuleSetConfig(input.config);
  if (errors.length > 0) throw invalid("The rule set is not valid.", errors);
  const [latest] = await tx
    .select({ v: max(deadlineRuleSets.version) })
    .from(deadlineRuleSets)
    .where(and(eq(deadlineRuleSets.tenantId, input.tenantId), eq(deadlineRuleSets.key, input.key)));
  const [row] = await tx
    .insert(deadlineRuleSets)
    .values({
      tenantId: input.tenantId,
      key: input.key,
      version: (latest?.v ?? 0) + 1,
      name: input.name.trim(),
      jurisdiction: input.jurisdiction.trim(),
      court: input.court ?? null,
      origin: input.origin ?? "firm_config",
      status: "draft",
      config: input.config,
      createdByUserId: input.staff.userId,
    })
    .returning();
  if (!row) throw new Error("saveRuleSetDraft: insert failed.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "deadline_rules.draft_saved",
    entityType: "deadline_rule_set",
    entityId: row.id,
    actor: actorOf(input.staff),
    payload: { key: row.key, version: row.version, origin: row.origin },
  });
  return row;
}

/** Add the shipped EXAMPLE as a draft (never approved automatically). */
export async function importExampleRuleSet(tx: TenantTx, input: { tenantId: string; staff: Staff }) {
  return saveRuleSetDraft(tx, { ...input, ...EXAMPLE_RULE_SET, origin: "example" });
}

/** Import from the licensed provider (gated). Lands as a draft for a firm lawyer to approve. */
export async function importFromProvider(tx: TenantTx, input: { tenantId: string; staff: Staff; providerKey: string; key: string }) {
  requireTemplateManager(input.staff);
  requireApproval(CALENDAR_CORE_RULE_GATES.licensedRulesProvider.key, { action: "deadline_rules.import", tenantId: input.tenantId, detail: { providerKey: input.providerKey } });
  const fetched = await getCourtRulesProvider().fetchRuleSet(input.providerKey);
  if (fetched.outcome !== "ok") throw conflict(`The rules provider did not return a rule set: ${fetched.detail}`);
  return saveRuleSetDraft(tx, { tenantId: input.tenantId, staff: input.staff, key: input.key, name: fetched.name, jurisdiction: fetched.jurisdiction, court: fetched.court, config: fetched.config, origin: "licensed_provider" });
}

/** A LAWYER approves one version (after checking it against the current rules). The previous approved version is retired. */
export async function approveRuleSet(tx: TenantTx, input: { tenantId: string; staff: Staff; ruleSetId: string; note: string; now?: Date }) {
  requireLawyer(input.staff, "approve a court-rule set");
  const note = input.note?.trim();
  if (!note || note.length < 10) throw invalid("Say what you checked (rules, version date, local rules); it is logged.");
  const now = input.now ?? new Date();
  const row = await getRuleSet(tx, input.tenantId, input.ruleSetId);
  if (row.status !== "draft") throw conflict(`This version is ${row.status}; only a draft can be approved.`);
  const errors = validateRuleSetConfig(row.config);
  if (errors.length > 0) throw invalid("The rule set is not valid.", errors);
  await tx
    .update(deadlineRuleSets)
    .set({ status: "retired", retiredAt: now })
    .where(and(eq(deadlineRuleSets.tenantId, input.tenantId), eq(deadlineRuleSets.key, row.key), eq(deadlineRuleSets.status, "approved")));
  const [approved] = await tx
    .update(deadlineRuleSets)
    .set({ status: "approved", approvedByUserId: input.staff.userId, approvedAt: now, approvalNote: note })
    .where(eq(deadlineRuleSets.id, row.id))
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "deadline_rules.approved",
    entityType: "deadline_rule_set",
    entityId: row.id,
    actor: actorOf(input.staff),
    reason: note,
    payload: { key: row.key, version: row.version, origin: row.origin },
  });
  return approved;
}

export async function retireRuleSet(tx: TenantTx, input: { tenantId: string; staff: Staff; ruleSetId: string; now?: Date }) {
  requireTemplateManager(input.staff);
  const [row] = await tx
    .update(deadlineRuleSets)
    .set({ status: "retired", retiredAt: input.now ?? new Date() })
    .where(and(eq(deadlineRuleSets.tenantId, input.tenantId), eq(deadlineRuleSets.id, input.ruleSetId)))
    .returning();
  if (!row) throw notFound("Rule set");
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "deadline_rules.retired", entityType: "deadline_rule_set", entityId: row.id, actor: actorOf(input.staff) });
  return row;
}

/**
 * Calculate deadlines from a trigger event. `preview: true` returns the
 * results without calendaring anything; otherwise each result becomes a
 * PROPOSED calendar event for a lawyer to confirm.
 */
export async function runCalculation(
  tx: TenantTx,
  input: {
    tenantId: string;
    staff: Staff;
    matterId: string;
    ruleSetKey: string;
    triggerKey: string;
    triggerAt: Date;
    serviceMethod?: string | null;
    ruleKeys?: string[];
    preview?: boolean;
    now?: Date;
  }
) {
  requireWriter(input.staff);
  requireApproval(RULE_GATES.courtDeadlines.key, { action: "deadline.calculate", tenantId: input.tenantId, detail: { ruleSetKey: input.ruleSetKey } });
  const now = input.now ?? new Date();
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const [ruleSet] = await tx
    .select()
    .from(deadlineRuleSets)
    .where(and(eq(deadlineRuleSets.tenantId, input.tenantId), eq(deadlineRuleSets.key, input.ruleSetKey), eq(deadlineRuleSets.status, "approved")))
    .limit(1);
  if (!ruleSet) throw conflict(`No lawyer-approved version of rule set '${input.ruleSetKey}'.`);
  const settings = readCalendarCoreSettings(await getFirmSettings(tx, input.tenantId));
  let output;
  try {
    output = calculateDeadlines(
      ruleSet.config,
      { key: input.triggerKey, at: input.triggerAt, serviceMethod: input.serviceMethod ?? null },
      { extraHolidays: settings.courtHolidays.map((h) => h.date), ruleKeys: input.ruleKeys, now }
    );
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : String(err));
  }
  const notice = "PROPOSED — calculated from the firm's approved rule set; a lawyer must confirm before it is relied on.";
  if (input.preview) {
    return { preview: true, notice, ruleSet: { id: ruleSet.id, key: ruleSet.key, version: ruleSet.version }, ...output };
  }
  const results: DeadlineCalcResult[] = [];
  for (const r of output.results) {
    const event = await insertEvent(tx, {
      tenantId: input.tenantId,
      draft: {
        matterId: matter.id,
        eventType: r.eventType,
        title: r.label,
        description: [notice, `Rule set ${ruleSet.key} v${ruleSet.version}; ${r.citation}.`, ...output.explanation, ...r.explanation, ...r.warnings.map((w) => `Warning: ${w}`)].join("\n"),
        startsAt: r.dueAt,
        allDay: r.allDay,
        courtName: ruleSet.court,
        isDeadline: true,
        assignedUserIds: matter.assignedUserId ? [matter.assignedUserId] : [],
        source: "deadline_calculator",
      },
      status: "proposed",
      createdByUserId: input.staff.userId,
      actor: actorOf(input.staff),
      now,
    });
    results.push({ ruleKey: r.ruleKey, label: r.label, date: r.date, dueAt: r.dueAt.toISOString(), allDay: r.allDay, explanation: r.explanation, warnings: r.warnings, calendarEventId: event.id });
  }
  const [calc] = await tx
    .insert(deadlineCalculations)
    .values({
      tenantId: input.tenantId,
      matterId: matter.id,
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
      triggerKey: input.triggerKey,
      triggerAt: input.triggerAt,
      serviceMethod: input.serviceMethod ?? null,
      results,
      calculatedByUserId: input.staff.userId,
      createdAt: now,
    })
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "deadline.calculated",
    entityType: "deadline_calculation",
    entityId: calc?.id ?? null,
    matterId: matter.id,
    actor: actorOf(input.staff),
    payload: { ruleSet: ruleSet.key, version: ruleSet.version, trigger: input.triggerKey, proposedEvents: results.length },
  });
  return { preview: false, notice, calculationId: calc?.id ?? null, triggerDate: output.triggerDate, explanation: output.explanation, results };
}

export async function listCalculations(tx: TenantTx, tenantId: string, matterId: string) {
  return tx
    .select()
    .from(deadlineCalculations)
    .where(and(eq(deadlineCalculations.tenantId, tenantId), eq(deadlineCalculations.matterId, matterId)))
    .orderBy(desc(deadlineCalculations.createdAt));
}
