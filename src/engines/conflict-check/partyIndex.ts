// c56 — the party index: one per-firm list of everyone the firm has ever
// dealt with. Every read and write takes a withTenant() transaction and adds
// an explicit tenant filter on top of RLS (defence in depth, ADR-0001 §D5).
//
// The index is the shared `parties` table (every engine writes it) plus this
// engine's typed name variants, organisation links, pre-matter inquiry
// links and merge records. Lateral-hire lists (c61) and lawyer interests
// (c97) live in their own restricted tables and are searched ALONGSIDE the
// index (loadIndexEntries), never merged into `parties`.

import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { matters, matterParties, parties, type partyRoleEnum } from "@/db/schema";
import {
  inquiryParties,
  interestDisclosures,
  lateralChecks,
  lateralPriorMatters,
  importedInvolvements,
  importedMatters,
  partyAddresses,
  partyMatchKeys,
  partyMergeSuggestions,
  partyMerges,
  partyNameVariants,
  partyOrgLinks,
  partyRetentionRequests,
} from "@/db/tables/conflict-check";
import { audit, auditBlocked, normalizeName, SYSTEM_ACTOR, type Actor } from "@/core";
import { requireApproval, PendingApprovalError } from "@/compliance/approvals";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, type ConflictAccess } from "./access";
import { findDuplicatePairs, pairKey, type DedupeCandidate } from "./dedupe";
import { CONFLICT_RULE_GATES } from "./gates";
import { matchIndex, tokens, type OrgLink } from "./matching";
import { matchKeysForName, normalizeAddress } from "./nameRules";
import { ENGINE } from "./settings";
import { ConflictError } from "./util";
import type { IndexEntry, IndexRole, IndexSourceType, Involvement, NameSource, NameType } from "./types";

export type MatterPartyRole = (typeof partyRoleEnum.enumValues)[number];

function actorOf(access: ConflictAccess | Actor | undefined): Actor {
  if (!access) return SYSTEM_ACTOR;
  if ("caps" in access) return { type: "user", userId: access.userId };
  return access;
}

// ---------------------------------------------------------------------------
// Writes: parties, variants, links
// ---------------------------------------------------------------------------

export interface IndexPartyInput {
  tenantId: string;
  name: string;
  kind?: "person" | "organization";
  dateOfBirth?: string | null;
  email?: string | null;
  phone?: string | null;
  variants?: ReadonlyArray<{ name: string; type: NameType }>;
  /** Postal address (secondary identifier, c57). */
  address?: string | null;
  source: NameSource;
  /** Reuse only a record already selected in THIS intake session (c56 §4.1.3); never auto-merge otherwise. */
  reusePartyId?: string | null;
  link?:
    | {
        type: "inquiry";
        intakeSessionId: string;
        role: IndexRole;
        relationship?: string | null;
        nameCompleteness?: "full" | "partial";
        spokeWithUserIds?: string[];
      }
    | { type: "matter"; matterId: string; role: MatterPartyRole; relationship?: string | null; isAdverse?: boolean | null };
  by?: ConflictAccess | Actor;
}

export interface IndexPartyResult {
  partyId: string;
  linkId: string | null;
  created: boolean;
  suggestions: number;
}

/**
 * Put a party in the index (creating or reusing the record), add its name
 * variants, link it to an inquiry or matter, and queue duplicate suggestions.
 * Runs in the caller's transaction so the party is searchable by the very
 * next check (c56 §4.1.4).
 */
export async function indexParty(tx: TenantTx, input: IndexPartyInput): Promise<IndexPartyResult> {
  const name = input.name.trim();
  if (!name) throw new ConflictError("indexParty: a name is required (use recordUnknownParty when the caller will not name them).");
  const actor = actorOf(input.by);
  let partyId = input.reusePartyId ?? null;
  let created = false;

  if (partyId) {
    const [existing] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, partyId)))
      .limit(1);
    if (!existing) throw new ConflictError("indexParty: the party to reuse does not exist in this firm.", 404);
  } else {
    const [row] = await tx
      .insert(parties)
      .values({
        tenantId: input.tenantId,
        fullName: name,
        normalizedName: normalizeName(name),
        kind: input.kind ?? "person",
        dateOfBirth: input.dateOfBirth ?? null,
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
      })
      .returning({ id: parties.id });
    partyId = row!.id;
    created = true;
    await addMatchKeys(tx, input.tenantId, partyId, [normalizeName(name)]);
  }
  if (input.address?.trim()) await addPartyAddress(tx, input.tenantId, partyId, input.address, input.source);

  for (const v of input.variants ?? []) {
    await addNameVariantRow(tx, input.tenantId, partyId, v.name, v.type, input.source, actor);
  }

  let linkId: string | null = null;
  if (input.link?.type === "inquiry") {
    const [row] = await tx
      .insert(inquiryParties)
      .values({
        tenantId: input.tenantId,
        intakeSessionId: input.link.intakeSessionId,
        partyId,
        role: input.link.role,
        relationship: input.link.relationship ?? null,
        nameCompleteness: input.link.nameCompleteness ?? "full",
        spokeWithUserIds: input.link.spokeWithUserIds ?? [],
      })
      .returning({ id: inquiryParties.id });
    linkId = row!.id;
  } else if (input.link?.type === "matter") {
    const [row] = await tx
      .insert(matterParties)
      .values({
        tenantId: input.tenantId,
        matterId: input.link.matterId,
        partyId,
        role: input.link.role,
        relationship: input.link.relationship ?? null,
        isAdverse: input.link.isAdverse ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: matterParties.id });
    linkId = row?.id ?? null;
  }

  const suggestions = await suggestDuplicatesFor(tx, input.tenantId, partyId);

  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: created ? "index.party_added" : "index.party_linked",
    entityType: "party",
    entityId: partyId,
    matterId: input.link?.type === "matter" ? input.link.matterId : null,
    intakeSessionId: input.link?.type === "inquiry" ? input.link.intakeSessionId : null,
    actor,
    payload: { source: input.source, linkType: input.link?.type ?? null, role: input.link?.role ?? null, suggestions },
  });
  return { partyId, linkId, created, suggestions };
}

/** Store c57 match keys for some normalised names of a party (idempotent). */
export async function addMatchKeys(tx: TenantTx, tenantId: string, partyId: string, normalizedNames: readonly string[]): Promise<number> {
  const keys = [...new Set(normalizedNames.flatMap((n) => matchKeysForName(n)))];
  if (keys.length === 0) return 0;
  const rows = await tx
    .insert(partyMatchKeys)
    .values(keys.map((key) => ({ tenantId, partyId, key })))
    .onConflictDoNothing()
    .returning({ id: partyMatchKeys.id });
  return rows.length;
}

/** Record a postal address for a party (idempotent). */
export async function addPartyAddress(tx: TenantTx, tenantId: string, partyId: string, address: string, source: NameSource): Promise<void> {
  const normalized = normalizeAddress(address);
  if (!normalized) return;
  await tx
    .insert(partyAddresses)
    .values({ tenantId, partyId, address: address.trim(), normalizedAddress: normalized, source })
    .onConflictDoNothing();
}

/**
 * Build match keys for parties written by other engines (keyset on
 * parties.updated_at, id). Called from the worker; derived data only.
 */
export async function backfillMatchKeys(
  tx: TenantTx,
  tenantId: string,
  cursor: { at: Date | null; id: string | null },
  limit = 500
): Promise<{ processed: number; keys: number; cursor: { at: Date | null; id: string | null } }> {
  const after = cursor.at
    ? cursor.id
      ? or(sql`${parties.updatedAt} > ${cursor.at}`, and(eq(parties.updatedAt, cursor.at), sql`${parties.id} > ${cursor.id}`))
      : sql`${parties.updatedAt} > ${cursor.at}`
    : undefined;
  const rows = await tx
    .select({ id: parties.id, normalizedName: parties.normalizedName, normalizedAliases: parties.normalizedAliases, updatedAt: parties.updatedAt })
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), after))
    .orderBy(parties.updatedAt, parties.id)
    .limit(limit);
  let keys = 0;
  for (const r of rows) keys += await addMatchKeys(tx, tenantId, r.id, [r.normalizedName, ...r.normalizedAliases]);
  const last = rows.at(-1);
  return { processed: rows.length, keys, cursor: last ? { at: last.updatedAt, id: last.id } : cursor };
}

/** A party the caller will not (or cannot) name: the check for this inquiry can never be clear (c56 rule 7). */
export async function recordUnknownParty(
  tx: TenantTx,
  input: { tenantId: string; intakeSessionId: string; role: IndexRole; relationship?: string | null; by?: Actor }
): Promise<string> {
  const [row] = await tx
    .insert(inquiryParties)
    .values({
      tenantId: input.tenantId,
      intakeSessionId: input.intakeSessionId,
      partyId: null,
      role: input.role,
      relationship: input.relationship ?? null,
      nameUnknown: true,
      nameCompleteness: "partial",
    })
    .returning({ id: inquiryParties.id });
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.unknown_party_recorded",
    entityType: "inquiry_party",
    entityId: row!.id,
    intakeSessionId: input.intakeSessionId,
    actor: input.by ?? SYSTEM_ACTOR,
    payload: { role: input.role, relationship: input.relationship ?? null },
  });
  return row!.id;
}

async function addNameVariantRow(
  tx: TenantTx,
  tenantId: string,
  partyId: string,
  name: string,
  type: NameType,
  source: NameSource,
  actor: Actor
): Promise<boolean> {
  const clean = name.trim();
  const normalized = normalizeName(clean);
  if (!normalized) return false;
  const inserted = await tx
    .insert(partyNameVariants)
    .values({
      tenantId,
      partyId,
      name: clean,
      normalizedName: normalized,
      nameType: type,
      source,
      createdByUserId: actor.type === "user" ? actor.userId : null,
    })
    .onConflictDoNothing()
    .returning({ id: partyNameVariants.id });
  if (inserted.length === 0) return false;
  await addMatchKeys(tx, tenantId, partyId, [normalized]);
  // Keep the untyped mirror on `parties` in sync for engines that only read that table.
  await tx
    .update(parties)
    .set({
      aliases: sql`array_append(${parties.aliases}, ${clean})`,
      normalizedAliases: sql`array_append(${parties.normalizedAliases}, ${normalized})`,
      updatedAt: new Date(),
    })
    .where(and(eq(parties.tenantId, tenantId), eq(parties.id, partyId), sql`not (${normalized} = any(${parties.normalizedAliases}))`));
  return true;
}

/** Add a name variant (conflicts role). */
export async function addNameVariant(
  tx: TenantTx,
  input: { tenantId: string; partyId: string; name: string; type: NameType; source?: NameSource; access: ConflictAccess }
): Promise<boolean> {
  assertCan(input.access, "index.edit");
  const added = await addNameVariantRow(tx, input.tenantId, input.partyId, input.name, input.type, input.source ?? "manual", actorOf(input.access));
  if (added) {
    await audit(tx, {
      tenantId: input.tenantId,
      engine: ENGINE,
      action: "index.variant_added",
      entityType: "party",
      entityId: input.partyId,
      actor: actorOf(input.access),
      payload: { nameType: input.type },
    });
    await suggestDuplicatesFor(tx, input.tenantId, input.partyId);
  }
  return added;
}

/** Link two organisations (parent/subsidiary or affiliate). */
export async function addOrgLink(
  tx: TenantTx,
  input: { tenantId: string; parentPartyId: string; childPartyId: string; linkType: "parent_subsidiary" | "affiliate"; access: ConflictAccess }
): Promise<void> {
  assertCan(input.access, "index.edit");
  if (input.parentPartyId === input.childPartyId) throw new ConflictError("An organisation cannot be linked to itself.");
  await tx
    .insert(partyOrgLinks)
    .values({
      tenantId: input.tenantId,
      parentPartyId: input.parentPartyId,
      childPartyId: input.childPartyId,
      linkType: input.linkType,
      createdByUserId: input.access.userId,
    })
    .onConflictDoNothing();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.org_link_added",
    entityType: "party",
    entityId: input.parentPartyId,
    actor: actorOf(input.access),
    payload: { childPartyId: input.childPartyId, linkType: input.linkType },
  });
}

/** An inquiry ended (declined, conflicted out, did not hire, abandoned): links become 'former', never deleted (c56 §4.3). */
export async function markInquiryEnded(tx: TenantTx, tenantId: string, intakeSessionId: string, at = new Date()): Promise<number> {
  const rows = await tx
    .update(inquiryParties)
    .set({ status: "former", endedAt: at })
    .where(and(eq(inquiryParties.tenantId, tenantId), eq(inquiryParties.intakeSessionId, intakeSessionId), isNull(inquiryParties.endedAt)))
    .returning({ id: inquiryParties.id });
  return rows.length;
}

/** A matter closed: its parties stay indexed with the closing date (c56 §4.4). */
export async function markMatterPartiesFormer(tx: TenantTx, tenantId: string, matterId: string, closedAt: Date): Promise<number> {
  const rows = await tx
    .update(matterParties)
    .set({ endedAt: closedAt })
    .where(and(eq(matterParties.tenantId, tenantId), eq(matterParties.matterId, matterId), isNull(matterParties.endedAt)))
    .returning({ id: matterParties.id });
  if (rows.length > 0) {
    await audit(tx, {
      tenantId,
      engine: ENGINE,
      action: "index.matter_parties_former",
      entityType: "matter",
      entityId: matterId,
      matterId,
      payload: { count: rows.length, closedAt: closedAt.toISOString() },
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Reads: search entries for a check
// ---------------------------------------------------------------------------

/** Active merges: merged party id -> survivor id. */
export async function activeMergeMap(tx: TenantTx, tenantId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ merged: partyMerges.mergedPartyId, survivor: partyMerges.survivorPartyId })
    .from(partyMerges)
    .where(and(eq(partyMerges.tenantId, tenantId), isNull(partyMerges.undoneAt)));
  const direct = new Map(rows.map((r) => [r.merged, r.survivor]));
  // Follow chains (A merged into B, B merged into C).
  const resolved = new Map<string, string>();
  for (const id of direct.keys()) {
    let cur = id;
    for (let i = 0; i < 10 && direct.has(cur); i++) cur = direct.get(cur)!;
    resolved.set(id, cur);
  }
  return resolved;
}

/** SQL prefilter: parties sharing a 3-letter fragment of any searched token, or an email/phone. */
function candidateFilter(searchTokens: string[], emails: string[], phones: string[], matchKeys: string[] = []): SQL | undefined {
  const conds: SQL[] = [];
  for (const t of searchTokens) {
    const frag = t.length > 3 ? [t.slice(0, 3), t.slice(-3)] : [t];
    for (const f of frag) {
      const like = `%${f}%`;
      conds.push(sql`${parties.normalizedName} like ${like}`);
      conds.push(sql`exists (select 1 from unnest(${parties.normalizedAliases}) a where a like ${like})`);
      conds.push(
        sql`exists (select 1 from party_name_variants v where v.party_id = ${parties.id} and v.normalized_name like ${like})`
      );
    }
  }
  if (matchKeys.length > 0) {
    // c57: phonetic / nickname keys catch near-misses the fragment filter misses.
    conds.push(
      sql`exists (select 1 from party_match_keys k where k.party_id = ${parties.id} and k.key in (${sql.join(
        matchKeys.map((k) => sql`${k}`),
        sql`, `
      )}))`
    );
  }
  for (const e of emails) conds.push(sql`lower(${parties.email}) = ${e}`, sql`${e} = any(${parties.emails})`);
  for (const p of phones) conds.push(sql`regexp_replace(coalesce(${parties.phone}, ''), '\\D', '', 'g') like ${`%${p}`}`);
  return conds.length > 0 ? or(...conds) : undefined;
}

export interface LoadEntriesInput {
  tenantId: string;
  names: readonly string[];
  emails?: readonly string[];
  phones?: readonly string[];
  sources?: readonly IndexSourceType[];
  /** Also load these parties (e.g. org-link neighbours). */
  extraPartyIds?: readonly string[];
  limit?: number;
}

/**
 * Assemble the index entries a check searches: parties (merged records
 * folded into their survivor), plus lateral lists and lawyer interests.
 */
export async function loadIndexEntries(tx: TenantTx, input: LoadEntriesInput): Promise<IndexEntry[]> {
  const sources = new Set(input.sources ?? ["party", "lateral_list", "interest"]);
  const searchTokens = [...new Set(input.names.flatMap((n) => tokens(normalizeName(n))).filter((t) => t.length >= 2))];
  const emails = (input.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const phones = (input.phones ?? []).map((p) => p.replace(/\D/g, "").slice(-10)).filter((p) => p.length >= 7);
  const entries: IndexEntry[] = [];

  if (sources.has("party")) {
    const matchKeys = [...new Set(input.names.flatMap((n) => matchKeysForName(normalizeName(n))))];
    const filter = candidateFilter(searchTokens, emails, phones, matchKeys);
    const extra = input.extraPartyIds && input.extraPartyIds.length > 0 ? inArray(parties.id, [...input.extraPartyIds]) : undefined;
    const where = filter || extra ? or(...[filter, extra].filter((x): x is SQL => !!x)) : undefined;
    const partyRows = where
      ? await tx
          .select()
          .from(parties)
          .where(and(eq(parties.tenantId, input.tenantId), where))
          .limit(input.limit ?? 5000)
      : [];
    entries.push(...(await buildPartyEntries(tx, input.tenantId, partyRows)));
  }

  if (sources.has("lateral_list")) {
    const rows = await tx
      .select({
        id: lateralPriorMatters.id,
        clientNames: lateralPriorMatters.clientNames,
        adverseNames: lateralPriorMatters.adversePartyNames,
        normalizedNames: lateralPriorMatters.normalizedNames,
        subjectCategory: lateralPriorMatters.subjectCategory,
        formerFirmName: lateralPriorMatters.formerFirmName,
        userId: lateralChecks.userId,
      })
      .from(lateralPriorMatters)
      .innerJoin(lateralChecks, eq(lateralChecks.id, lateralPriorMatters.lateralCheckId))
      .where(eq(lateralPriorMatters.tenantId, input.tenantId));
    for (const r of rows) {
      entries.push({
        sourceType: "lateral_list",
        sourceId: r.id,
        partyId: null,
        displayName: [...r.clientNames, ...r.adverseNames].join(", "),
        names: r.normalizedNames.map((n) => ({ normalized: n, type: "legal" })),
        involvements: [],
        ownerUserId: r.userId,
        note: `Prior matter (${r.subjectCategory})${r.formerFirmName ? ` at ${r.formerFirmName}` : ""}`,
      });
    }
  }

  if (sources.has("interest")) {
    const rows = await tx
      .select()
      .from(interestDisclosures)
      .where(and(eq(interestDisclosures.tenantId, input.tenantId), eq(interestDisclosures.active, true)));
    for (const r of rows) {
      entries.push({
        sourceType: "interest",
        sourceId: r.id,
        partyId: null,
        displayName: r.name,
        names: [{ normalized: r.normalizedName, type: "legal" }],
        involvements: [],
        ownerUserId: r.userId,
        note: `${r.interestType}: ${r.relationship}`,
      });
    }
  }
  return entries;
}

type PartyRow = typeof parties.$inferSelect;

async function buildPartyEntries(tx: TenantTx, tenantId: string, partyRows: PartyRow[]): Promise<IndexEntry[]> {
  if (partyRows.length === 0) return [];
  const merges = await activeMergeMap(tx, tenantId);
  const ids = new Set(partyRows.map((p) => p.id));
  // Pull in survivors and everything merged into them so the folded entry is complete.
  for (const [merged, survivor] of merges) {
    if (ids.has(merged) || ids.has(survivor)) {
      ids.add(merged);
      ids.add(survivor);
    }
  }
  const missing = [...ids].filter((id) => !partyRows.some((p) => p.id === id));
  if (missing.length > 0) {
    partyRows = [
      ...partyRows,
      ...(await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), inArray(parties.id, missing)))),
    ];
  }
  const allIds = partyRows.map((p) => p.id);

  const [variants, matterLinks, inquiryLinks, addressRows, importedLinks] = await Promise.all([
    tx
      .select({ partyId: partyNameVariants.partyId, normalized: partyNameVariants.normalizedName, type: partyNameVariants.nameType })
      .from(partyNameVariants)
      .where(and(eq(partyNameVariants.tenantId, tenantId), inArray(partyNameVariants.partyId, allIds))),
    tx
      .select({
        partyId: matterParties.partyId,
        matterId: matterParties.matterId,
        role: matterParties.role,
        relationship: matterParties.relationship,
        isAdverse: matterParties.isAdverse,
        endedAt: matterParties.endedAt,
        stage: matters.stage,
        closedAt: matters.closedAt,
      })
      .from(matterParties)
      .innerJoin(matters, eq(matters.id, matterParties.matterId))
      .where(and(eq(matterParties.tenantId, tenantId), inArray(matterParties.partyId, allIds))),
    tx
      .select({
        partyId: inquiryParties.partyId,
        intakeSessionId: inquiryParties.intakeSessionId,
        role: inquiryParties.role,
        relationship: inquiryParties.relationship,
      })
      .from(inquiryParties)
      .where(and(eq(inquiryParties.tenantId, tenantId), inArray(inquiryParties.partyId, allIds))),
    tx
      .select({ partyId: partyAddresses.partyId, normalized: partyAddresses.normalizedAddress })
      .from(partyAddresses)
      .where(and(eq(partyAddresses.tenantId, tenantId), inArray(partyAddresses.partyId, allIds))),
    // c96: history imported from the firm's old system counts like live history.
    tx
      .select({
        partyId: importedInvolvements.partyId,
        importedMatterId: importedInvolvements.importedMatterId,
        role: importedInvolvements.role,
        relationship: importedInvolvements.relationship,
        isAdverse: importedInvolvements.isAdverse,
        kind: importedMatters.kind,
        status: importedMatters.status,
        externalRef: importedMatters.externalRef,
      })
      .from(importedInvolvements)
      .innerJoin(importedMatters, eq(importedMatters.id, importedInvolvements.importedMatterId))
      .where(and(eq(importedInvolvements.tenantId, tenantId), inArray(importedInvolvements.partyId, allIds))),
  ]);

  const bySurvivor = new Map<string, IndexEntry & { names: Array<{ normalized: string; type: string }>; involvements: Involvement[] }>();
  for (const p of partyRows) {
    const survivorId = merges.get(p.id) ?? p.id;
    let entry = bySurvivor.get(survivorId);
    if (!entry) {
      const survivor = partyRows.find((x) => x.id === survivorId) ?? p;
      entry = {
        sourceType: "party",
        sourceId: survivorId,
        partyId: survivorId,
        displayName: survivor.fullName,
        names: [],
        kind: survivor.kind === "organization" ? "organization" : "person",
        dateOfBirth: survivor.dateOfBirth,
        emails: [],
        phones: [],
        involvements: [],
        ownerUserId: null,
        note: null,
      };
      bySurvivor.set(survivorId, entry);
    }
    const addName = (normalized: string, type: string) => {
      if (normalized && !entry!.names.some((n) => n.normalized === normalized)) entry!.names.push({ normalized, type });
    };
    addName(p.normalizedName, p.id === survivorId ? "legal" : "alias");
    for (const a of p.normalizedAliases) addName(a, "alias");
    for (const v of variants.filter((v) => v.partyId === p.id)) addName(v.normalized, v.type);
    (entry.emails as string[]).push(...[p.email, ...p.emails].filter((x): x is string => !!x));
    (entry.phones as string[]).push(...[p.phone, ...p.phones].filter((x): x is string => !!x));
    if (!entry.dateOfBirth && p.dateOfBirth) entry.dateOfBirth = p.dateOfBirth;

    for (const m of matterLinks.filter((l) => l.partyId === p.id)) {
      entry.involvements.push({
        kind: "matter",
        id: m.matterId,
        role: m.role,
        relationship: m.relationship,
        isAdverse: m.isAdverse,
        stage: m.stage,
        status: matterStatus(m.stage, m.closedAt, m.endedAt),
      });
    }
    for (const a of addressRows.filter((x) => x.partyId === p.id)) {
      const list = (entry.addresses ?? []) as string[];
      if (!list.includes(a.normalized)) list.push(a.normalized);
      entry.addresses = list;
    }
    for (const m of importedLinks.filter((l) => l.partyId === p.id)) {
      entry.involvements.push({
        kind: m.kind === "consultation" ? "inquiry" : "matter",
        id: m.importedMatterId,
        role: m.role,
        relationship: m.relationship,
        isAdverse: m.isAdverse,
        status: m.status as Involvement["status"],
        imported: true,
        externalRef: m.externalRef,
      });
    }
    for (const q of inquiryLinks.filter((l) => l.partyId === p.id)) {
      entry.involvements.push({ kind: "inquiry", id: q.intakeSessionId, role: q.role, relationship: q.relationship, status: "prospective" });
    }
  }
  return [...bySurvivor.values()];
}

const PROSPECTIVE_STAGES = new Set([
  "prospective",
  "consultation_scheduled",
  "consult_completed_manual_follow_up",
  "pending_review",
  "did_not_schedule",
  "did_not_hire_referred_out",
  "declined_conflict",
]);

/** Pure: how a matter involvement counts for conflicts. */
export function matterStatus(stage: string, closedAt: Date | null, endedAt: Date | null): Involvement["status"] {
  if (closedAt || endedAt || stage === "closed") return "former";
  if (PROSPECTIVE_STAGES.has(stage)) return "prospective";
  return "current";
}

export async function loadOrgLinks(tx: TenantTx, tenantId: string): Promise<OrgLink[]> {
  const rows = await tx
    .select({ parentPartyId: partyOrgLinks.parentPartyId, childPartyId: partyOrgLinks.childPartyId })
    .from(partyOrgLinks)
    .where(and(eq(partyOrgLinks.tenantId, tenantId), isNull(partyOrgLinks.endedAt)));
  const parentCols = await tx
    .select({ childPartyId: parties.id, parentPartyId: parties.parentPartyId })
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), sql`${parties.parentPartyId} is not null`));
  return [...rows, ...parentCols.map((r) => ({ childPartyId: r.childPartyId, parentPartyId: r.parentPartyId! }))];
}

// ---------------------------------------------------------------------------
// Search (conflicts role only, c56 rule 3)
// ---------------------------------------------------------------------------

export interface IndexSearchResult {
  partyId: string;
  displayName: string;
  kind: string;
  names: string[];
  involvements: Involvement[];
}

export async function searchIndex(
  tx: TenantTx,
  input: { tenantId: string; query: string; access: ConflictAccess; limit?: number }
): Promise<IndexSearchResult[]> {
  assertCan(input.access, "index.search");
  const q = input.query.trim();
  if (q.length < 2) return [];
  const entries = await loadIndexEntries(tx, { tenantId: input.tenantId, names: [q], sources: ["party"], limit: 500 });
  const hits = matchIndex([{ name: q, role: "search", completeness: tokens(normalizeName(q)).length === 1 ? "partial" : "full" }], entries);
  const hitIds = new Set(hits.map((h) => h.partyId));
  const results = entries
    .filter((e) => hitIds.has(e.partyId ?? ""))
    .slice(0, input.limit ?? 50)
    .map((e) => ({
      partyId: e.partyId!,
      displayName: e.displayName,
      kind: e.kind ?? "person",
      names: e.names.map((n) => n.normalized),
      involvements: [...e.involvements],
    }));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.searched",
    actor: actorOf(input.access),
    payload: { resultCount: results.length },
  });
  return results;
}

// ---------------------------------------------------------------------------
// Duplicates and merges (c56 §4.5)
// ---------------------------------------------------------------------------

async function skipPairs(tx: TenantTx, tenantId: string): Promise<Set<string>> {
  const [sugg, merges] = await Promise.all([
    tx
      .select({ a: partyMergeSuggestions.partyAId, b: partyMergeSuggestions.partyBId })
      .from(partyMergeSuggestions)
      .where(eq(partyMergeSuggestions.tenantId, tenantId)),
    tx
      .select({ a: partyMerges.survivorPartyId, b: partyMerges.mergedPartyId })
      .from(partyMerges)
      .where(and(eq(partyMerges.tenantId, tenantId), isNull(partyMerges.undoneAt))),
  ]);
  return new Set([...sugg, ...merges].map((r) => pairKey(r.a, r.b).join("|")));
}

async function dedupeCandidates(tx: TenantTx, tenantId: string, partyIds?: readonly string[]): Promise<DedupeCandidate[]> {
  const rows = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.tenantId, tenantId), partyIds ? inArray(parties.id, [...partyIds]) : undefined));
  return rows.map((p) => ({
    id: p.id,
    names: [p.normalizedName, ...p.normalizedAliases],
    dateOfBirth: p.dateOfBirth,
    emails: [p.email, ...p.emails].filter((x): x is string => !!x),
    phones: [p.phone, ...p.phones].filter((x): x is string => !!x),
  }));
}

async function insertSuggestions(tx: TenantTx, tenantId: string, pairs: ReturnType<typeof findDuplicatePairs>): Promise<number> {
  if (pairs.length === 0) return 0;
  const rows = await tx
    .insert(partyMergeSuggestions)
    .values(pairs.map((p) => ({ tenantId, partyAId: p.partyAId, partyBId: p.partyBId, score: p.score, reasons: p.reasons })))
    .onConflictDoNothing()
    .returning({ id: partyMergeSuggestions.id });
  return rows.length;
}

/** On every write: look for duplicates of ONE party among likely candidates. */
export async function suggestDuplicatesFor(tx: TenantTx, tenantId: string, partyId: string): Promise<number> {
  const [self] = await dedupeCandidates(tx, tenantId, [partyId]);
  if (!self) return 0;
  const entries = await loadIndexEntries(tx, {
    tenantId,
    names: self.names,
    emails: self.emails,
    phones: self.phones,
    sources: ["party"],
    limit: 500,
  });
  const others = await dedupeCandidates(
    tx,
    tenantId,
    entries.map((e) => e.partyId!).filter((id) => id !== partyId)
  );
  if (others.length === 0) return 0;
  const skip = await skipPairs(tx, tenantId);
  const pairs = findDuplicatePairs([self, ...others], skip).filter((p) => p.partyAId === partyId || p.partyBId === partyId);
  return insertSuggestions(tx, tenantId, pairs);
}

/** Nightly scan over the whole index (worker: conflict-check.party_index_dedupe_scan). */
export async function runDedupeScan(tx: TenantTx, tenantId: string): Promise<number> {
  const all = await dedupeCandidates(tx, tenantId);
  const pairs = findDuplicatePairs(all, await skipPairs(tx, tenantId));
  const created = await insertSuggestions(tx, tenantId, pairs.slice(0, 500));
  if (created > 0) {
    await audit(tx, { tenantId, engine: ENGINE, action: "index.dedupe_scan", payload: { suggestions: created } });
  }
  return created;
}

export async function listMergeSuggestions(tx: TenantTx, tenantId: string, access: ConflictAccess, status = "open") {
  assertCan(access, "index.search");
  return tx
    .select()
    .from(partyMergeSuggestions)
    .where(and(eq(partyMergeSuggestions.tenantId, tenantId), eq(partyMergeSuggestions.status, status)))
    .orderBy(desc(partyMergeSuggestions.score))
    .limit(200);
}

/** Merge two records (a person confirms). Nothing is moved or deleted, so it can be undone exactly. */
export async function mergeParties(
  tx: TenantTx,
  input: { tenantId: string; survivorPartyId: string; mergedPartyId: string; reason: string; suggestionId?: string | null; access: ConflictAccess }
) {
  assertCan(input.access, "index.edit");
  const reason = input.reason.trim();
  if (!reason) throw new ConflictError("A reason is required to merge index records.");
  if (input.survivorPartyId === input.mergedPartyId) throw new ConflictError("Cannot merge a record into itself.");
  const merges = await activeMergeMap(tx, input.tenantId);
  if ((merges.get(input.survivorPartyId) ?? input.survivorPartyId) === input.mergedPartyId) {
    throw new ConflictError("That merge would create a loop; undo the existing merge first.");
  }
  const [row] = await tx
    .insert(partyMerges)
    .values({
      tenantId: input.tenantId,
      survivorPartyId: input.survivorPartyId,
      mergedPartyId: input.mergedPartyId,
      suggestionId: input.suggestionId ?? null,
      mergedByUserId: input.access.userId,
      reason,
    })
    .returning();
  if (input.suggestionId) {
    await tx
      .update(partyMergeSuggestions)
      .set({ status: "confirmed", decidedByUserId: input.access.userId, decidedAt: new Date() })
      .where(and(eq(partyMergeSuggestions.tenantId, input.tenantId), eq(partyMergeSuggestions.id, input.suggestionId)));
  }
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.merged",
    entityType: "party",
    entityId: input.survivorPartyId,
    actor: actorOf(input.access),
    reason,
    payload: { mergedPartyId: input.mergedPartyId, mergeId: row!.id },
  });
  return row!;
}

export async function undoMerge(tx: TenantTx, input: { tenantId: string; mergeId: string; reason: string; access: ConflictAccess }) {
  assertCan(input.access, "index.edit");
  const reason = input.reason.trim();
  if (!reason) throw new ConflictError("A reason is required to undo a merge.");
  const [row] = await tx
    .update(partyMerges)
    .set({ undoneAt: new Date(), undoneByUserId: input.access.userId, undoReason: reason })
    .where(and(eq(partyMerges.tenantId, input.tenantId), eq(partyMerges.id, input.mergeId), isNull(partyMerges.undoneAt)))
    .returning();
  if (!row) throw new ConflictError("Merge not found or already undone.", 404);
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.merge_undone",
    entityType: "party",
    entityId: row.survivorPartyId,
    actor: actorOf(input.access),
    reason,
    payload: { mergedPartyId: row.mergedPartyId, mergeId: row.id },
  });
  return row;
}

/** Reject a suggestion: the pair is remembered and not suggested again (c56 §4.5.4). */
export async function rejectSuggestion(tx: TenantTx, input: { tenantId: string; suggestionId: string; access: ConflictAccess }) {
  assertCan(input.access, "index.edit");
  const [row] = await tx
    .update(partyMergeSuggestions)
    .set({ status: "rejected", decidedByUserId: input.access.userId, decidedAt: new Date() })
    .where(
      and(
        eq(partyMergeSuggestions.tenantId, input.tenantId),
        eq(partyMergeSuggestions.id, input.suggestionId),
        eq(partyMergeSuggestions.status, "open")
      )
    )
    .returning();
  if (!row) throw new ConflictError("Suggestion not found or already decided.");
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.suggestion_rejected",
    entityType: "party",
    entityId: row.partyAId,
    actor: actorOf(input.access),
    payload: { partyBId: row.partyBId },
  });
  return row;
}

export async function confirmSuggestion(
  tx: TenantTx,
  input: { tenantId: string; suggestionId: string; survivorPartyId: string; reason: string; access: ConflictAccess }
) {
  const [s] = await tx
    .select()
    .from(partyMergeSuggestions)
    .where(and(eq(partyMergeSuggestions.tenantId, input.tenantId), eq(partyMergeSuggestions.id, input.suggestionId)))
    .limit(1);
  if (!s || s.status !== "open") throw new ConflictError("Suggestion not found or already decided.");
  if (input.survivorPartyId !== s.partyAId && input.survivorPartyId !== s.partyBId) {
    throw new ConflictError("The surviving record must be one of the suggested pair.");
  }
  const mergedPartyId = input.survivorPartyId === s.partyAId ? s.partyBId : s.partyAId;
  return mergeParties(tx, { ...input, mergedPartyId, suggestionId: s.id });
}

// ---------------------------------------------------------------------------
// Deletion requests (c56 §4.6) — gated legal-rule logic
// ---------------------------------------------------------------------------

export async function openRetentionRequest(tx: TenantTx, input: { tenantId: string; partyId: string; note?: string | null; by?: Actor }) {
  const [row] = await tx
    .insert(partyRetentionRequests)
    .values({ tenantId: input.tenantId, partyId: input.partyId, requestNote: input.note ?? null })
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.retention_request_opened",
    entityType: "party",
    entityId: input.partyId,
    actor: input.by ?? SYSTEM_ACTOR,
  });
  return row!;
}

/**
 * Record the conflicts attorney's retention decision. Both outcomes change
 * what the firm keeps about a person who asked for deletion, which is exactly
 * the legal question in c56 §9.1–9.3, so this is blocked (and logged) until
 * `rules.conflict-check.index_retention` is approved. Until then nothing is
 * deleted — the fail-safe for conflict checking is to keep the entry.
 */
export async function decideRetentionRequest(
  tx: TenantTx,
  input: { tenantId: string; requestId: string; outcome: "kept_minimal" | "removed"; legalBasis: string; access: ConflictAccess }
) {
  assertCan(input.access, "decide");
  if (!input.legalBasis.trim()) throw new ConflictError("Record the legal basis for the retention decision.");
  try {
    requireApproval(CONFLICT_RULE_GATES.indexRetention.key, { action: "conflict-check.retention_decision", tenantId: input.tenantId });
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      await auditBlocked(tx, err, {
        tenantId: input.tenantId,
        engine: ENGINE,
        entityType: "party_retention_request",
        entityId: input.requestId,
        actor: actorOf(input.access),
      });
    }
    throw err;
  }
  const [req] = await tx
    .select()
    .from(partyRetentionRequests)
    .where(and(eq(partyRetentionRequests.tenantId, input.tenantId), eq(partyRetentionRequests.id, input.requestId)))
    .limit(1);
  if (!req || req.status !== "open") throw new ConflictError("Retention request not found or already decided.");

  // Both outcomes remove contact details and narrative-like fields; names, variants and links stay
  // unless the approved rule says the entry may be removed entirely (handled by an operator, never here).
  await tx
    .update(parties)
    .set({ email: null, phone: null, emails: [], phones: [], safeContact: {}, dateOfBirth: null, updatedAt: new Date() })
    .where(and(eq(parties.tenantId, input.tenantId), eq(parties.id, req.partyId)));
  const [row] = await tx
    .update(partyRetentionRequests)
    .set({ status: input.outcome, legalBasis: input.legalBasis.trim(), decidedByUserId: input.access.userId, decidedAt: new Date() })
    .where(eq(partyRetentionRequests.id, req.id))
    .returning();
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.retention_decided",
    entityType: "party",
    entityId: req.partyId,
    actor: actorOf(input.access),
    reason: input.legalBasis.trim(),
    payload: { outcome: input.outcome },
  });
  return row!;
}

// ---------------------------------------------------------------------------
// Health (owner/admin see numbers only)
// ---------------------------------------------------------------------------

export async function indexHealth(tx: TenantTx, tenantId: string, access: ConflictAccess, historyImportConfirmedAt: string | null) {
  assertCan(access, "health.view");
  const count = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
  const [partyCount, openSuggestions, openRetention, inquiryLinks] = await Promise.all([
    count(tx.select({ n: sql<number>`count(*)` }).from(parties).where(eq(parties.tenantId, tenantId))),
    count(
      tx
        .select({ n: sql<number>`count(*)` })
        .from(partyMergeSuggestions)
        .where(and(eq(partyMergeSuggestions.tenantId, tenantId), eq(partyMergeSuggestions.status, "open")))
    ),
    count(
      tx
        .select({ n: sql<number>`count(*)` })
        .from(partyRetentionRequests)
        .where(and(eq(partyRetentionRequests.tenantId, tenantId), eq(partyRetentionRequests.status, "open")))
    ),
    count(tx.select({ n: sql<number>`count(*)` }).from(inquiryParties).where(eq(inquiryParties.tenantId, tenantId))),
  ]);
  return {
    partyCount,
    inquiryLinks,
    openMergeSuggestions: openSuggestions,
    openRetentionRequests: openRetention,
    historyImportConfirmed: historyImportConfirmedAt !== null,
    historyImportConfirmedAt,
  };
}

/** Intake sessions whose inquiry parties exist (used by c62 to find the prospect). */
export async function inquiryPartiesFor(tx: TenantTx, tenantId: string, intakeSessionId: string) {
  return tx
    .select()
    .from(inquiryParties)
    .where(and(eq(inquiryParties.tenantId, tenantId), eq(inquiryParties.intakeSessionId, intakeSessionId)));
}
