// c102 — structural and safety validation of a practice-area pack. Pure.
// Every registered pack must pass (registry.test.ts), so a new pack (c104
// Immigration, c105 Personal Injury) is just a data file plus one registry line.

import { packCopyItems } from "./copy";
import type { PracticeAreaPack } from "./types";

const SEMVER = /^\d+\.\d+\.\d+$/;
const ID = /^[a-z][a-z0-9_]*$/;

function dupes(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const id of ids) (seen.has(id) ? out : seen).add(id);
  return [...out];
}

/** Problems with a pack (empty = valid). `knownGate` checks gate keys exist (pass hasGate). */
export function validatePack(pack: PracticeAreaPack, knownGate: (key: string) => boolean = () => true): string[] {
  const errors: string[] = [];
  const err = (m: string) => errors.push(`${pack.id}: ${m}`);
  const copyPrefix = `copy.all-engines.${pack.id}.`;
  const rulePrefix = `rules.all-engines.${pack.id}.`;
  const ruleKeyOk = (k: string) => (k.startsWith(rulePrefix) || /^rules\.[a-z_]+$/.test(k)) && knownGate(k);

  if (!SEMVER.test(pack.version)) err(`version '${pack.version}' must be semver (x.y.z).`);
  if (pack.changelog.length === 0) err("changelog must describe the version.");
  if (!ruleKeyOk(pack.contentReviewGateKey)) err(`content review gate '${pack.contentReviewGateKey}' is not a known rules gate.`);

  // --- matter types ---
  const types = pack.intake.matterTypes.map((t) => t.id);
  if (types.length === 0) err("needs at least one matter type.");
  for (const d of dupes(types)) err(`duplicate matter type '${d}'.`);
  const typeOk = (t: string) => t === "*" || types.includes(t);
  const tracks = new Map(pack.stages.tracks.map((t) => [t.id, t]));
  const checklists = new Set(pack.documents.checklists.map((c) => c.id));
  const taskLists = new Set(pack.tasks.lists.map((l) => l.id));
  for (const t of pack.intake.matterTypes) {
    if (!ID.test(t.id)) err(`matter type id '${t.id}' must be snake_case.`);
    if (!tracks.has(t.stageTrackId)) err(`matter type '${t.id}' uses unknown stage track '${t.stageTrackId}'.`);
    for (const c of t.checklistIds) if (!checklists.has(c)) err(`matter type '${t.id}' uses unknown checklist '${c}'.`);
    for (const l of t.openingTaskListIds) if (!taskLists.has(l)) err(`matter type '${t.id}' uses unknown task list '${l}'.`);
    for (const label of t.classifierLabels) {
      if (!label.startsWith(`${pack.id}_`) && label !== pack.id) err(`classifier label '${label}' does not belong to '${pack.id}'.`);
    }
  }

  // --- questions ---
  const qIds = pack.intake.questions.map((q) => q.id);
  for (const d of dupes(qIds)) err(`duplicate question '${d}'.`);
  const byId = new Map(pack.intake.questions.map((q) => [q.id, q]));
  for (const q of pack.intake.questions) {
    for (const t of q.matterTypes) if (!typeOk(t)) err(`question '${q.id}' names unknown matter type '${t}'.`);
    if ((q.answerType === "choice" || q.answerType === "multi_choice") && !(q.choices && q.choices.length > 0)) {
      err(`question '${q.id}' needs choices.`);
    }
    if (q.askWhen) {
      const parent = byId.get(q.askWhen.questionId);
      if (!parent) err(`question '${q.id}' depends on unknown question '${q.askWhen.questionId}'.`);
      else if (parent.order >= q.order) err(`question '${q.id}' must come after '${parent.id}', which it depends on.`);
    }
  }
  const safetyQs = pack.intake.questions.filter((q) => q.group === "safety");
  if (pack.intake.safety.askSafetyFirst) {
    if (safetyQs.length === 0) err("askSafetyFirst needs at least one safety question.");
    const lastSafety = Math.max(...safetyQs.map((q) => q.order));
    for (const q of pack.intake.questions) {
      if (q.group !== "safety" && q.order < lastSafety) err(`question '${q.id}' is asked before the safety questions finish.`);
    }
  }
  for (const q of safetyQs) {
    if (!q.askWhen && !(q.safetySignalAnswers && q.safetySignalAnswers.length > 0)) err(`safety question '${q.id}' has no safety-signal answers.`);
  }
  const caseOrders = pack.intake.questions.filter((q) => q.group === "case" || q.group === "finances").map((q) => q.order);
  const firstCase = caseOrders.length ? Math.min(...caseOrders) : Infinity;
  for (const q of pack.intake.questions.filter((x) => x.group === "parties")) {
    if (q.order > firstCase) err(`party question '${q.id}' must come before case details (conflict check first).`);
  }

  // --- safety handling: the conservative defaults are not optional ---
  const s = pack.intake.safety;
  if (!s.markClientDvSensitive) err("safety signals must mark the client contact DV-sensitive.");
  if (!s.neverUseSharedDevices) err("neverUseSharedDevices must be true.");
  if (s.safeContactDefaults.smsAllowed || s.safeContactDefaults.voicemailAllowed) err("SMS and voicemail must be off by default (DV-safe).");

  // --- client-facing copy goes through gates ---
  const drafts = new Map<string, string>();
  for (const item of packCopyItems(pack)) {
    if (!item.copyKey.startsWith(copyPrefix)) err(`${item.where}: copy key '${item.copyKey}' must start with '${copyPrefix}'.`);
    if (!item.draft.trim()) err(`${item.where}: empty draft.`);
    const prev = drafts.get(item.copyKey);
    if (prev !== undefined && prev !== item.draft) err(`copy key '${item.copyKey}' is reused with different wording.`);
    drafts.set(item.copyKey, item.draft);
  }

  // --- conflicts ---
  const roles = pack.conflicts.partyRoles;
  for (const d of dupes(roles.map((r) => r.id))) err(`duplicate party role '${d}'.`);
  for (const r of roles) for (const t of r.matterTypes) if (!typeOk(t)) err(`party role '${r.id}' names unknown matter type '${t}'.`);
  if (!roles.some((r) => r.adverseByDefault && r.askAtIntake && r.blocksClearIfUnnamed)) {
    err("at least one adverse party must be asked at intake and block a clear result when unnamed.");
  }

  // --- documents ---
  const folders: string[] = [];
  const walk = (nodes: PracticeAreaPack["documents"]["folderTemplate"]) => {
    for (const n of nodes) {
      folders.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(pack.documents.folderTemplate);
  for (const d of dupes(folders)) err(`duplicate folder '${d}'.`);
  const templates = new Map(pack.documents.templates.map((t) => [t.id, t]));
  for (const t of pack.documents.templates) {
    if (!ruleKeyOk(t.gateKey)) err(`template '${t.id}' gate '${t.gateKey}' is not a known rules gate.`);
    for (const mt of t.matterTypes) if (!typeOk(mt)) err(`template '${t.id}' names unknown matter type '${mt}'.`);
  }
  for (const c of pack.documents.checklists) {
    for (const d of dupes(c.items.map((i) => i.id))) err(`checklist '${c.id}' has duplicate item '${d}'.`);
    for (const i of c.items) {
      if (!folders.includes(i.folderId)) err(`checklist item '${i.id}' files into unknown folder '${i.folderId}'.`);
      if (i.templateId && !templates.has(i.templateId)) err(`checklist item '${i.id}' uses unknown template '${i.templateId}'.`);
      if (i.providedBy === "client" && !i.clientRequest) err(`client-provided item '${i.id}' needs gated request wording.`);
    }
  }

  // --- stages ---
  for (const t of pack.stages.tracks) {
    for (const d of dupes(t.stages.map((x) => x.id))) err(`track '${t.id}' has duplicate stage '${d}'.`);
    if (t.stages[t.stages.length - 1]?.systemStage !== "closed") err(`track '${t.id}' must end in a closed stage.`);
  }
  const allStages = new Set(pack.stages.tracks.flatMap((t) => t.stages.map((x) => x.id)));

  // --- rule references: no values, lawyer tools only, gated ---
  const ruleIds = new Set<string>();
  for (const r of pack.deadlines.rules) {
    if (ruleIds.has(r.id)) err(`duplicate rule reference '${r.id}'.`);
    ruleIds.add(r.id);
    if (!ruleKeyOk(r.gateKey)) err(`rule '${r.id}' gate '${r.gateKey}' must be '${rulePrefix}*' or a shared rules.* gate that exists.`);
    if (r.audience !== "lawyer_tool") err(`rule '${r.id}' must be a lawyer tool.`);
    for (const k of Object.keys(r)) {
      if (/value|days|period|percent|amount|months|years/i.test(k)) err(`rule '${r.id}' carries a value field '${k}'; values live in gated config.`);
    }
    for (const mt of r.matterTypes) if (!typeOk(mt)) err(`rule '${r.id}' names unknown matter type '${mt}'.`);
  }

  // --- tasks ---
  const kinds: string[] = [];
  for (const l of pack.tasks.lists) {
    if (l.trigger.on === "stage_entered" && !allStages.has(l.trigger.stageId)) err(`task list '${l.id}' triggers on unknown stage '${l.trigger.stageId}'.`);
    for (const mt of l.matterTypes) if (!typeOk(mt)) err(`task list '${l.id}' names unknown matter type '${mt}'.`);
    for (const t of l.tasks) {
      kinds.push(t.kind);
      if (!t.kind.startsWith(`all-engines.${pack.id}.`)) err(`task '${t.id}' kind '${t.kind}' must start with 'all-engines.${pack.id}.'.`);
      if (t.ruleRef && !ruleIds.has(t.ruleRef)) err(`task '${t.id}' points at unknown rule '${t.ruleRef}'.`);
      if (t.ruleRef && t.assigneeRole !== "lawyer") err(`task '${t.id}' applies a legal rule and must be assigned to a lawyer.`);
      if (t.dueBusinessDays !== undefined && (!Number.isInteger(t.dueBusinessDays) || t.dueBusinessDays < 0)) err(`task '${t.id}' due days must be a whole number ≥ 0.`);
      if (t.visibility === "client") err(`task '${t.id}': client-visible tasks need gated wording; packs ship internal tasks only.`);
    }
  }
  for (const d of dupes(kinds)) err(`duplicate task kind '${d}'.`);

  // --- billing ---
  const b = pack.billing;
  if (!b.offeredFeeTypes.includes(b.defaultFeeType)) err("the default fee type must be offered.");
  for (const w of b.withheldFeeTypes) {
    if (b.offeredFeeTypes.includes(w.feeType)) err(`fee type '${w.feeType}' is both offered and withheld.`);
    if (!ruleKeyOk(w.gateKey)) err(`withheld fee type '${w.feeType}' gate '${w.gateKey}' is not a known rules gate.`);
  }
  if (!ruleKeyOk(b.feeTermsGateKey)) err("fee terms gate is not a known rules gate.");
  if (b.trustGateKey !== "rules.trust_accounting") err("trust money must use the shared rules.trust_accounting gate.");
  return errors;
}

/** Deterministic JSON (sorted keys) for hashing and snapshots. Pure. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
