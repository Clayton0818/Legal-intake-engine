// Runs the generated SQL migrations under migrations/ against a real
// database. Deliberately separate from the app's runtime connection
// (src/tenancy/db.ts): `app_runtime` (the role the app connects as) holds
// no DDL privileges by design (docs/architecture/core-data-model-schema-design.md
// §3), so this script needs an elevated connection string — set
// MIGRATIONS_DATABASE_URL to a role that can run CREATE TABLE / CREATE TYPE
// (e.g. Supabase's default `postgres` role), not the app_runtime one.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const connectionString = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Set MIGRATIONS_DATABASE_URL (preferred) or DATABASE_URL before running migrations.");
}

async function main() {
  const client = postgres(connectionString!, { max: 1, prepare: false });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./migrations" });
  await client.end();
  console.log("[db:migrate] done.");
}

main().catch((err) => {
  console.error("[db:migrate] failed:", err);
  process.exit(1);
});
