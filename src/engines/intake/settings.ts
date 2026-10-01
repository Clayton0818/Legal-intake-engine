// Intake engine firm settings. These are normal, firm-editable numbers (the
// founder's rule: configurable numbers are settings, not approval gates).
// They live in firm_settings.engine_settings.intake and are merged over the
// defaults below. Anything that needs legal review is a gate in ./gates.ts,
// never a setting.

import { engineSetting, type FirmSettings } from "@/core/firmSettings";

export const INTAKE_ENGINE = "intake" as const;

export type BookingFormat = "video" | "phone" | "in_person";
export type FollowUpTrigger = "abandoned_chat" | "not_booked" | "not_signed";
export const FOLLOW_UP_TRIGGERS: readonly FollowUpTrigger[] = ["abandoned_chat", "not_booked", "not_signed"];

export interface FollowUpSequence {
  /** Day offsets from the trigger (calendar days), e.g. [1, 4, 10]. */
  dayOffsets: number[];
  channels: ("email" | "sms")[];
}

export interface IntakeSettings {
  pipeline: {
    maxStages: number;
  };
  escalation: {
    /** "Intake manager" (no such role exists yet): first escalation for speed-to-lead. Empty → firm admins. */
    intakeManagerUserIds: string[];
    /** Owner/admin escalation. Empty → every active firm_admin. */
    ownerUserIds: string[];
  };
  assignment: {
    weights: { cadence: number; workload: number; other: number };
    weeklyNewMatterCap: number;
    minGapBusinessHours: number;
    lookaheadBusinessDays: number;
    outOfOfficeWindowBusinessDays: number;
    /** Weight per matter type / practice sub-type (default 1.0). */
    complexityWeights: Record<string, number>;
    /** Preferred seniority (1–5) per matter type. */
    seniorityFit: Record<string, number>;
    /** Firm priorities: prefer users for a matter type (score bonus 0–100). */
    priorities: { matterType: string; userIds: string[]; bonus: number }[];
    /** Sub-weights inside "workload". */
    workloadMix: { openMatters: number; openTasks: number; overdueTasks: number; upcomingDeadlines: number };
    /** Sub-weights inside "other". */
    otherMix: { continuity: number; seniority: number; priority: number };
  };
  emergency: {
    ackWindowMinutes: number;
    urgentCourtWindowDays: number;
    /** Firm additions to the phrase list, by category. Categories cannot be removed. */
    extraPhrases: Record<string, string[]>;
    rotaGapWarningHours: number;
  };
  speedToLead: {
    afterHoursTargetMinutesAfterOpen: number;
    dueSoonFraction: number;
    graceBusinessMinutes: number;
    attemptsNeeded: number;
    attemptMinSpacingBusinessMinutes: number;
  };
  booking: {
    lawyerChoice: "assigned_only" | "any_eligible";
    durationMinutes: number;
    bufferMinutes: number;
    sameDayMinimumLeadHours: number;
    horizonDays: number;
    slotStepMinutes: number;
    holdMinutes: number;
    reminderOffsetsHours: number[];
    rebookOffers: 0 | 1;
    noShowGraceMinutes: number;
    rebookWindowBusinessDays: number;
    calendarStaleMinutes: number;
    formats: BookingFormat[];
    /** Matter types that always need a paid consult. */
    alwaysPaidConsultMatterTypes: string[];
    consultFeeCents: number | null;
    /** 'operating' | 'trust' — deliberately NO default (firm + CPA decide, c67 rule 7). */
    consultFeeDestination: "operating" | "trust" | null;
    consultHoldTaskBusinessHours: number;
  };
  followUp: {
    enabled: boolean;
    sequences: Record<FollowUpTrigger, FollowUpSequence>;
    extraStopWords: string[];
  };
  acceptance: {
    autoDeclineEnabled: boolean;
    confidenceThreshold: number;
    referralsEnabled: boolean;
    /** Business hours a lawyer has to review a borderline case before the task is overdue. */
    reviewBusinessHours: number;
    /** Counties served (normalised lowercase) for the default county rule; empty = no county rule. */
    countiesServed: string[];
  };
  phone: { ringTimeoutRings: number };
}

/** Product hard caps a firm cannot exceed (c70 rule 5, c14 rule 9, c66 rule 6). */
export const HARD_CAPS = Object.freeze({
  followUpMaxMessages: 4,
  followUpMaxDays: 14,
  pipelineMaxStages: 20,
  ackWindowMinMinutes: 5,
  ackWindowMaxMinutes: 30,
});

export const DEFAULT_INTAKE_SETTINGS: Readonly<IntakeSettings> = Object.freeze({
  pipeline: { maxStages: 20 },
  escalation: { intakeManagerUserIds: [], ownerUserIds: [] },
  assignment: {
    weights: { cadence: 30, workload: 50, other: 20 },
    weeklyNewMatterCap: 5,
    minGapBusinessHours: 2,
    lookaheadBusinessDays: 3,
    outOfOfficeWindowBusinessDays: 3,
    complexityWeights: {},
    seniorityFit: {},
    priorities: [],
    workloadMix: { openMatters: 0.4, openTasks: 0.2, overdueTasks: 0.2, upcomingDeadlines: 0.2 },
    otherMix: { continuity: 0.5, seniority: 0.25, priority: 0.25 },
  },
  emergency: { ackWindowMinutes: 15, urgentCourtWindowDays: 3, extraPhrases: {}, rotaGapWarningHours: 24 },
  speedToLead: {
    afterHoursTargetMinutesAfterOpen: 60,
    dueSoonFraction: 0.5,
    graceBusinessMinutes: 30,
    attemptsNeeded: 2,
    attemptMinSpacingBusinessMinutes: 60,
  },
  booking: {
    lawyerChoice: "assigned_only",
    durationMinutes: 60,
    bufferMinutes: 15,
    sameDayMinimumLeadHours: 2,
    horizonDays: 14,
    slotStepMinutes: 30,
    holdMinutes: 10,
    reminderOffsetsHours: [24, 2],
    rebookOffers: 1,
    noShowGraceMinutes: 15,
    rebookWindowBusinessDays: 5,
    calendarStaleMinutes: 5,
    formats: ["video", "phone", "in_person"],
    alwaysPaidConsultMatterTypes: [],
    consultFeeCents: null,
    consultFeeDestination: null,
    consultHoldTaskBusinessHours: 8,
  },
  followUp: {
    enabled: false,
    sequences: {
      abandoned_chat: { dayOffsets: [1, 4, 10], channels: ["email", "sms"] },
      not_booked: { dayOffsets: [1, 4, 10], channels: ["email", "sms"] },
      not_signed: { dayOffsets: [1, 4, 10], channels: ["email"] },
    },
    extraStopWords: [],
  },
  acceptance: { autoDeclineEnabled: true, confidenceThreshold: 0.85, referralsEnabled: true, reviewBusinessHours: 8, countiesServed: [] },
  phone: { ringTimeoutRings: 5 },
}) as IntakeSettings;

type Section = keyof IntakeSettings;

/** The firm's intake settings: each section merged (shallowly) over the defaults. Pure. */
export function intakeSettingsFrom(settings: Pick<FirmSettings, "engineSettings">): IntakeSettings {
  const out = {} as Record<Section, unknown>;
  for (const section of Object.keys(DEFAULT_INTAKE_SETTINGS) as Section[]) {
    const stored = engineSetting<Record<string, unknown> | undefined>(settings, INTAKE_ENGINE, section, undefined);
    const base = DEFAULT_INTAKE_SETTINGS[section] as unknown as Record<string, unknown>;
    out[section] = stored && typeof stored === "object" ? { ...base, ...stored } : { ...base };
  }
  return out as unknown as IntakeSettings;
}

/** Validation errors for a full settings object (empty = valid). Pure. */
export function validateIntakeSettings(s: IntakeSettings): string[] {
  const errors: string[] = [];
  const w = s.assignment.weights;
  if ([w.cadence, w.workload, w.other].some((v) => !Number.isFinite(v) || v < 0)) {
    errors.push("assignment weights must be zero or more.");
  }
  if (w.cadence + w.workload + w.other !== 100) errors.push("assignment weights must sum to 100.");
  if (!Number.isInteger(s.assignment.weeklyNewMatterCap) || s.assignment.weeklyNewMatterCap < 1) {
    errors.push("assignment.weeklyNewMatterCap must be a whole number of at least 1.");
  }
  if (s.assignment.minGapBusinessHours < 0) errors.push("assignment.minGapBusinessHours must be zero or more.");

  const ack = s.emergency.ackWindowMinutes;
  if (!Number.isInteger(ack) || ack < HARD_CAPS.ackWindowMinMinutes || ack > HARD_CAPS.ackWindowMaxMinutes) {
    errors.push(`emergency.ackWindowMinutes must be between ${HARD_CAPS.ackWindowMinMinutes} and ${HARD_CAPS.ackWindowMaxMinutes}.`);
  }
  if (s.emergency.urgentCourtWindowDays < 0) errors.push("emergency.urgentCourtWindowDays must be zero or more.");

  if (s.pipeline.maxStages < 1 || s.pipeline.maxStages > HARD_CAPS.pipelineMaxStages) {
    errors.push(`pipeline.maxStages must be between 1 and ${HARD_CAPS.pipelineMaxStages}.`);
  }

  const stl = s.speedToLead;
  if (stl.dueSoonFraction <= 0 || stl.dueSoonFraction >= 1) errors.push("speedToLead.dueSoonFraction must be between 0 and 1.");
  if (stl.attemptsNeeded < 1) errors.push("speedToLead.attemptsNeeded must be at least 1.");
  if (stl.afterHoursTargetMinutesAfterOpen <= 0) errors.push("speedToLead.afterHoursTargetMinutesAfterOpen must be positive.");

  const b = s.booking;
  if (b.durationMinutes <= 0 || b.slotStepMinutes <= 0) errors.push("booking duration and slot step must be positive.");
  if (b.rebookOffers !== 0 && b.rebookOffers !== 1) errors.push("booking.rebookOffers must be 0 or 1.");
  if (b.reminderOffsetsHours.some((h) => !(h > 0))) errors.push("booking.reminderOffsetsHours must be positive.");
  if (b.formats.length === 0) errors.push("booking.formats needs at least one format.");
  if (b.consultFeeDestination !== null && b.consultFeeDestination !== "operating" && b.consultFeeDestination !== "trust") {
    errors.push("booking.consultFeeDestination must be 'operating', 'trust' or unset.");
  }

  for (const trigger of FOLLOW_UP_TRIGGERS) {
    errors.push(...validateFollowUpSequence(trigger, s.followUp.sequences[trigger]));
  }

  const a = s.acceptance;
  if (a.confidenceThreshold < 0 || a.confidenceThreshold > 1) errors.push("acceptance.confidenceThreshold must be between 0 and 1.");
  if (!(a.reviewBusinessHours > 0)) errors.push("acceptance.reviewBusinessHours must be positive.");
  return errors;
}

/** c70 rule 5: a firm may shorten a sequence but never exceed the product caps. Pure. */
export function validateFollowUpSequence(trigger: string, seq: FollowUpSequence | undefined): string[] {
  if (!seq) return [`followUp.sequences.${trigger} is missing.`];
  const errors: string[] = [];
  if (seq.dayOffsets.length > HARD_CAPS.followUpMaxMessages) {
    errors.push(`followUp.${trigger}: at most ${HARD_CAPS.followUpMaxMessages} messages (product cap).`);
  }
  if (seq.dayOffsets.some((d) => !Number.isFinite(d) || d < 0 || d > HARD_CAPS.followUpMaxDays)) {
    errors.push(`followUp.${trigger}: every message must fall within ${HARD_CAPS.followUpMaxDays} days (product cap).`);
  }
  for (let i = 1; i < seq.dayOffsets.length; i++) {
    if ((seq.dayOffsets[i] ?? 0) <= (seq.dayOffsets[i - 1] ?? 0)) {
      errors.push(`followUp.${trigger}: day offsets must increase.`);
      break;
    }
  }
  if (seq.channels.length === 0) errors.push(`followUp.${trigger}: choose at least one channel.`);
  return errors;
}

/** Merge a patch (by section) over current settings and validate. Throws with every error. Pure. */
export function applyIntakeSettingsPatch(current: IntakeSettings, patch: Partial<Record<Section, Record<string, unknown>>>): IntakeSettings {
  const next = { ...current } as Record<Section, unknown>;
  for (const [section, values] of Object.entries(patch) as [Section, Record<string, unknown>][]) {
    if (!(section in DEFAULT_INTAKE_SETTINGS)) throw new Error(`Unknown intake settings section '${section}'.`);
    next[section] = { ...(current[section] as unknown as Record<string, unknown>), ...values };
  }
  const merged = next as unknown as IntakeSettings;
  const errors = validateIntakeSettings(merged);
  if (errors.length > 0) throw new Error(`Invalid intake settings: ${errors.join(" ")}`);
  return merged;
}

/** Stable short hash of a settings section, recorded with every automated decision. Pure. */
export function settingsVersion(section: unknown): string {
  const text = stableStringify(section);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** JSON with object keys sorted at every level, so equal settings hash equally. Pure. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
