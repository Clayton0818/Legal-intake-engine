// Firm settings (one `firm_settings` row per firm). Every number the founder
// already decided — 24h firm reply, 48h client promise, 12h/24h deadline
// questions, $4,500 retainer floor, Family Law pilot — is a normal,
// firm-editable setting with that default. These are NOT approval gates.

import { eq } from "drizzle-orm";
import { firmSettings, DEFAULT_WEEKLY_HOURS } from "@/db/tables/foundation";
import type { TenantTx } from "@/tenancy/withTenant";
import { validateCalendar, type BusinessCalendar } from "./businessHours";
import { DEFAULT_PRACTICE_AREAS, validatePracticeAreas } from "./practiceAreas";
import { audit, type Actor } from "./audit";

export type FirmSettingsRow = typeof firmSettings.$inferSelect;

/** Everything a firm can edit (no ids / bookkeeping columns). */
export type FirmSettingsValues = Omit<FirmSettingsRow, "id" | "tenantId" | "updatedAt" | "updatedByUserId">;

export interface FirmSettings extends FirmSettingsValues {
  tenantId: string;
  /** False when the firm has no row yet and these are the defaults. */
  persisted: boolean;
}

export const DEFAULT_FIRM_SETTINGS: Readonly<FirmSettingsValues> = Object.freeze({
  timeZone: "America/Chicago",
  businessHours: DEFAULT_WEEKLY_HOURS,
  holidays: [],
  enabledPracticeAreas: [...DEFAULT_PRACTICE_AREAS],
  firmReplyHours: 24,
  clientPromiseHours: 48,
  deadlineQuestionFlagHours: 12,
  deadlineQuestionReplyHours: 24,
  clientResponseWindowHours: 48,
  dueSoonBusinessHours: 8,
  overdueGraceBusinessHours: 8,
  courtNoticeAckMinutes: 120,
  newInquiryResponseMinutes: 15,
  retainerFloorCents: 450_000,
  retainerWarningCents: null,
  quietHours: null,
  internalEmailDigest: false,
  emailFromName: null,
  emailFromAddress: null,
  emailReplyTo: null,
  clientPortalUrl: null,
  engineSettings: {},
});

/** Merge a (possibly missing) row over the defaults. */
export function withDefaults(row: FirmSettingsRow | null | undefined, tenantId: string): FirmSettings {
  if (!row) return { ...DEFAULT_FIRM_SETTINGS, tenantId, persisted: false };
  return { ...pickValues(row), tenantId, persisted: true };
}

/** The firm's business calendar for src/core/businessHours.ts. */
export function toBusinessCalendar(s: Pick<FirmSettingsValues, "timeZone" | "businessHours" | "holidays">): BusinessCalendar {
  return { timeZone: s.timeZone, weekly: s.businessHours, holidays: s.holidays };
}

/** Read one engine's setting from the `engineSettings` bag, with a fallback. */
export function engineSetting<T>(s: Pick<FirmSettingsValues, "engineSettings">, engine: string, key: string, fallback: T): T {
  const bag = s.engineSettings?.[engine];
  if (bag && Object.prototype.hasOwnProperty.call(bag, key)) return bag[key] as T;
  return fallback;
}

/** Validate a settings patch; throws with a readable message. Returns the normalised patch. */
export function validateSettingsPatch(patch: Partial<FirmSettingsValues>): Partial<FirmSettingsValues> {
  const out: Partial<FirmSettingsValues> = { ...patch };
  if (patch.timeZone !== undefined || patch.businessHours !== undefined || patch.holidays !== undefined) {
    validateCalendar({
      timeZone: patch.timeZone ?? DEFAULT_FIRM_SETTINGS.timeZone,
      weekly: patch.businessHours ?? DEFAULT_FIRM_SETTINGS.businessHours,
      holidays: patch.holidays ?? [],
    });
  }
  if (patch.enabledPracticeAreas !== undefined) {
    out.enabledPracticeAreas = validatePracticeAreas(patch.enabledPracticeAreas);
  }
  const positiveInts: (keyof FirmSettingsValues)[] = [
    "firmReplyHours",
    "clientPromiseHours",
    "deadlineQuestionFlagHours",
    "deadlineQuestionReplyHours",
    "clientResponseWindowHours",
    "courtNoticeAckMinutes",
    "newInquiryResponseMinutes",
  ];
  for (const key of positiveInts) {
    const v = patch[key];
    if (v !== undefined && (!Number.isInteger(v) || (v as number) <= 0)) {
      throw new Error(`${String(key)} must be a positive whole number.`);
    }
  }
  for (const key of ["dueSoonBusinessHours", "overdueGraceBusinessHours"] as const) {
    const v = patch[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new Error(`${key} must be zero or more.`);
  }
  if (patch.retainerFloorCents !== undefined && (!Number.isInteger(patch.retainerFloorCents) || patch.retainerFloorCents < 0)) {
    throw new Error("retainerFloorCents must be a whole number of cents, zero or more.");
  }
  if (
    patch.firmReplyHours !== undefined &&
    patch.clientPromiseHours !== undefined &&
    patch.firmReplyHours > patch.clientPromiseHours
  ) {
    throw new Error("The internal reply target must not be later than the time promised to the client.");
  }
  return out;
}

/** The firm's settings, or the defaults when it has none yet. */
export async function getFirmSettings(tx: TenantTx, tenantId: string): Promise<FirmSettings> {
  const [row] = await tx.select().from(firmSettings).where(eq(firmSettings.tenantId, tenantId)).limit(1);
  return withDefaults(row, tenantId);
}

/** Create or update the firm's settings (owner/admin only — enforce the role at the route). Logged. */
export async function updateFirmSettings(
  tx: TenantTx,
  tenantId: string,
  patch: Partial<FirmSettingsValues>,
  by: Actor
): Promise<FirmSettings> {
  const clean = validateSettingsPatch(patch);
  const current = await getFirmSettings(tx, tenantId);
  const merged: FirmSettingsValues = { ...pickValues(current), ...clean };
  if (merged.firmReplyHours > merged.clientPromiseHours) {
    throw new Error("The internal reply target must not be later than the time promised to the client.");
  }
  validateCalendar(toBusinessCalendar(merged));
  const updatedByUserId = by.type === "user" ? by.userId : null;
  const [row] = await tx
    .insert(firmSettings)
    .values({ ...merged, tenantId, updatedByUserId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: firmSettings.tenantId,
      set: { ...merged, updatedByUserId, updatedAt: new Date() },
    })
    .returning();
  await audit(tx, {
    tenantId,
    engine: "core",
    action: "firm_settings.updated",
    entityType: "firm_settings",
    entityId: row?.id ?? null,
    actor: by,
    payload: { changed: Object.keys(clean) },
  });
  return withDefaults(row, tenantId);
}

/** Merge values into one engine's settings bag (other engines' bags are untouched). */
export async function updateEngineSettings(
  tx: TenantTx,
  tenantId: string,
  engine: string,
  values: Record<string, unknown>,
  by: Actor
): Promise<FirmSettings> {
  const current = await getFirmSettings(tx, tenantId);
  const engineSettings = {
    ...current.engineSettings,
    [engine]: { ...(current.engineSettings[engine] ?? {}), ...values },
  };
  return updateFirmSettings(tx, tenantId, { engineSettings }, by);
}

/** Copy exactly the editable keys (those present in DEFAULT_FIRM_SETTINGS), falling back to defaults. */
function pickValues(src: Partial<FirmSettingsValues>): FirmSettingsValues {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_FIRM_SETTINGS) as (keyof FirmSettingsValues)[]) {
    const v = src[key];
    out[key] = v === undefined ? DEFAULT_FIRM_SETTINGS[key] : v;
  }
  return out as unknown as FirmSettingsValues;
}
