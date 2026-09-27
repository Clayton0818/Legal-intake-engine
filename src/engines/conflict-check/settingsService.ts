// Firm settings of the Conflict-check engine (firm admin). Stored through the
// core's updateEngineSettings(), which audits every change.

import { audit, getFirmSettings, updateEngineSettings } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, type ConflictAccess } from "./access";
import { ENGINE, readConflictSettings, validateConflictSettingsPatch } from "./settings";
import { actorFor, ConflictError } from "./util";

export async function getConflictSettings(tx: TenantTx, tenantId: string, access: ConflictAccess) {
  assertCan(access, "health.view");
  return readConflictSettings(await getFirmSettings(tx, tenantId));
}

export async function updateConflictSettings(tx: TenantTx, input: { tenantId: string; patch: Record<string, unknown>; access: ConflictAccess }) {
  assertCan(input.access, "roles.manage");
  const { values, errors } = validateConflictSettingsPatch(input.patch);
  if (errors.length > 0) throw new ConflictError("Some settings are not valid.", 422, errors);
  const updated = await updateEngineSettings(tx, input.tenantId, ENGINE, values as Record<string, unknown>, actorFor(input.access));
  return readConflictSettings(updated);
}

/**
 * The firm confirms its history import (c96) is complete. Until then no
 * check can come back 'clear' without an attorney (c56 rule 9). Recorded by
 * a conflicts attorney, because it changes what the system may clear.
 */
export async function confirmHistoryImport(tx: TenantTx, input: { tenantId: string; access: ConflictAccess; now?: Date }) {
  assertCan(input.access, "decide");
  const at = (input.now ?? new Date()).toISOString();
  const updated = await updateEngineSettings(tx, input.tenantId, ENGINE, { historyImportConfirmedAt: at }, actorFor(input.access));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.history_import_confirmed",
    actor: actorFor(input.access),
    payload: { at },
  });
  return readConflictSettings(updated);
}
