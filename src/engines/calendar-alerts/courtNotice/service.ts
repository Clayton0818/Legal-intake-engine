// c64 — court notices (database side).
//
//   ingestCourtEmail()      classify → store (least privilege) → match to a
//                           matter → alert NOW (real clock) → suggestions
//   pollCourtSources()      worker: poll each installed, gate-approved source
//   processNoticeEscalations()  unacknowledged alerts → backup lawyer → owner/admin
//   acknowledgeNotice() / fileNoticeToMatter() / dismissNotice()
//   decideSuggestion()      a LAWYER accepts (→ a PROPOSED calendar entry the
//                           lawyer then confirms in the calendar) or rejects
//
// Internal only: the client is never auto-notified (the lawyer decides what to
// tell them, c54). The AI never calculates or decides a deadline.

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { matterParties, matters, parties } from "@/db/schema";
import { calendarEvents } from "@/db/tables/foundation";
import { alertJobRuns, courtCaseRefs, courtNoticeAttachments, courtNoticeSuggestions, courtNotices } from "@/db/tables/calendar-alerts";
import type { TenantTx } from "@/tenancy/withTenant";
import { isApproved, runGated } from "@/compliance/approvals";
import { audit } from "@/core/audit";
import { toBusinessCalendar } from "@/core/firmSettings";
import { acknowledgeFlag, escalateFlag, resolveFlag } from "@/core/flags";
import { activeUserIds, AlertRuleError, backupFor, getMatter, loadPeople, markJobRun, raiseAlert, responsibleLawyer, type EngineContext, type Staff } from "../common";
import { ALERT_RULE_GATES } from "../gates";
import { FLAG_TYPES } from "../kinds";
import { ENGINE } from "../settings";
import {
  ackDueAt,
  arrivalNote,
  classifyCourtEmail,
  domainOf,
  escalationStepDue,
  extractDateSuggestions,
  findCauseNumbers,
  mentionsName,
  normalizeCauseNumber,
  normalizedNoticeText,
  type DateSuggestion,
  type InboundCourtEmail,
} from "./detect";
import { gateForSource, getCourtMailSources } from "./source";

export type NoticeRow = typeof courtNotices.$inferSelect;
export type SuggestionRow = typeof courtNoticeSuggestions.$inferSelect;

export interface IngestResult {
  stored: boolean;
  classification: "court_verified" | "possible_phishing" | "ignore";
  notice: NoticeRow | null;
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export async function matchNoticeToMatter(
  tx: TenantTx,
  tenantId: string,
  subject: string,
  body: string
): Promise<{ matterId: string; method: "cause_number" | "party_name"; detail: Record<string, unknown> } | { matterId: null; detail: Record<string, unknown> }> {
  const causes = findCauseNumbers(`${subject}\n${body}`);
  if (causes.length > 0) {
    const refs = await tx.select({ matterId: courtCaseRefs.matterId, causeNumber: courtCaseRefs.causeNumber }).from(courtCaseRefs).where(and(eq(courtCaseRefs.tenantId, tenantId), inArray(courtCaseRefs.causeNumber, causes)));
    const evs = await tx
      .select({ matterId: calendarEvents.matterId, causeNumber: calendarEvents.causeNumber })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.tenantId, tenantId), isNotNull(calendarEvents.causeNumber), isNotNull(calendarEvents.matterId)))
      .limit(5000);
    const ids = new Set<string>(refs.map((r) => r.matterId));
    for (const e of evs) if (e.matterId && e.causeNumber && causes.includes(normalizeCauseNumber(e.causeNumber))) ids.add(e.matterId);
    if (ids.size === 1) return { matterId: [...ids][0]!, method: "cause_number", detail: { causeNumbers: causes } };
    if (ids.size > 1) return { matterId: null, detail: { causeNumbers: causes, ambiguousMatters: [...ids] } };
  }
  // Party names on open matters (client and other parties), full names only.
  const text = normalizedNoticeText(subject, body);
  const rows = await tx
    .select({ matterId: matterParties.matterId, name: parties.normalizedName })
    .from(matterParties)
    .innerJoin(parties, eq(parties.id, matterParties.partyId))
    .innerJoin(matters, eq(matters.id, matterParties.matterId))
    .where(and(eq(matterParties.tenantId, tenantId), isNull(matters.closedAt), isNull(matterParties.endedAt)))
    .limit(20000);
  const primaries = await tx
    .select({ matterId: matters.id, name: parties.normalizedName })
    .from(matters)
    .innerJoin(parties, eq(parties.id, matters.primaryPartyId))
    .where(and(eq(matters.tenantId, tenantId), isNull(matters.closedAt)))
    .limit(5000);
  const hits = new Map<string, Set<string>>();
  for (const r of [...rows, ...primaries]) {
    if (!mentionsName(text, r.name)) continue;
    hits.set(r.matterId, (hits.get(r.matterId) ?? new Set()).add(r.name));
  }
  if (hits.size === 1) {
    const [[matterId, names]] = [...hits.entries()] as [[string, Set<string>]];
    return { matterId, method: "party_name", detail: { names: [...names], causeNumbers: causes } };
  }
  return { matterId: null, detail: { causeNumbers: causes, ...(hits.size > 1 ? { ambiguousMatters: [...hits.keys()] } : {}) } };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export async function ingestCourtEmail(tx: TenantTx, ctx: EngineContext, tenantId: string, email: InboundCourtEmail, now: Date, opts: { enteredBy?: Staff } = {}): Promise<IngestResult> {
  const senders = ctx.alerts.trustedCourtSenders;
  const people = await loadPeople(tx, tenantId, ctx.alerts);
  if (senders.length === 0 && email.source !== "manual" && people.admins.length > 0) {
    await raiseAlert(
      tx,
      ctx,
      {
        tenantId,
        type: FLAG_TYPES.courtSendersMissing,
        severity: "high",
        audience: "internal",
        title: "No trusted court senders are configured",
        summary: "Court email cannot be recognised until the firm lists its trusted court and e-filing sender domains (settings).",
        recipients: { userIds: people.admins },
        dedupeKey: FLAG_TYPES.courtSendersMissing,
        sourceCard: "c64",
      },
      now
    );
  }

  // Manual entry: a lawyer/admin records a notice they verified themselves (e.g. downloaded from the e-filing portal).
  const verdict =
    email.source === "manual"
      ? { classification: "court_verified" as const, trustedSender: null, reasons: [`entered by ${opts.enteredBy?.displayName ?? "staff"} from a source they verified`] }
      : classifyCourtEmail(email, senders);
  if (verdict.classification === "ignore") return { stored: false, classification: "ignore", notice: null, duplicate: false };

  const phishing = verdict.classification === "possible_phishing";
  const match = phishing ? null : await matchNoticeToMatter(tx, tenantId, email.subject, email.bodyText);
  const matterId = match?.matterId ?? null;
  const cal = toBusinessCalendar(ctx.firm);
  const due = phishing ? null : ackDueAt(now, cal, ctx.firm.courtNoticeAckMinutes, ctx.alerts.courtNoticeAfterHoursAckMinutes);

  const [notice] = await tx
    .insert(courtNotices)
    .values({
      tenantId,
      source: email.source,
      sourceAccount: email.sourceAccount,
      externalId: email.externalId,
      fromAddress: email.fromAddress,
      fromDomain: domainOf(email.fromAddress),
      fromDisplayName: email.fromDisplayName,
      subject: email.subject,
      bodyText: phishing ? null : email.bodyText, // look-alikes: metadata only
      receivedAt: email.receivedAt,
      authResults: { ...email.auth },
      classification: verdict.classification,
      classificationReasons: verdict.reasons,
      trustedSender: verdict.trustedSender ? `${verdict.trustedSender.label} (${verdict.trustedSender.domain})` : null,
      matterId,
      matchMethod: match && match.matterId ? match.method : null,
      matchDetail: match?.detail ?? {},
      status: phishing ? "phishing_review" : matterId ? "matched" : "unmatched",
      ackDueAt: due,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!notice) return { stored: false, classification: verdict.classification, notice: null, duplicate: true };

  await audit(tx, {
    tenantId,
    engine: ENGINE,
    action: phishing ? "court_notice.possible_phishing" : "court_notice.received",
    entityType: "court_notice",
    entityId: notice.id,
    matterId,
    actor: opts.enteredBy ? { type: "user", userId: opts.enteredBy.userId } : { type: "system" },
    payload: { source: email.source, fromDomain: notice.fromDomain, classification: notice.classification, matchMethod: notice.matchMethod, status: notice.status },
  });

  if (phishing) {
    if (people.admins.length > 0) {
      const res = await raiseAlert(
        tx,
        ctx,
        {
          tenantId,
          type: FLAG_TYPES.courtNoticePhishing,
          severity: "high",
          audience: "internal",
          title: "Possible fake court email",
          summary: `An email from ${email.fromAddress} looks like a court or e-filing notice but is not from a trusted, authenticated sender: ${verdict.reasons.join("; ")}. It was NOT treated as a court notice and its content was not stored. Check the e-filing portal directly; do not click links in the email.`,
          details: { noticeId: notice.id, fromDomain: notice.fromDomain },
          recipients: { userIds: people.admins },
          dedupeKey: `${FLAG_TYPES.courtNoticePhishing}:${notice.id}`,
          sourceCard: "c64",
        },
        now
      );
      await tx.update(courtNotices).set({ alertFlagId: res.flag.id }).where(and(eq(courtNotices.tenantId, tenantId), eq(courtNotices.id, notice.id)));
    }
    return { stored: true, classification: "possible_phishing", notice, duplicate: false };
  }

  for (const a of email.attachments) {
    await tx.insert(courtNoticeAttachments).values({ tenantId, noticeId: notice.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes, sha256: a.sha256, createdAt: now });
  }
  await createSuggestions(tx, tenantId, notice, extractDateSuggestions(email.bodyText, ctx.firm.timeZone), now);
  const flagId = await alertForNotice(tx, ctx, notice, now);
  const [withFlag] = await tx.update(courtNotices).set({ alertFlagId: flagId }).where(and(eq(courtNotices.tenantId, tenantId), eq(courtNotices.id, notice.id))).returning();
  return { stored: true, classification: "court_verified", notice: withFlag ?? notice, duplicate: false };
}

async function alertForNotice(tx: TenantTx, ctx: EngineContext, notice: NoticeRow, now: Date): Promise<string | null> {
  const people = await loadPeople(tx, notice.tenantId, ctx.alerts);
  let recipients: string[] = people.admins;
  if (notice.matterId) {
    const matter = await getMatter(tx, notice.tenantId, notice.matterId);
    const lawyer = await responsibleLawyer(tx, notice.tenantId, matter);
    const assistants = lawyer ? await activeUserIds(tx, notice.tenantId, ctx.alerts.assistantsByLawyer[lawyer] ?? []) : [];
    const named = [...new Set([lawyer, ...assistants].filter((x): x is string => Boolean(x)))];
    if (named.length > 0) recipients = named;
  }
  if (recipients.length === 0) return null;
  const cal = toBusinessCalendar(ctx.firm);
  const matched = notice.status === "matched";
  const res = await raiseAlert(
    tx,
    ctx,
    {
      tenantId: notice.tenantId,
      type: matched ? FLAG_TYPES.courtNotice : FLAG_TYPES.courtNoticeUnmatched,
      severity: "critical",
      urgent: true,
      audience: "internal",
      title: matched ? `Court email: ${notice.subject}` : `Court email not matched to a matter: ${notice.subject}`,
      summary:
        `${arrivalNote(notice.receivedAt, cal)} From ${notice.fromAddress}.` +
        (matched ? "" : " It could not be matched to one matter; please file it to the right matter.") +
        ` Please acknowledge by ${notice.ackDueAt?.toISOString() ?? "now"}.`,
      details: { noticeId: notice.id, matchMethod: notice.matchMethod, matchDetail: notice.matchDetail },
      matterId: notice.matterId,
      recipients: { userIds: recipients },
      dedupeKey: `${FLAG_TYPES.courtNotice}:${notice.id}`,
      sourceCard: "c64",
    },
    now
  );
  return res.flag.id;
}

const EVENT_TYPE_FOR: Record<DateSuggestion["label"], string> = { hearing: "hearing", trial: "trial", deadline: "filing_deadline", other: "other" };

async function createSuggestions(tx: TenantTx, tenantId: string, notice: NoticeRow, found: DateSuggestion[], now: Date): Promise<void> {
  // Automatic PROPOSED calendar entries only once the attorney approved the handling rules, and only on a matched notice.
  const autoPropose = isApproved(ALERT_RULE_GATES.courtNoticeSuggestions.key) && notice.matterId !== null;
  for (const s of found) {
    const [row] = await tx
      .insert(courtNoticeSuggestions)
      .values({ tenantId, noticeId: notice.id, kind: s.kind, label: s.label, snippet: s.snippet, proposedAt: s.proposedAt, extractedBy: "rules", createdAt: now })
      .returning();
    if (autoPropose && s.kind === "explicit_date" && s.proposedAt && row) {
      const eventId = await proposeEvent(tx, tenantId, notice, row, null);
      await tx.update(courtNoticeSuggestions).set({ calendarEventId: eventId }).where(and(eq(courtNoticeSuggestions.tenantId, tenantId), eq(courtNoticeSuggestions.id, row.id)));
    }
  }
}

async function proposeEvent(tx: TenantTx, tenantId: string, notice: NoticeRow, s: SuggestionRow, byUserId: string | null): Promise<string> {
  if (!notice.matterId || !s.proposedAt) throw new AlertRuleError("Only an explicit date on a matched notice can be proposed to the calendar.", 409);
  const causes = findCauseNumbers(`${notice.subject}\n${notice.bodyText ?? ""}`);
  const [ev] = await tx
    .insert(calendarEvents)
    .values({
      tenantId,
      matterId: notice.matterId,
      eventType: EVENT_TYPE_FOR[s.label as DateSuggestion["label"]] ?? "other",
      title: `From court email (unconfirmed): ${s.label}`,
      description: `Suggested from a court email. Text: "${s.snippet}". A lawyer must confirm the date before relying on it.`,
      startsAt: s.proposedAt,
      isDeadline: s.label === "deadline",
      source: "court_notice",
      sourceRef: `court_notice:${notice.id}`,
      status: "proposed",
      causeNumber: causes[0] ?? null,
      createdByUserId: byUserId,
    })
    .returning({ id: calendarEvents.id });
  await audit(tx, { tenantId, engine: ENGINE, action: "court_notice.event_proposed", entityType: "calendar_event", entityId: ev!.id, matterId: notice.matterId, actor: byUserId ? { type: "user", userId: byUserId } : { type: "system" }, payload: { noticeId: notice.id, suggestionId: s.id } });
  return ev!.id;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/** Poll every installed, non-stub source whose vendor gate is approved. Stubs are skipped silently. */
export async function pollCourtSources(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {};
  for (const source of getCourtMailSources()) {
    if (source.isStub) {
      summary[source.name] = "stub";
      continue;
    }
    const job = `court_ingest:${source.name}`;
    const gate = gateForSource(source.kind)!;
    const res = await runGated(gate, "calendar-alerts.court_mail_poll", async () => {
      const cursor = await readCursor(tx, tenantId, job);
      const fetched = await source.fetchSince({ tenantId, cursor, now });
      let stored = 0;
      for (const m of fetched.messages) if ((await ingestCourtEmail(tx, ctx, tenantId, { ...m, source: source.kind }, now)).stored) stored++;
      await markJobRun(tx, tenantId, job, now, { cursor: fetched.cursor, fetched: fetched.messages.length, stored });
      return { fetched: fetched.messages.length, stored };
    }, { tenantId });
    summary[source.name] = res.ok ? res.value : { blocked: res.blocked.gateKey };
  }
  return summary;
}

async function readCursor(tx: TenantTx, tenantId: string, job: string): Promise<string | null> {
  const [row] = await tx.select({ s: alertJobRuns.lastSummary }).from(alertJobRuns).where(and(eq(alertJobRuns.tenantId, tenantId), eq(alertJobRuns.job, job))).limit(1);
  const c = row?.s?.cursor;
  return typeof c === "string" ? c : null;
}

export async function processNoticeEscalations(tx: TenantTx, ctx: EngineContext, tenantId: string, now: Date): Promise<{ escalated: number }> {
  const rows = await tx
    .select()
    .from(courtNotices)
    .where(
      and(
        eq(courtNotices.tenantId, tenantId),
        inArray(courtNotices.status, ["matched", "unmatched"]),
        isNull(courtNotices.acknowledgedAt),
        isNotNull(courtNotices.alertFlagId),
        lte(courtNotices.ackDueAt, now),
        ne(courtNotices.escalationStep, 2)
      )
    )
    .orderBy(asc(courtNotices.ackDueAt))
    .limit(200)
    .for("update", { skipLocked: true });
  let escalated = 0;
  const people = await loadPeople(tx, tenantId, ctx.alerts);
  for (const n of rows) {
    const step = escalationStepDue({ step: n.escalationStep, ackDueAt: n.ackDueAt!, ackMinutes: ctx.firm.courtNoticeAckMinutes, acknowledged: false, now });
    if (!step) continue;
    let add: string[];
    let target = step;
    if (step === 1) {
      const lawyer = n.matterId ? await responsibleLawyer(tx, tenantId, await getMatter(tx, tenantId, n.matterId)) : null;
      const backup = await backupFor(tx, tenantId, ctx.alerts, lawyer);
      add = backup ? [backup] : [...people.owners, ...people.admins];
      if (!backup) target = 2; // no backup lawyer named: go straight to owner/admin
    } else {
      add = [...people.owners, ...people.admins];
    }
    await escalateFlag(tx, {
      tenantId,
      flagId: n.alertFlagId!,
      addUserIds: add,
      severity: "critical",
      note: `Court email not acknowledged by ${n.ackDueAt!.toISOString()}.`,
      engine: ENGINE,
      at: now,
    }).catch((err: unknown) => {
      if (!(err instanceof Error && /not found/.test(err.message))) throw err;
    });
    await tx.update(courtNotices).set({ escalationStep: target }).where(and(eq(courtNotices.tenantId, tenantId), eq(courtNotices.id, n.id)));
    await audit(tx, { tenantId, engine: ENGINE, action: "court_notice.escalated", entityType: "court_notice", entityId: n.id, matterId: n.matterId, payload: { step: target, added: add.length } });
    escalated++;
  }
  return { escalated };
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

async function getNotice(tx: TenantTx, tenantId: string, id: string): Promise<NoticeRow> {
  const [n] = await tx.select().from(courtNotices).where(and(eq(courtNotices.tenantId, tenantId), eq(courtNotices.id, id))).limit(1);
  if (!n) throw new AlertRuleError("Court notice not found.", 404);
  return n;
}

/** A person acknowledges the alert (every acknowledgment is logged). It stays on the matter. */
export async function acknowledgeNotice(tx: TenantTx, input: { tenantId: string; noticeId: string; staff: Staff; now: Date }): Promise<NoticeRow> {
  const n = await getNotice(tx, input.tenantId, input.noticeId);
  if (n.acknowledgedAt) return n;
  if (n.status === "phishing_review" || n.status === "dismissed") throw new AlertRuleError("Only a court notice alert can be acknowledged.", 409);
  const [row] = await tx
    .update(courtNotices)
    .set({ acknowledgedAt: input.now, acknowledgedByUserId: input.staff.userId })
    .where(and(eq(courtNotices.tenantId, input.tenantId), eq(courtNotices.id, n.id)))
    .returning();
  if (n.alertFlagId) await acknowledgeFlag(tx, { tenantId: input.tenantId, flagId: n.alertFlagId, userId: input.staff.userId, engine: ENGINE, at: input.now });
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "court_notice.acknowledged", entityType: "court_notice", entityId: n.id, matterId: n.matterId, actor: { type: "user", userId: input.staff.userId } });
  return row!;
}

/** Admin queue: file an unmatched notice to a matter; its cause numbers are learned for next time. */
export async function fileNoticeToMatter(tx: TenantTx, ctx: EngineContext, input: { tenantId: string; noticeId: string; matterId: string; staff: Staff; now: Date }): Promise<NoticeRow> {
  if (!["firm_admin", "attorney", "intake_staff"].includes(input.staff.role)) throw new AlertRuleError("Your role cannot file court notices.", 403);
  const n = await getNotice(tx, input.tenantId, input.noticeId);
  if (n.status !== "unmatched" && n.status !== "matched") throw new AlertRuleError("Only a court notice can be filed to a matter.", 409);
  const matter = await getMatter(tx, input.tenantId, input.matterId);
  const by = { type: "user" as const, userId: input.staff.userId };
  const [row] = await tx
    .update(courtNotices)
    .set({ matterId: matter.id, status: "matched", matchMethod: "staff", matchDetail: { ...n.matchDetail, filedBy: input.staff.userId } })
    .where(and(eq(courtNotices.tenantId, input.tenantId), eq(courtNotices.id, n.id)))
    .returning();
  for (const c of findCauseNumbers(`${n.subject}\n${n.bodyText ?? ""}`)) {
    await tx.insert(courtCaseRefs).values({ tenantId: input.tenantId, matterId: matter.id, causeNumber: c, addedByUserId: input.staff.userId, createdAt: input.now }).onConflictDoNothing();
  }
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "court_notice.filed_to_matter", entityType: "court_notice", entityId: n.id, matterId: matter.id, actor: by, payload: { from: n.matterId } });
  // The responsible lawyer still has to see it: replace the admin-queue alert with a matter alert.
  if (n.alertFlagId && n.status === "unmatched") {
    await resolveFlag(tx, { tenantId: input.tenantId, flagId: n.alertFlagId, by, reason: "Filed to a matter; the matter's lawyer was alerted", engine: ENGINE, at: input.now }).catch((err: unknown) => {
      if (!(err instanceof Error && /not found/.test(err.message))) throw err;
    });
    const flagId = await alertForNotice(tx, ctx, row!, input.now);
    const [withFlag] = await tx.update(courtNotices).set({ alertFlagId: flagId, escalationStep: 0 }).where(and(eq(courtNotices.tenantId, input.tenantId), eq(courtNotices.id, n.id))).returning();
    return withFlag!;
  }
  return row!;
}

/** Dismiss a phishing look-alike or a non-notice, with a reason (logged; the row is kept). */
export async function dismissNotice(tx: TenantTx, input: { tenantId: string; noticeId: string; staff: Staff; reason: string; now: Date }): Promise<NoticeRow> {
  const reason = input.reason?.trim();
  if (!reason) throw new AlertRuleError("A reason is required to dismiss a notice.");
  if (input.staff.role !== "firm_admin" && input.staff.role !== "attorney") throw new AlertRuleError("Only a lawyer or firm admin can dismiss a notice.", 403);
  const n = await getNotice(tx, input.tenantId, input.noticeId);
  if (n.status === "dismissed") return n;
  const [row] = await tx.update(courtNotices).set({ status: "dismissed", dismissedReason: reason }).where(and(eq(courtNotices.tenantId, input.tenantId), eq(courtNotices.id, n.id))).returning();
  const by = { type: "user" as const, userId: input.staff.userId };
  if (n.alertFlagId) {
    await resolveFlag(tx, { tenantId: input.tenantId, flagId: n.alertFlagId, by, reason: `Dismissed: ${reason}`, engine: ENGINE, at: input.now }).catch((err: unknown) => {
      if (!(err instanceof Error && /not found/.test(err.message))) throw err;
    });
  }
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: "court_notice.dismissed", entityType: "court_notice", entityId: n.id, matterId: n.matterId, actor: by, reason });
  return row!;
}

/**
 * A LAWYER decides a suggestion. 'accept' on an explicit date adds a PROPOSED
 * calendar entry (the lawyer then confirms it in the calendar, c91); a
 * relative period has no date to add — the lawyer enters the date they work
 * out themselves. The system never computes it.
 */
export async function decideSuggestion(
  tx: TenantTx,
  input: { tenantId: string; suggestionId: string; staff: Staff; decision: "accept" | "reject"; note: string | null; now: Date }
): Promise<SuggestionRow> {
  if (input.staff.role !== "attorney") throw new AlertRuleError("Only a lawyer can decide a date found in a court email.", 403);
  const [s] = await tx.select().from(courtNoticeSuggestions).where(and(eq(courtNoticeSuggestions.tenantId, input.tenantId), eq(courtNoticeSuggestions.id, input.suggestionId))).limit(1);
  if (!s) throw new AlertRuleError("Suggestion not found.", 404);
  if (s.status !== "open") throw new AlertRuleError(`This suggestion was already ${s.status}.`, 409);
  const notice = await getNotice(tx, input.tenantId, s.noticeId);
  let calendarEventId = s.calendarEventId;
  if (input.decision === "accept" && s.kind === "explicit_date" && !calendarEventId) {
    calendarEventId = await proposeEvent(tx, input.tenantId, notice, s, input.staff.userId);
  }
  if (input.decision === "reject" && calendarEventId) {
    await tx
      .update(calendarEvents)
      .set({ status: "cancelled", cancelledAt: input.now, cancelReason: `Rejected by lawyer: ${input.note ?? "not a date to calendar"}`, updatedAt: input.now })
      .where(and(eq(calendarEvents.tenantId, input.tenantId), eq(calendarEvents.id, calendarEventId), eq(calendarEvents.status, "proposed")));
  }
  const [row] = await tx
    .update(courtNoticeSuggestions)
    .set({ status: input.decision === "accept" ? "confirmed" : "rejected", decidedByUserId: input.staff.userId, decidedAt: input.now, decisionNote: input.note, calendarEventId })
    .where(and(eq(courtNoticeSuggestions.tenantId, input.tenantId), eq(courtNoticeSuggestions.id, s.id)))
    .returning();
  await audit(tx, { tenantId: input.tenantId, engine: ENGINE, action: `court_notice.suggestion_${input.decision}ed`, entityType: "court_notice", entityId: notice.id, matterId: notice.matterId, actor: { type: "user", userId: input.staff.userId }, reason: input.note, payload: { suggestionId: s.id, kind: s.kind, calendarEventId } });
  return row!;
}

export async function listNotices(tx: TenantTx, tenantId: string, filter: { status?: string[]; matterId?: string; limit?: number } = {}): Promise<NoticeRow[]> {
  const conds = [eq(courtNotices.tenantId, tenantId)];
  if (filter.status?.length) conds.push(inArray(courtNotices.status, filter.status));
  if (filter.matterId) conds.push(eq(courtNotices.matterId, filter.matterId));
  return tx.select().from(courtNotices).where(and(...conds)).orderBy(desc(courtNotices.receivedAt)).limit(filter.limit ?? 200);
}

export async function getNoticeDetail(tx: TenantTx, tenantId: string, noticeId: string) {
  const notice = await getNotice(tx, tenantId, noticeId);
  const attachments = await tx.select().from(courtNoticeAttachments).where(and(eq(courtNoticeAttachments.tenantId, tenantId), eq(courtNoticeAttachments.noticeId, notice.id)));
  const suggestions = await tx.select().from(courtNoticeSuggestions).where(and(eq(courtNoticeSuggestions.tenantId, tenantId), eq(courtNoticeSuggestions.noticeId, notice.id))).orderBy(asc(courtNoticeSuggestions.createdAt));
  return { notice, attachments, suggestions };
}
