// Internal connection setup. Per ADR-0001 §D5: "No other database handle is
// exported from the data module" — this file is intentionally not exported
// from the package's public surface. `withTenant.ts` is the only sanctioned
// way anything outside `tenancy/` touches the database.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Expected the Supabase transaction-pooler " +
      "connection string for the app_runtime role (see " +
      "docs/architecture/staging-environment-setup.md)."
  );
}

// `prepare: false` is not optional here — it is the single most important
// line in this file. Supabase's transaction-pooler (Supavisor, port 6543)
// hands the underlying physical connection back to the pool at the end of
// every transaction, which means it cannot honor server-side prepared
// statements that are expected to live across that boundary. postgres.js
// defaults to using them; leaving this on under a transaction pooler fails
// unpredictably under load rather than immediately, which is exactly the
// kind of quiet failure ADR-0001 says this project should design against.
const client = postgres(connectionString, { prepare: false });

export const rawDb = drizzle(client, { schema });
