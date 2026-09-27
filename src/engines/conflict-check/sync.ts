// c56 §4.1–4.4 — filling the party index automatically, and running the
// check when parties arrive.
//
// Two entry points:
//  1. checkInquiry(): the intake flow names the prospective client and the
//     other parties (API: POST /api/conflict-check/checks). Every named party
//     is indexed with a pre-matter inquiry link — including prospects who are
//     later declined — and the check runs in the same transaction.
//  2. syncMatterParties() (worker tick): every engine adds parties to matters
//     through the shared `matter_parties` table. New links since the last run
//     are checked per matter, so a party added to a matter later is indexed
//     AND checked without any other engine importing this one.
//
// Matters that reach a declined stage without a letter get the c62 letter
// workflow started here too.

import { and, asc, eq, gt, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { matterParties, matters, parties } from "@/db/schema";
import { conflictChecks, conflictSyncState, nonEngagementLetters } from "@/db/tables/conflict-check";
import { audit, getFirmSettings, SYSTEM_ACTOR, type Actor } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, type ConflictAccess } from "./access";
import { runConflictCheck, type RunCheckResult } from "./checks";
import { startNonEngagementLetter } from "./letterService";
import { indexParty, recordUnknownParty } from "./partyIndex";
import { ENGINE, readConflictSettings } from "./settings";
import { ConflictError } from "./util";
import type { CheckTrigger, IndexRole, NameType, SearchedName } from "./types";
import { INDEX_ROLES, NAME_TYPES } from "./types";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface PartyForSearch {
  id: string;
  fullName: string;
  aliases: readonly string[];
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
}

/** Searched names for one party: the legal name plus each alias (so a maiden name is searched too). Pure. */
export function searchedNamesForParty(party: PartyForSearch, role: string): SearchedName[] {
  const base = { role, partyId: party.id, dateOfBirth: party.dateOfBirth, email: party.email, phone: party.phone };
  const names = [party.fullName, ...party.aliases].map((n) => n.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: SearchedName[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...base, name });
  }
  return out;
}

export interface NewLink {
  matterId: string;
  partyId: string;
  role: string;
  addedAt: Date;
}

/**
 * Group new matter-party links by matter, leaving out parties a check on
 * that matter already searched at or after the link was added (e.g. the
 * party was added through this engine's own API, which checks at once). Pure.
 */
export function groupNewLinks(
  links: readonly NewLink[],
  checkedSince: ReadonlyMap<string, ReadonlyArray<{ createdAt: Date; partyIds: readonly string[] }>>
): Map<string, NewLink[]> {
  const out = new Map<string, NewLink[]>();
  for (const l of links) {
    const covered = (checkedSince.get(l.matterId) ?? []).some(
      (c) => c.createdAt.getTime() >= l.addedAt.getTime() && c.partyIds.includes(l.partyId)
    );
    if (covered) continue;
    const list = out.get(l.matterId) ?? [];
    if (!list.some((x) => x.partyId === l.partyId && x.role === l.role)) list.push(l);
    out.set(l.matterId, list);
  }
  return out;
}

const PRE_ENGAGEMENT_STAGES = new Set(["prospective", "consultation_scheduled", "consult_completed_manual_follow_up", "pending_review"]);

/** 'intake' for a matter's first check before engagement; 'party_added' otherwise. Pure. */
export function triggerForMatter(stage: string, hasEarlierCheck: boolean): CheckTrigger {
  return !hasEarlierCheck && PRE_ENGAGEMENT_STAGES.has(stage) ? "intake" : "party_added";
}

/** Matter stages that end an inquiry with a non-engagement letter (c62 rule 1). Pure. */
export function declineTypeForStage(stage: string): "conflict" | "did_not_hire" | null {
  if (stage === "declined_conflict") return "conflict";
  if (stage === "did_not_hire_referred_out") return "did_not_hire";
  return null;
}

// ---------------------------------------------------------------------------
// Intake: index the named parties and run the check (c56 §4.1, c3)
// ---------------------------------------------------------------------------

export interface InquiryPartyInput {
  name?: string | null;
  role: IndexRole;
  relationship?: string | null;
  kind?: "person" | "organization";
  dateOfBirth?: string | null;
  email?: string | null;
  phone?: string | null;
  variants?: Array<{ name: string; type: NameType }>;
  /** The caller refused or could not name this party. The check can never be clear. */
  nameUnknown?: boolean;
  completeness?: "full" | "partial";
  /** A record already chosen earlier in THIS session (never an automatic merge). */
  reusePartyId?: string | null;
}

export interface CheckInquiryInput {
  tenantId: string;
  intakeSessionId: string;
  parties: InquiryPartyInput[];
  roleSought?: string | null;
  spokeWithUserIds?: string[];
  by?: Actor;
  now?: Date;
}

/** Validation errors for an inquiry check request (empty = valid). Pure. */
export function validateInquiryParties(list: readonly InquiryPartyInput[]): string[] {
  const errors: string[] = [];
  if (list.length === 0) errors.push("Name at least the prospective client.");
  if (!list.some((p) => p.role === "prospective_client")) errors.push("One party must be the prospective client.");
  list.forEach((p, i) => {
    if (!(INDEX_ROLES as readonly string[]).includes(p.role)) errors.push(`Party ${i + 1}: unknown role '${p.role}'.`);
    if (!p.nameUnknown && !p.name?.trim()) errors.push(`Party ${i + 1}: a name is required (or mark the name as unknown).`);
    if (p.nameUnknown && p.role === "prospective_client") errors.push(`Party ${i + 1}: the prospective client must be named.`);
    for (const v of p.variants ?? []) {
      if (!(NAME_TYPES as readonly string[]).includes(v.type)) errors.push(`Party ${i + 1}: unknown name type '${v.type}'.`);
    }
  });
  return errors;
}

export async function checkInquiry(tx: TenantTx, input: CheckInquiryInput): Promise<RunCheckResult & { partyIds: string[] }> {
  const errors = validateInquiryParties(input.parties);
  if (errors.length > 0) throw new ConflictError("The inquiry parties are not valid.", 422, errors);
  const now = input.now ?? new Date();
  const by = input.by ?? SYSTEM_ACTOR;
  const searched: SearchedName[] = [];
  const partyIds: string[] = [];

  for (const p of input.parties) {
    if (p.nameUnknown) {
      await recordUnknownParty(tx, { tenantId: input.tenantId, intakeSessionId: input.intakeSessionId, role: p.role, relationship: p.relationship, by });
      searched.push({ name: "", role: p.role, nameUnknown: true, completeness: "partial" });
      continue;
    }
    const indexed = await indexParty(tx, {
      tenantId: input.tenantId,
      name: p.name!,
      kind: p.kind,
      dateOfBirth: p.dateOfBirth,
      email: p.email,
      phone: p.phone,
      variants: p.variants,
      source: "intake",
      reusePartyId: p.reusePartyId,
      link: {
        type: "inquiry",
        intakeSessionId: input.intakeSessionId,
        role: p.role,
        relationship: p.relationship,
        nameCompleteness: p.completeness ?? "full",
        spokeWithUserIds: input.spokeWithUserIds,
      },
      by,
    });
    partyIds.push(indexed.partyId);
    const base = { role: p.role, partyId: indexed.partyId, completeness: p.completeness, dateOfBirth: p.dateOfBirth, email: p.email, phone: p.phone };
    searched.push({ ...base, name: p.name!.trim() });
    for (const v of p.variants ?? []) searched.push({ ...base, name: v.name.trim() });
  }

  const result = await runConflictCheck(tx, {
    tenantId: input.tenantId,
    trigger: "intake",
    subject: { type: "intake_session", id: input.intakeSessionId },
    searched,
    roleSought: input.roleSought ?? null,
    triggeredBy: by,
    now,
  });
  return { ...result, partyIds };
}

// ---------------------------------------------------------------------------
// Worker: new matter parties → checks (c56 §4.4, c58)
// ---------------------------------------------------------------------------

async function loadState(tx: TenantTx, tenantId: string, now: Date) {
  const [row] = await tx.select().from(conflictSyncState).where(eq(conflictSyncState.tenantId, tenantId)).limit(1);
  if (row) return { row, baselined: false };
  // First run for this firm: existing links are history (c96 import), not new work.
  const [created] = await tx
    .insert(conflictSyncState)
    .values({ tenantId, baselineAt: now, matterPartiesCursor: now, lastRunAt: now })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [again] = await tx.select().from(conflictSyncState).where(eq(conflictSyncState.tenantId, tenantId)).limit(1);
    return { row: again!, baselined: false };
  }
  await audit(tx, { tenantId, engine: ENGINE, action: "index.sync_baselined", payload: { baselineAt: now.toISOString() } });
  return { row: created, baselined: true };
}

export interface SyncSummary {
  links: number;
  checks: number;
  letters: number;
  baselined: boolean;
}

export async function syncMatterParties(tx: TenantTx, tenantId: string, now: Date, opts: { limit?: number } = {}): Promise<SyncSummary> {
  const { row: state, baselined } = await loadState(tx, tenantId, now);
  if (baselined) return { links: 0, checks: 0, letters: 0, baselined };

  const links = await tx
    .select({ id: matterParties.id, matterId: matterParties.matterId, partyId: matterParties.partyId, role: matterParties.role, addedAt: matterParties.addedAt })
    .from(matterParties)
    .where(
      and(
        eq(matterParties.tenantId, tenantId),
        isNull(matterParties.endedAt),
        // Keyset cursor on (added_at, id): rows inserted in one transaction share added_at.
        state.matterPartiesCursorId
          ? or(
              gt(matterParties.addedAt, state.matterPartiesCursor),
              and(eq(matterParties.addedAt, state.matterPartiesCursor), gt(matterParties.id, state.matterPartiesCursorId))
            )
          : gt(matterParties.addedAt, state.matterPartiesCursor)
      )
    )
    .orderBy(asc(matterParties.addedAt), asc(matterParties.id))
    .limit(opts.limit ?? 500);

  let checks = 0;
  if (links.length > 0) {
    const matterIds = [...new Set(links.map((l) => l.matterId))];
    const earliest = links[0]!.addedAt;
    const recentChecks = await tx
      .select({ matterId: conflictChecks.matterId, createdAt: conflictChecks.createdAt, searchedNames: conflictChecks.searchedNames })
      .from(conflictChecks)
      .where(and(eq(conflictChecks.tenantId, tenantId), inArray(conflictChecks.matterId, matterIds)));
    const checkedSince = new Map<string, Array<{ createdAt: Date; partyIds: string[] }>>();
    const hasEarlier = new Set<string>();
    for (const c of recentChecks) {
      if (!c.matterId) continue;
      hasEarlier.add(c.matterId);
      if (c.createdAt.getTime() < earliest.getTime()) continue;
      const ids = (c.searchedNames as SearchedName[]).map((s) => s.partyId).filter((x): x is string => !!x);
      const list = checkedSince.get(c.matterId) ?? [];
      list.push({ createdAt: c.createdAt, partyIds: ids });
      checkedSince.set(c.matterId, list);
    }

    const grouped = groupNewLinks(links, checkedSince);
    const partyIds = [...new Set([...grouped.values()].flat().map((l) => l.partyId))];
    const [partyRows, matterRows] = await Promise.all([
      partyIds.length
        ? tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), inArray(parties.id, partyIds)))
        : Promise.resolve([] as Array<typeof parties.$inferSelect>),
      tx.select({ id: matters.id, stage: matters.stage }).from(matters).where(and(eq(matters.tenantId, tenantId), inArray(matters.id, matterIds))),
    ]);
    const partyById = new Map(partyRows.map((p) => [p.id, p]));
    const stageById = new Map(matterRows.map((m) => [m.id, m.stage as string]));

    for (const [matterId, list] of grouped) {
      const searched = list.flatMap((l) => {
        const p = partyById.get(l.partyId);
        return p ? searchedNamesForParty(p, l.role) : [];
      });
      if (searched.length === 0) continue;
      await runConflictCheck(tx, {
        tenantId,
        trigger: triggerForMatter(stageById.get(matterId) ?? "retained", hasEarlier.has(matterId)),
        subject: { type: "matter", id: matterId },
        searched,
        triggeredBy: SYSTEM_ACTOR,
        now,
      });
      checks++;
    }
  }

  const letters = await startMissingLetters(tx, tenantId, state.baselineAt, now);
  await tx
    .update(conflictSyncState)
    .set({
      matterPartiesCursor: links.at(-1)?.addedAt ?? state.matterPartiesCursor,
      matterPartiesCursorId: links.at(-1)?.id ?? state.matterPartiesCursorId,
      lastRunAt: now,
    })
    .where(eq(conflictSyncState.id, state.id));
  return { links: links.length, checks, letters, baselined: false };
}

/** Matters opened since the baseline that reached a declined stage without a letter (c62 §4.1). */
async function startMissingLetters(tx: TenantTx, tenantId: string, baselineAt: Date, now: Date): Promise<number> {
  const rows = await tx
    .select({ id: matters.id, stage: matters.stage, primaryPartyId: matters.primaryPartyId, practiceArea: matters.practiceArea })
    .from(matters)
    .where(
      and(
        eq(matters.tenantId, tenantId),
        inArray(matters.stage, ["declined_conflict", "did_not_hire_referred_out"]),
        gt(matters.openedAt, baselineAt),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(nonEngagementLetters)
            .where(and(eq(nonEngagementLetters.tenantId, tenantId), eq(nonEngagementLetters.matterId, matters.id)))
        )
      )
    )
    .limit(50);
  if (rows.length === 0) return 0;
  const settings = readConflictSettings(await getFirmSettings(tx, tenantId));
  let started = 0;
  for (const m of rows) {
    const declineType = declineTypeForStage(m.stage);
    // No letter row is written when none is required, so skip here rather than re-deciding every tick.
    if (!declineType || (declineType === "did_not_hire" && !settings.letterForDidNotHire)) continue;
    const letter = await startNonEngagementLetter(tx, {
      tenantId,
      prospectPartyId: m.primaryPartyId,
      declineType,
      matterId: m.id,
      practiceArea: m.practiceArea,
      now,
    });
    if (letter) started++;
  }
  return started;
}

/**
 * Re-run a check over every current party of a matter (conflicts role), e.g.
 * when a matter is reopened or the conflicts attorney wants a fresh result.
 */
export async function checkMatter(
  tx: TenantTx,
  input: { tenantId: string; matterId: string; trigger?: "manual" | "reopened" | "periodic"; access: ConflictAccess; now?: Date }
): Promise<RunCheckResult> {
  assertCan(input.access, "index.edit");
  const rows = await tx
    .select({ party: parties, role: matterParties.role })
    .from(matterParties)
    .innerJoin(parties, eq(parties.id, matterParties.partyId))
    .where(and(eq(matterParties.tenantId, input.tenantId), eq(matterParties.matterId, input.matterId), isNull(matterParties.endedAt)));
  if (rows.length === 0) throw new ConflictError("This matter has no current parties to check.", 422);
  return runConflictCheck(tx, {
    tenantId: input.tenantId,
    trigger: input.trigger ?? "manual",
    subject: { type: "matter", id: input.matterId },
    searched: rows.flatMap((r) => searchedNamesForParty(r.party, r.role)),
    triggeredBy: { type: "user", userId: input.access.userId },
    now: input.now,
  });
}
