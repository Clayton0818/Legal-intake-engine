// Operator CLI for approval gates. Run with tsx:
//
//   npm run compliance -- list
//   npm run compliance -- approve --gate vendor.email --reviewer vendor_dpa --by "Jane Roe (DPA signed 2026-10-01)" [--notes "..."] [--text-file wording.txt]
//   npm run compliance -- revoke  --gate vendor.email --reviewer vendor_dpa --reason "DPA terminated"
//
// Writes go to the platform-level `compliance_approvals` table with the
// ELEVATED connection (MIGRATIONS_DATABASE_URL), because the app role
// (app_runtime) may only SELECT it. Recording an approval is a human act:
// only run `approve` when the named reviewer has actually signed off.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNull } from "drizzle-orm";
import { complianceApprovals } from "@/db/tables/foundation";
import { listAllGates } from "./allGates";
import { setApprovals, type ApprovalRecord, type ReviewerKind } from "./approvals";
import { buildApprovalInsert, formatGateReport } from "./report";

function connect() {
  const url = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATIONS_DATABASE_URL (an elevated role) to read or record approvals.");
  const client = postgres(url, { max: 1, prepare: false });
  return { client, db: drizzle(client) };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      gate: { type: "string" },
      reviewer: { type: "string" },
      by: { type: "string" },
      notes: { type: "string" },
      "text-file": { type: "string" },
      reason: { type: "string" },
    },
  });
  const gates = await listAllGates();

  if (command === "list") {
    const url = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
    if (url) {
      const { client, db } = connect();
      const rows = await db.select().from(complianceApprovals);
      setApprovals(
        rows.map(
          (r): ApprovalRecord => ({ ...r, reviewerKind: r.reviewerKind as ReviewerKind })
        )
      );
      await client.end();
    } else {
      console.log("(No database URL set — showing every gate as pending.)\n");
    }
    console.log(formatGateReport(gates));
    return;
  }

  if (command === "approve") {
    const insert = buildApprovalInsert({
      gateKey: values.gate ?? "",
      reviewerKind: values.reviewer ?? "",
      approvedByName: values.by ?? "",
      notes: values.notes,
      approvedText: values["text-file"] ? readFileSync(values["text-file"], "utf8") : null,
    });
    const { client, db } = connect();
    await db.insert(complianceApprovals).values(insert);
    await client.end();
    console.log(`Recorded ${insert.reviewerKind} approval for '${insert.gateKey}' by ${insert.approvedByName}.`);
    return;
  }

  if (command === "revoke") {
    if (!values.gate || !values.reviewer || !values.reason?.trim()) {
      throw new Error("revoke needs --gate, --reviewer and --reason.");
    }
    const { client, db } = connect();
    const rows = await db
      .update(complianceApprovals)
      .set({ revokedAt: new Date(), revokedReason: values.reason.trim() })
      .where(
        and(
          eq(complianceApprovals.gateKey, values.gate),
          eq(complianceApprovals.reviewerKind, values.reviewer),
          isNull(complianceApprovals.revokedAt)
        )
      )
      .returning({ id: complianceApprovals.id });
    await client.end();
    console.log(`Revoked ${rows.length} approval(s) for '${values.gate}' (${values.reviewer}).`);
    return;
  }

  console.log("Usage: npm run compliance -- <list|approve|revoke> [--gate KEY --reviewer KIND --by NAME --notes TEXT --text-file PATH --reason TEXT]");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[compliance] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
