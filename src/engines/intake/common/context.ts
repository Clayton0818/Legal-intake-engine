// Per-request context every intake service needs: firm settings, the
// business calendar and the intake settings section. Loaded once per call.

import { getFirmSettings, toBusinessCalendar, type FirmSettings } from "@/core/firmSettings";
import type { BusinessCalendar } from "@/core/businessHours";
import type { TenantTx } from "@/tenancy/withTenant";
import { intakeSettingsFrom, type IntakeSettings } from "../settings";

export interface IntakeContext {
  tenantId: string;
  firm: FirmSettings;
  calendar: BusinessCalendar;
  settings: IntakeSettings;
}

export async function loadIntakeContext(tx: TenantTx, tenantId: string): Promise<IntakeContext> {
  const firm = await getFirmSettings(tx, tenantId);
  return { tenantId, firm, calendar: toBusinessCalendar(firm), settings: intakeSettingsFrom(firm) };
}
