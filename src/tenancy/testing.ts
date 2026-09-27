// Test helpers for suites that need a REAL database.
//
//   import { describeWithDb, loadDb } from "@/tenancy/testing";
//   describeWithDb("my engine against Postgres", () => {
//     it("…", async () => {
//       const { withTenant, rawDb } = await loadDb();
//       …
//     });
//   });
//
// - DATABASE_URL unset → the suite is SKIPPED (plain `npm test` on a laptop
//   or in a unit-test job stays green).
// - REQUIRE_DATABASE_TESTS=1 (set by `npm run test:isolation`, the required
//   CI check) → a missing DATABASE_URL FAILS instead of skipping, so a lost
//   CI secret can never turn the isolation check into a silent pass.
//
// src/tenancy/db.ts throws at import time without DATABASE_URL, so DB
// modules must be imported lazily (loadDb()), never at the top of the file.

import { describe } from "vitest";

export const hasDatabase = Boolean(process.env.DATABASE_URL);
export const databaseRequired = process.env.REQUIRE_DATABASE_TESTS === "1";

if (databaseRequired && !hasDatabase) {
  throw new Error("REQUIRE_DATABASE_TESTS=1 but DATABASE_URL is not set — refusing to skip the database tests.");
}

/** describe() that runs only when a database is configured. */
export const describeWithDb = describe.skipIf(!hasDatabase);

/** Lazily import the database handles (safe to call only inside describeWithDb). */
export async function loadDb() {
  const [{ withTenant }, { rawDb }] = await Promise.all([import("./withTenant"), import("./db")]);
  return { withTenant, rawDb };
}
