// c57 — keeps the phonetic/nickname match keys (party_match_keys) current
// for parties written by other engines. This engine's own writes add keys
// at once (partyIndex.ts); this catches everything else from the shared
// `parties` table, using a keyset cursor on (updated_at, id).

import { eq } from "drizzle-orm";
import { conflictSyncState } from "@/db/tables/conflict-check";
import type { TenantTx } from "@/tenancy/withTenant";
import { backfillMatchKeys } from "./partyIndex";

export async function backfillMatchKeysForTenant(tx: TenantTx, tenantId: string, limit = 500): Promise<{ processed: number; keys: number }> {
  const [state] = await tx.select().from(conflictSyncState).where(eq(conflictSyncState.tenantId, tenantId)).limit(1);
  // The index sync creates the state row on its first tick; wait for it.
  if (!state) return { processed: 0, keys: 0 };
  const result = await backfillMatchKeys(tx, tenantId, { at: state.matchKeysCursor, id: state.matchKeysCursorId }, limit);
  if (result.processed > 0) {
    await tx
      .update(conflictSyncState)
      .set({ matchKeysCursor: result.cursor.at, matchKeysCursorId: result.cursor.id })
      .where(eq(conflictSyncState.id, state.id));
  }
  return { processed: result.processed, keys: result.keys };
}
