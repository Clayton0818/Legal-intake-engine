// The internal/client visibility boundary (founder rule, c45/c47/c53: overdue
// and other internal flags are INTERNAL ONLY; c46/c49: clients see only their
// own client-side items).
//
// Every client-facing query must pass its rows through clientVisible() before
// returning them, IN ADDITION to filtering in SQL — defence in depth, the
// same way withTenant() pairs RLS with an explicit tenantId filter.

export type FlagAudience = "internal" | "client" | "both";
export type TaskVisibility = "internal" | "client";

export type VisibilityCarrier = { audience: FlagAudience | string } | { visibility: TaskVisibility | string };

/** True only for rows explicitly marked for clients. Anything unknown is treated as internal. */
export function isClientVisible(row: VisibilityCarrier): boolean {
  if ("audience" in row) return row.audience === "client" || row.audience === "both";
  if ("visibility" in row) return row.visibility === "client";
  return false;
}

/** Drop every row a client must never see (flags with audience 'internal', tasks with visibility 'internal'). */
export function clientVisible<T extends VisibilityCarrier>(rows: readonly T[]): T[] {
  return rows.filter(isClientVisible);
}

/** Throw if any row is internal — for code paths that must never even receive internal rows. */
export function assertClientVisible<T extends VisibilityCarrier>(rows: readonly T[]): T[] {
  const leaked = rows.filter((r) => !isClientVisible(r));
  if (leaked.length > 0) {
    throw new Error(`Visibility violation: ${leaked.length} internal row(s) reached a client-facing path.`);
  }
  return [...rows];
}
