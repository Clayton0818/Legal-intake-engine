import { defineConfig } from "drizzle-kit";

// ADR-0001 §D4: migrations are generated here, then reviewed and committed
// as plain SQL under migrations/ — never applied as an invisible ORM diff.
// This config is only used to *generate* that SQL (`npm run db:generate`);
// nothing here runs automatically against a live database.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://placeholder/placeholder",
  },
});
