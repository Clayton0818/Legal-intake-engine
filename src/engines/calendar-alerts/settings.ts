// Firm-configurable settings of the calendar-alerts engine.
//
// The founder's numbers (24h firm reply, 48h client promise, 12h/24h deadline
// questions, client response window, due-soon lead, overdue grace, court
// notice acknowledgement window) are FIRM SETTINGS columns in firm_settings
// and are read from there (getFirmSettings()). Everything else this engine
// needs lives in firm_settings.engine_settings["calendar-alerts"] with the
// spec defaults below. None of these are approval gates.
//
// Durations are BUSINESS hours unless the name says Real/Days/Minutes-real.
// "1 business day" defaults to 8 business hours (the default 09:00–17:00 day).

import { engineSetting, type FirmSettings } from "@/core/firmSettings";

export const ENGINE = "calendar-alerts" as const;

export type LadderAction = "reminder" | "lawyer_decides";
export interface LadderStep {
  action: LadderAction;
  /** Business hours after the previous step (the first step: after the window lapses). */
  afterBusinessHours: number;
}

export interface TrustedCourtSender {
  /** Sender domain, e.g. 'efiletexas.gov'. Sub-domains of it also match. */
  domain: string;
  label: string;
  kind: "court" | "efiling";
}

export interface HealthWeights {
  firm: { replyTimes: number; overdueFirmTasks: number; stalls: number; sinceLastUpdate: number };
  client: {
    clientReplies: number;
    overdueClientTasks: number;
    missingDocuments: number;
    signOffs: number;
    retainer: number;
    sinceClientActivity: number;
  };
}

export interface HealthSettings {
  weights: HealthWeights;
  /** score >= green → green; >= amber → amber; else red. */
  greenAt: number;
  amberAt: number;
  /** "Falling sharply": a drop of at least this many points … */
  trendDropPoints: number;
  /** … within this many business days. */
  trendWindowBusinessDays: number;
  /** Ranking multiplier (percent) when a confirmed court deadline is near. */
  deadlineMultiplierPct: number;
  deadlineWindowBusinessDays: number;
  /** New matters show "not enough data" for this many business days. */
  newMatterGraceBusinessDays: number;
  /** No repeat health flag until the matter has been out of red this long. */
  reflagQuietBusinessDays: number;
  /** c53 §9 fairness: ignore "time since client activity" on DV-sensitive matters. */
  excludeActivityForDv: boolean;
  /**
   * Flag types other engines raise for the optional client signals (c49
   * missing documents, c41 sign-offs, c50/c52 retainer). Empty = "not
   * measured" and the weight is redistributed (c53 §4.5) — set once those
   * engines publish their flag types.
   */
  signalFlagTypes: { missingDocuments: string[]; signOffs: string[]; retainer: string[] };
}

export interface AlertSettings {
  // c44
  /** Calendar-proximity tagging and safety-net lookahead, CALENDAR days (default 14). */
  deadlineLookaheadDays: number;
  /** Re-alert the firm admin if a safety-net alert is not acknowledged (REAL minutes, default 60). */
  safetyNetReAlertMinutes: number;
  /** A client-stated event this close (REAL hours) adds the approved "if urgent, call us" line. */
  imminentEventRealHours: number;
  /** Minimum AI confidence to trust a "not deadline-related" answer; below it the stricter clock applies. */
  aiDeadlineMinConfidence: number;
  /** Firm phone number for the urgent-call line. */
  firmPhone: string | null;
  // c45 / c46
  /** Due-soon lead for deadline-critical tasks (REAL hours, default 48). */
  deadlineDueSoonRealHours: number;
  /** Send the client a due-soon reminder for their own tasks (c46 §4.3). */
  clientTaskDueSoonReminder: boolean;
  /**
   * Task kinds whose owning engine already raises its own overdue flags (e.g.
   * intake's speed-to-lead, c69). The generic c45 scan leaves them alone so a
   * task is never flagged twice.
   */
  selfManagedTaskKinds: string[];
  // c42 / c46 ladder
  ladder: LadderStep[];
  /** Due time of the lawyer's "decide the next step" task (default 1 business day). */
  decisionDueBusinessHours: number;
  // People (open questions: named in firm settings; fallback = firm admins)
  managingAttorneyUserIds: string[];
  firmOwnerUserIds: string[];
  /** Per-lawyer backup for urgent alerts and court-notice escalation. */
  backupLawyerByUser: Record<string, string>;
  /** Per-lawyer assistants who also get court-notice alerts (c64). */
  assistantsByLawyer: Record<string, string[]>;
  // c64
  trustedCourtSenders: TrustedCourtSender[];
  /** Outside business hours the acknowledgement is due this many REAL minutes after the next opening. */
  courtNoticeAfterHoursAckMinutes: number;
  // c47
  /** Expected business hours per '<itemType>:<stage>' (or '<itemType>:*'). No entry = never flagged. */
  stallDurations: Record<string, number>;
  checkBackMaxDays: number;
  // c51
  /** Non-urgent emails per client per local day; further ones are in-app only. */
  clientEmailDailyCap: number;
  /** Set by the firm admin once the email vendor verified the firm's sending domain. */
  senderDomainVerified: boolean;
  /** Local time the daily internal digest is sent ("HH:MM"). */
  digestTimeLocal: string;
  // c53
  health: HealthSettings;
  // c54
  /** AI/system draft approval is itself a task due after this (default 2 business days). */
  updateApprovalDueBusinessHours: number;
  /** Updates expect no reply by default (c54 rule 8). */
  updatesExpectReply: boolean;
}

export const DEFAULT_HEALTH: HealthSettings = {
  weights: {
    firm: { replyTimes: 30, overdueFirmTasks: 25, stalls: 15, sinceLastUpdate: 30 },
    client: { clientReplies: 30, overdueClientTasks: 20, missingDocuments: 15, signOffs: 10, retainer: 15, sinceClientActivity: 10 },
  },
  greenAt: 70,
  amberAt: 40,
  trendDropPoints: 20,
  trendWindowBusinessDays: 5,
  deadlineMultiplierPct: 150,
  deadlineWindowBusinessDays: 10,
  newMatterGraceBusinessDays: 10,
  reflagQuietBusinessDays: 5,
  excludeActivityForDv: true,
  signalFlagTypes: { missingDocuments: [], signOffs: [], retainer: [] },
};

export const DEFAULT_ALERT_SETTINGS: Readonly<AlertSettings> = Object.freeze({
  deadlineLookaheadDays: 14,
  safetyNetReAlertMinutes: 60,
  imminentEventRealHours: 48,
  aiDeadlineMinConfidence: 0.7,
  firmPhone: null,
  deadlineDueSoonRealHours: 48,
  clientTaskDueSoonReminder: true,
  selfManagedTaskKinds: ["intake.first_response_due"],
  ladder: [
    { action: "reminder", afterBusinessHours: 0 },
    { action: "reminder", afterBusinessHours: 16 },
    { action: "lawyer_decides", afterBusinessHours: 16 },
  ],
  decisionDueBusinessHours: 8,
  managingAttorneyUserIds: [],
  firmOwnerUserIds: [],
  backupLawyerByUser: {},
  assistantsByLawyer: {},
  trustedCourtSenders: [],
  courtNoticeAfterHoursAckMinutes: 60,
  stallDurations: {
    "intake_session:existing_caller_handoff": 8,
    "intake_session:out_of_scope_gate": 8,
    "intake_session:*": 16,
    "conflict_check:possible": 8,
    "document:in_review": 24,
  },
  checkBackMaxDays: 90,
  clientEmailDailyCap: 3,
  senderDomainVerified: false,
  digestTimeLocal: "08:00",
  health: DEFAULT_HEALTH,
  updateApprovalDueBusinessHours: 16,
  updatesExpectReply: false,
} satisfies AlertSettings);

const KEYS = Object.keys(DEFAULT_ALERT_SETTINGS) as (keyof AlertSettings)[];

/** The engine's settings for a firm, defaults filled in. Pure. */
export function readAlertSettings(firm: Pick<FirmSettings, "engineSettings">): AlertSettings {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) out[key] = engineSetting(firm, ENGINE, key, DEFAULT_ALERT_SETTINGS[key]);
  const merged = out as unknown as AlertSettings;
  // Nested objects: merge over the defaults so a partial value never drops a key.
  merged.health = {
    ...DEFAULT_HEALTH,
    ...(merged.health ?? {}),
    weights: {
      firm: { ...DEFAULT_HEALTH.weights.firm, ...(merged.health?.weights?.firm ?? {}) },
      client: { ...DEFAULT_HEALTH.weights.client, ...(merged.health?.weights?.client ?? {}) },
    },
    signalFlagTypes: { ...DEFAULT_HEALTH.signalFlagTypes, ...(merged.health?.signalFlagTypes ?? {}) },
  };
  return merged;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function nonNegative(v: unknown, name: string, errors: string[], opts: { max?: number; integer?: boolean } = {}): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(`${name} must be zero or more.`);
  else if (opts.integer && !Number.isInteger(v)) errors.push(`${name} must be a whole number.`);
  else if (opts.max !== undefined && v > opts.max) errors.push(`${name} must be at most ${opts.max}.`);
}

/** Validate a settings patch (only the keys present). Returns readable problems; empty = OK. Pure. */
export function validateAlertSettingsPatch(patch: Partial<AlertSettings>): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(patch)) {
    if (!(KEYS as string[]).includes(key)) errors.push(`Unknown setting '${key}'.`);
  }
  if (patch.deadlineLookaheadDays !== undefined) nonNegative(patch.deadlineLookaheadDays, "deadlineLookaheadDays", errors, { max: 365, integer: true });
  if (patch.safetyNetReAlertMinutes !== undefined) nonNegative(patch.safetyNetReAlertMinutes, "safetyNetReAlertMinutes", errors, { integer: true });
  if (patch.imminentEventRealHours !== undefined) nonNegative(patch.imminentEventRealHours, "imminentEventRealHours", errors);
  if (patch.aiDeadlineMinConfidence !== undefined) nonNegative(patch.aiDeadlineMinConfidence, "aiDeadlineMinConfidence", errors, { max: 1 });
  if (patch.deadlineDueSoonRealHours !== undefined) nonNegative(patch.deadlineDueSoonRealHours, "deadlineDueSoonRealHours", errors);
  if (patch.decisionDueBusinessHours !== undefined) nonNegative(patch.decisionDueBusinessHours, "decisionDueBusinessHours", errors);
  if (patch.courtNoticeAfterHoursAckMinutes !== undefined) {
    nonNegative(patch.courtNoticeAfterHoursAckMinutes, "courtNoticeAfterHoursAckMinutes", errors, { integer: true });
  }
  if (patch.checkBackMaxDays !== undefined) nonNegative(patch.checkBackMaxDays, "checkBackMaxDays", errors, { max: 366, integer: true });
  if (patch.clientEmailDailyCap !== undefined) nonNegative(patch.clientEmailDailyCap, "clientEmailDailyCap", errors, { integer: true });
  if (patch.updateApprovalDueBusinessHours !== undefined) nonNegative(patch.updateApprovalDueBusinessHours, "updateApprovalDueBusinessHours", errors);
  if (patch.digestTimeLocal !== undefined && (typeof patch.digestTimeLocal !== "string" || !HHMM.test(patch.digestTimeLocal))) {
    errors.push("digestTimeLocal must be a 24h time like 08:00.");
  }
  if (patch.ladder !== undefined) errors.push(...validateLadder(patch.ladder));
  if (
    patch.selfManagedTaskKinds !== undefined &&
    (!Array.isArray(patch.selfManagedTaskKinds) || !patch.selfManagedTaskKinds.every((k) => typeof k === "string" && /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(k)))
  ) {
    errors.push("selfManagedTaskKinds must be a list of namespaced task kinds, e.g. 'intake.first_response_due'.");
  }
  for (const key of ["managingAttorneyUserIds", "firmOwnerUserIds"] as const) {
    const v = patch[key];
    if (v !== undefined && (!Array.isArray(v) || !v.every((id) => typeof id === "string" && UUID.test(id)))) {
      errors.push(`${key} must be a list of user ids.`);
    }
  }
  if (patch.backupLawyerByUser !== undefined) {
    const ok =
      patch.backupLawyerByUser && typeof patch.backupLawyerByUser === "object" &&
      Object.entries(patch.backupLawyerByUser).every(([k, v]) => UUID.test(k) && typeof v === "string" && UUID.test(v) && v !== k);
    if (!ok) errors.push("backupLawyerByUser maps a lawyer's user id to a different user id.");
  }
  if (patch.assistantsByLawyer !== undefined) {
    const ok =
      patch.assistantsByLawyer && typeof patch.assistantsByLawyer === "object" &&
      Object.entries(patch.assistantsByLawyer).every(([k, v]) => UUID.test(k) && Array.isArray(v) && v.every((id) => typeof id === "string" && UUID.test(id)));
    if (!ok) errors.push("assistantsByLawyer maps a lawyer's user id to a list of user ids.");
  }
  if (patch.trustedCourtSenders !== undefined) {
    if (!Array.isArray(patch.trustedCourtSenders)) errors.push("trustedCourtSenders must be a list.");
    else {
      for (const s of patch.trustedCourtSenders) {
        const domain = typeof s?.domain === "string" ? s.domain.trim().toLowerCase() : "";
        if (!DOMAIN.test(domain)) errors.push(`'${String(s?.domain)}' is not a valid sender domain.`);
        if (!s?.label || typeof s.label !== "string") errors.push(`Trusted sender '${domain}' needs a label.`);
        if (s?.kind !== "court" && s?.kind !== "efiling") errors.push(`Trusted sender '${domain}' kind must be 'court' or 'efiling'.`);
      }
    }
  }
  if (patch.stallDurations !== undefined) {
    if (!patch.stallDurations || typeof patch.stallDurations !== "object") errors.push("stallDurations must be an object.");
    else {
      for (const [key, hours] of Object.entries(patch.stallDurations)) {
        if (!/^(intake_session|conflict_check|matter|document):[a-z0-9_*]+$/.test(key)) {
          errors.push(`stallDurations key '${key}' must look like 'intake_session:<stage>'.`);
        }
        nonNegative(hours, `stallDurations['${key}']`, errors);
      }
    }
  }
  if (patch.health !== undefined) errors.push(...validateHealthSettings(patch.health));
  return errors;
}

export function validateLadder(ladder: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(ladder) || ladder.length === 0) return ["ladder must be a non-empty list of steps."];
  const steps = ladder as LadderStep[];
  const reminders = steps.filter((s) => s?.action === "reminder").length;
  if (reminders > 3) errors.push("At most 3 automatic client reminders per item (c42 rule 2).");
  steps.forEach((s, i) => {
    if (s?.action !== "reminder" && s?.action !== "lawyer_decides") errors.push(`ladder step ${i + 1}: unknown action.`);
    if (typeof s?.afterBusinessHours !== "number" || !Number.isFinite(s.afterBusinessHours) || s.afterBusinessHours < 0) {
      errors.push(`ladder step ${i + 1}: afterBusinessHours must be zero or more.`);
    }
  });
  const last = steps[steps.length - 1];
  if (last?.action !== "lawyer_decides") errors.push("The last ladder step must be 'lawyer_decides' — the lawyer always decides the next step.");
  if (steps.slice(0, -1).some((s) => s?.action === "lawyer_decides")) errors.push("'lawyer_decides' can only be the last step.");
  return errors;
}

export function validateHealthSettings(h: Partial<HealthSettings>): string[] {
  const errors: string[] = [];
  const green = h.greenAt ?? DEFAULT_HEALTH.greenAt;
  const amber = h.amberAt ?? DEFAULT_HEALTH.amberAt;
  if (!(green > amber && amber > 0 && green <= 100)) errors.push("Health bands must satisfy 0 < amber < green ≤ 100.");
  for (const side of ["firm", "client"] as const) {
    const w = h.weights?.[side] as Record<string, number> | undefined;
    if (!w) continue;
    for (const [k, v] of Object.entries(w)) nonNegative(v, `health.weights.${side}.${k}`, errors);
  }
  return errors;
}

/** Expected duration for an item in a stage (business hours), or null = never flagged. Pure. */
export function stallDurationFor(settings: Pick<AlertSettings, "stallDurations">, itemType: string, stage: string): number | null {
  const exact = settings.stallDurations[`${itemType}:${stage}`];
  if (typeof exact === "number") return exact;
  const wildcard = settings.stallDurations[`${itemType}:*`];
  return typeof wildcard === "number" ? wildcard : null;
}
