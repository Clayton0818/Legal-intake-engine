// The mandatory tenant-scoping wrapper specified by ADR-0001 §D5.
//
// Every tenant-scoped database access in this codebase MUST go through this
// function. There is no other exported database handle (see db.ts) — that
// is a deliberate structural constraint, not a convention to remember,
// because ADR-0001's own framing is that a non-engineer reviewer cannot
// reliably catch "forgot to scope this query" in a diff, so correctness has
// to come from there being no other way to get a connection at all.
//
// Mechanics: `SET LOCAL` (here, `set_config(..., true)` — the parameterized
// equivalent) is scoped to the current transaction and is discarded at
// commit or rollback. That is what makes it safe under Supabase's
// transaction-pooler mode, where the physical connection is returned to the
// pool — and can be handed to a *different* tenant's request — the instant
// the transaction ends. A session-level `SET` would leak across that
// boundary; this cannot.

import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { rawDb } from "./db";
import * as schema from "@/db/schema";

export type TenantTx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>
): Promise<T> {
  if (!tenantId) {
    throw new Error("withTenant() called without a tenantId — refusing to open an unscoped transaction.");
  }

  return rawDb.transaction(async (tx) => {
    // The `true` third argument is what makes this LOCAL to the transaction
    // rather than SESSION-scoped — the parameterized form of `SET LOCAL`.
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
