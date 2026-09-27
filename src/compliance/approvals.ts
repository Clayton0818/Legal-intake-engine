// Approval placeholders (founder instruction, 2026-09-26): "write real working
// code, but let the parts that need approval have a placeholder."
//
// Anything that needs a licensed attorney, a CPA, a vendor DPA, or a founder
// decision before it can be relied on is declared once as a GATE:
//
//   export const FEE_TERMS = defineGate({
//     key: "copy.billing.evergreen_term",
//     cardIds: ["c50", "c39"],
//     reviewers: ["attorney"],
//     description: "Evergreen / minimum-balance term in the engagement agreement",
//     draft: "…optional proposed wording…",
//   });
//
// and then used in one of three ways:
//
//   legalCopy(key, vars?)   user-facing wording. Returns the approved text, or
//                           a VISIBLE placeholder "[PENDING ATTORNEY REVIEW —
//                           … (gate: key)]" until every reviewer signed off.
//   requireApproval(key)    before a gated ACTION (moving trust money, calling
//                           a vendor, applying a legal rule). Throws
//                           PendingApprovalError and logs the blocked attempt —
//                           it never silently proceeds.
//   runGated(key, action, fn)  the same, but returns a result object instead
//                           of throwing, for code that wants to record
//                           "blocked" and carry on with something else.
//
// Approvals themselves are data (table `compliance_approvals`), loaded into an
// in-process snapshot by refreshApprovals()/ensureApprovalsLoaded(). Until a
// snapshot with a matching approval is loaded, EVERY gate is closed — the
// default state fails safe.
//
// This file has no Node-only or database imports so client components can call
// legalCopy() too. The DB-backed source is in ./dbApprovalSource.ts.

export type ReviewerKind = "attorney" | "cpa" | "vendor_dpa" | "founder_decision";

export const REVIEWER_KINDS: readonly ReviewerKind[] = [
  "attorney",
  "cpa",
  "vendor_dpa",
  "founder_decision",
] as const;

export interface GateDefinition {
  /** Stable dotted key, e.g. 'vendor.email', 'copy.intake.ai_disclosure', 'rules.trust_accounting'. */
  key: string;
  /** Board cards this gate belongs to, e.g. ['c51']. */
  cardIds: string[];
  /** Every listed reviewer kind must approve before the gate opens. */
  reviewers: ReviewerKind[];
  /** Plain-words description; shown inside the placeholder. */
  description: string;
  /** Optional proposed wording (copy gates). Shown only once approved. */
  draft?: string;
}

export interface Gate {
  readonly key: string;
  readonly description: string;
  readonly draft?: string;
  readonly reviewers: readonly ReviewerKind[];
  readonly cardIds: readonly string[];
  /** Hash of `draft`; an approval recorded against an older draft no longer counts. */
  readonly draftHash: string | null;
}

export interface ApprovalRecord {
  gateKey: string;
  reviewerKind: ReviewerKind;
  approvedByName: string;
  approvedAt: Date;
  notes?: string | null;
  /** The exact approved wording, if the reviewer supplied/edited it. Overrides the draft. */
  approvedText?: string | null;
  /** draftHash of the draft the reviewer saw (required when approving a draft without approvedText). */
  draftHash?: string | null;
  revokedAt?: Date | null;
}

export interface ApprovalSource {
  readonly name: string;
  load(): Promise<ApprovalRecord[]>;
}

export interface GateStatus {
  gate: Gate;
  approved: boolean;
  /** Reviewer kinds that have not (validly) approved yet. */
  pendingReviewers: ReviewerKind[];
  /** Valid, unrevoked approvals counted toward this gate. */
  approvals: ApprovalRecord[];
  /** Approved wording (approvedText ?? draft) when approved; null otherwise. */
  approvedText: string | null;
}

export interface BlockedActionEvent {
  gateKey: string;
  action: string | null;
  pendingReviewers: ReviewerKind[];
  tenantId: string | null;
  detail: Record<string, unknown> | null;
  at: Date;
}

export interface GateContext {
  /** What was attempted, e.g. 'trust.disburse' or 'email.send'. */
  action?: string;
  tenantId?: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PendingApprovalError extends Error {
  readonly gateKey: string;
  readonly pendingReviewers: ReviewerKind[];
  readonly placeholder: string;
  readonly action: string | null;

  constructor(status: GateStatus, action: string | null) {
    const placeholder = placeholderText(status.gate, status.pendingReviewers);
    super(
      `Blocked${action ? ` '${action}'` : ""}: approval gate '${status.gate.key}' is pending ` +
        `${status.pendingReviewers.join(" + ")} review. ${placeholder}`
    );
    this.name = "PendingApprovalError";
    this.gateKey = status.gate.key;
    this.pendingReviewers = status.pendingReviewers;
    this.placeholder = placeholder;
    this.action = action;
  }
}

export class UnknownGateError extends Error {
  constructor(key: string) {
    super(
      `Unknown approval gate '${key}'. Define it with defineGate() and make sure the ` +
        `module that defines it is imported (engines: src/engines/<slug>/gates.ts).`
    );
    this.name = "UnknownGateError";
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, Gate>();

const KEY_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;

/** Small, dependency-free, deterministic string hash (FNV-1a, two seeds → 16 hex chars). */
export function hashDraft(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function sameDefinition(a: Gate, b: Gate): boolean {
  return (
    a.description === b.description &&
    a.draftHash === b.draftHash &&
    a.reviewers.join(",") === b.reviewers.join(",") &&
    a.cardIds.join(",") === b.cardIds.join(",")
  );
}

/**
 * Declare an approval gate. Idempotent for an identical definition (so hot
 * reload and repeated imports are harmless); a DIFFERENT definition under an
 * existing key throws — two engines must not silently share a key.
 */
export function defineGate(def: GateDefinition): Gate {
  if (!KEY_PATTERN.test(def.key)) {
    throw new Error(
      `Invalid gate key '${def.key}': use lowercase dotted keys like 'vendor.email' or 'copy.billing.replenish_request'.`
    );
  }
  if (def.reviewers.length === 0) {
    throw new Error(`Gate '${def.key}' must name at least one reviewer kind.`);
  }
  for (const r of def.reviewers) {
    if (!REVIEWER_KINDS.includes(r)) throw new Error(`Gate '${def.key}': unknown reviewer kind '${r}'.`);
  }
  if (!def.description.trim()) throw new Error(`Gate '${def.key}' needs a description.`);

  const gate: Gate = Object.freeze({
    key: def.key,
    cardIds: Object.freeze([...def.cardIds]),
    reviewers: Object.freeze([...new Set(def.reviewers)]),
    description: def.description.trim(),
    draft: def.draft,
    draftHash: def.draft === undefined ? null : hashDraft(def.draft),
  });

  const existing = registry.get(def.key);
  if (existing) {
    if (sameDefinition(existing, gate)) return existing;
    throw new Error(`Approval gate '${def.key}' is already defined with a different definition.`);
  }
  registry.set(def.key, gate);
  return gate;
}

export function getGate(key: string): Gate {
  const gate = registry.get(key);
  if (!gate) throw new UnknownGateError(key);
  return gate;
}

export function hasGate(key: string): boolean {
  return registry.has(key);
}

/** Every gate registered so far (import src/compliance/allGates.ts first for the full list). */
export function listGates(): Gate[] {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Approval snapshot
// ---------------------------------------------------------------------------

let approvalsByGate = new Map<string, ApprovalRecord[]>();
let snapshotLoadedAt: number | null = null;
let source: ApprovalSource | null = null;
let blockedSink: (event: BlockedActionEvent) => void = defaultBlockedSink;

function defaultBlockedSink(event: BlockedActionEvent): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "approval.blocked",
      gate: event.gateKey,
      action: event.action,
      pendingReviewers: event.pendingReviewers,
      tenantId: event.tenantId,
      at: event.at.toISOString(),
    })
  );
}

/** Replace the in-process approval snapshot directly (tests, scripts). */
export function setApprovals(records: readonly ApprovalRecord[]): void {
  const next = new Map<string, ApprovalRecord[]>();
  for (const r of records) {
    const list = next.get(r.gateKey) ?? [];
    list.push(r);
    next.set(r.gateKey, list);
  }
  approvalsByGate = next;
  snapshotLoadedAt = Date.now();
}

/** Choose where approvals are loaded from (DbApprovalSource in the app and worker). */
export function setApprovalSource(next: ApprovalSource | null): void {
  source = next;
  snapshotLoadedAt = null;
}

export function getApprovalSource(): ApprovalSource | null {
  return source;
}

/** Reload the snapshot from the configured source. With no source, nothing is approved. */
export async function refreshApprovals(): Promise<void> {
  if (!source) {
    setApprovals([]);
    return;
  }
  setApprovals(await source.load());
}

/** Reload only if the snapshot is older than `maxAgeMs` (default 60s). Call at request/tick start. */
export async function ensureApprovalsLoaded(maxAgeMs = 60_000): Promise<void> {
  if (snapshotLoadedAt !== null && Date.now() - snapshotLoadedAt < maxAgeMs) return;
  await refreshApprovals();
}

/** Where blocked attempts are logged. Default: one JSON line on console.warn. */
export function setBlockedActionSink(sink: (event: BlockedActionEvent) => void): void {
  blockedSink = sink;
}

/** Test helper: clears approvals, source and sink (gate definitions are kept). */
export function resetApprovalStateForTests(): void {
  approvalsByGate = new Map();
  snapshotLoadedAt = null;
  source = null;
  blockedSink = defaultBlockedSink;
}

function approvalCounts(gate: Gate, record: ApprovalRecord): boolean {
  if (record.revokedAt) return false;
  if (!gate.reviewers.includes(record.reviewerKind)) return false;
  // A reviewer who approved a draft approved THAT draft: if the draft has
  // changed since, the approval no longer counts — unless they recorded the
  // exact wording themselves (approvedText), which is what will be shown.
  if (gate.draftHash !== null && !record.approvedText) {
    return record.draftHash === gate.draftHash;
  }
  return true;
}

export function gateStatus(key: string): GateStatus {
  const gate = getGate(key);
  const valid = (approvalsByGate.get(key) ?? []).filter((r) => approvalCounts(gate, r));
  const pendingReviewers = gate.reviewers.filter((kind) => !valid.some((r) => r.reviewerKind === kind));
  const approved = pendingReviewers.length === 0;

  let approvedText: string | null = null;
  if (approved) {
    const withText = valid
      .filter((r) => r.approvedText)
      .sort((a, b) => b.approvedAt.getTime() - a.approvedAt.getTime())[0];
    approvedText = withText?.approvedText ?? gate.draft ?? null;
  }
  return { gate, approved, pendingReviewers: [...pendingReviewers], approvals: valid, approvedText };
}

export function isApproved(key: string): boolean {
  return gateStatus(key).approved;
}

// ---------------------------------------------------------------------------
// Placeholders and user-facing copy
// ---------------------------------------------------------------------------

function reviewerLabel(kind: ReviewerKind): string {
  return kind.replace(/_/g, " ").toUpperCase();
}

function placeholderText(gate: Gate, pending: readonly ReviewerKind[]): string {
  const who = (pending.length > 0 ? pending : gate.reviewers).map(reviewerLabel).join(" + ");
  return `[PENDING ${who} REVIEW — ${gate.description} (gate: ${gate.key})]`;
}

/** The visible placeholder for a gate: "[PENDING ATTORNEY REVIEW — <description> (gate: <key>)]". */
export function placeholderFor(key: string): string {
  const status = gateStatus(key);
  return placeholderText(status.gate, status.pendingReviewers);
}

/** True when `text` is (or contains) an approval placeholder. */
export function isPlaceholder(text: string): boolean {
  return /\[PENDING [A-Z +]+ REVIEW — .*\(gate: [a-z0-9_.-]+\)\]/.test(text);
}

/** Replace `{name}` tokens; unknown tokens are left untouched so gaps stay visible. */
export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/**
 * User-facing legal wording. Approved → the approved text with `{vars}`
 * filled in. Not approved (or approved with no text on record) → the visible
 * placeholder. Never throws for a pending gate; throws UnknownGateError for
 * an undefined key so typos surface in development.
 */
export function legalCopy(key: string, vars?: Record<string, string | number>): string {
  const status = gateStatus(key);
  if (status.approved && status.approvedText !== null) {
    return interpolate(status.approvedText, vars);
  }
  return placeholderText(status.gate, status.pendingReviewers);
}

/** Like legalCopy(), but tells the caller whether it got real wording (e.g. to hold an outbound email). */
export function legalCopyStatus(
  key: string,
  vars?: Record<string, string | number>
): { text: string; approved: boolean; pendingReviewers: ReviewerKind[] } {
  const status = gateStatus(key);
  const approved = status.approved && status.approvedText !== null;
  return {
    text: approved ? interpolate(status.approvedText as string, vars) : placeholderText(status.gate, status.pendingReviewers),
    approved,
    pendingReviewers: status.pendingReviewers,
  };
}

// ---------------------------------------------------------------------------
// Gated actions
// ---------------------------------------------------------------------------

/**
 * Guard a gated action. Returns normally only when every reviewer approved.
 * Otherwise logs the blocked attempt (see setBlockedActionSink) and throws
 * PendingApprovalError — callers must let it propagate or record it; never
 * swallow it and carry on as if the action happened.
 */
export function requireApproval(key: string, context: GateContext = {}): void {
  const status = gateStatus(key);
  if (status.approved) return;
  const err = new PendingApprovalError(status, context.action ?? null);
  try {
    blockedSink({
      gateKey: key,
      action: context.action ?? null,
      pendingReviewers: status.pendingReviewers,
      tenantId: context.tenantId ?? null,
      detail: context.detail ?? null,
      at: new Date(),
    });
  } catch {
    // Logging must never turn a safe "blocked" into an unexpected crash path.
  }
  throw err;
}

export type GatedResult<T> =
  | { ok: true; value: T }
  | { ok: false; blocked: PendingApprovalError };

/** requireApproval() + run `fn`, returning a result object instead of throwing when blocked. */
export async function runGated<T>(
  key: string,
  action: string,
  fn: () => T | Promise<T>,
  context: Omit<GateContext, "action"> = {}
): Promise<GatedResult<T>> {
  try {
    requireApproval(key, { ...context, action });
  } catch (err) {
    if (err instanceof PendingApprovalError) return { ok: false, blocked: err };
    throw err;
  }
  return { ok: true, value: await fn() };
}

// ---------------------------------------------------------------------------
// Approval sources
// ---------------------------------------------------------------------------

/** Approvals held in memory — tests, local demos, scripts. */
export class InMemoryApprovalSource implements ApprovalSource {
  readonly name = "memory";
  private records: ApprovalRecord[];

  constructor(records: ApprovalRecord[] = []) {
    this.records = [...records];
  }

  /**
   * Record a sign-off. When the gate has a draft and no `approvedText` is
   * given, the current draft's hash is recorded, as the CLI does.
   */
  approve(
    record: Omit<ApprovalRecord, "approvedAt" | "draftHash"> & { approvedAt?: Date; draftHash?: string | null }
  ): ApprovalRecord {
    const gate = registry.get(record.gateKey);
    const full: ApprovalRecord = {
      ...record,
      approvedAt: record.approvedAt ?? new Date(),
      draftHash: record.draftHash ?? gate?.draftHash ?? null,
    };
    this.records.push(full);
    return full;
  }

  revoke(gateKey: string, reviewerKind: ReviewerKind, at: Date = new Date()): void {
    for (const r of this.records) {
      if (r.gateKey === gateKey && r.reviewerKind === reviewerKind && !r.revokedAt) r.revokedAt = at;
    }
  }

  async load(): Promise<ApprovalRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }
}

// The database-backed source lives in ./dbApprovalSource.ts so this module
// stays free of database imports (safe for client components and unit tests).
