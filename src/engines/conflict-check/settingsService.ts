// Firm settings of the Conflict-check engine (firm admin). Stored through the
// core's updateEngineSettings(), which audits every change.

import { audit, getFirmSettings, updateEngineSettings } from "@/core";
import type { TenantTx } from "@/tenancy/withTenant";
import { assertCan, type ConflictAccess } from "./access";
import { ENGINE, readConflictSettings, validateConflictSettingsPatch } from "./settings";
import { actorFor, ConflictError } from "./util";
import { hasCommittedImport } from "./importService";

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
 * a conflicts attorney, because it changes what the system may clear. A
 * firm needs at least one committed import, or must attest in writing that
 * it has no prior client history to import (e.g. a new firm).
 */
export async function confirmHistoryImport(
  tx: TenantTx,
  input: { tenantId: string; access: ConflictAccess; noPriorHistory?: boolean; attestation?: string | null; now?: Date }
) {
  assertCan(input.access, "decide");
  const imported = await hasCommittedImport(tx, input.tenantId);
  const attestation = input.attestation?.trim() ?? "";
  if (!imported && !(input.noPriorHistory && attestation.length >= 20)) {
    throw new ConflictError(
      "Import the firm's client and matter history first, or attest that the firm has no prior history to import.",
      422,
      ["Commit at least one import, or send noPriorHistory: true with a written attestation (20+ characters)."]
    );
  }
  const at = (input.now ?? new Date()).toISOString();
  const updated = await updateEngineSettings(tx, input.tenantId, ENGINE, { historyImportConfirmedAt: at }, actorFor(input.access));
  await audit(tx, {
    tenantId: input.tenantId,
    engine: ENGINE,
    action: "index.history_import_confirmed",
    actor: actorFor(input.access),
    reason: imported ? null : attestation,
    payload: { at, basis: imported ? "import" : "no_prior_history" },
  });
  return readConflictSettings(updated);
}
