// c76 — one client-matter trust ledger: every entry with who, when, why and
// the invoice it pays, the running balance, and disputed-funds holds.

import Link from "next/link";
import { getSubledgerLedger } from "@/engines/billing-trust/ledgerService";
import { userNames } from "@/engines/billing-trust/reconciliationService";
import { KIND_LABEL, loadTrustPage, Money, Notice, Table, Td, Th } from "../../_lib/data";

export const dynamic = "force-dynamic";

export default async function TrustSubledgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadTrustPage(async (tx, tenantId) => {
    const ledger = await getSubledgerLedger(tx, tenantId, id);
    const names = await userNames(tx, tenantId, [...ledger.lines.map((l) => l.postedByUserId), ...ledger.holds.map((h) => h.placedByUserId)]);
    return { ...ledger, names };
  });
  if (!data.ok) return <Notice message={data.message} />;
  const { subledger, lines, holds, names } = data.value;

  return (
    <div className="space-y-6">
      <div>
        <Link className="text-xs text-sky-700 underline" href={`/admin/billing-trust/accounts/${subledger.trustAccountId}`}>
          ← Account book
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">{subledger.label}</h1>
        <p className="mt-1 text-sm">
          Balance <Money cents={subledger.balance} strong /> · Held <Money cents={subledger.held} /> · Available <Money cents={subledger.available} />
        </p>
      </div>

      <Table
        head={
          <>
            <Th>#</Th>
            <Th>Date</Th>
            <Th>Entry</Th>
            <Th>Why</Th>
            <Th>Invoice / basis</Th>
            <Th>Posted by</Th>
            <Th right>Amount</Th>
            <Th right>Balance</Th>
          </>
        }
      >
        {lines.map((l) => (
          <tr key={l.entryId}>
            <Td mono>{l.sequence}</Td>
            <Td>{l.effectiveDate}</Td>
            <Td>
              {KIND_LABEL[l.kind] ?? l.kind}
              {l.counterparty && <div className="text-xs text-slate-500">{l.counterparty}{l.reference ? ` · ${l.reference}` : ""}</div>}
            </Td>
            <Td>{l.reason}</Td>
            <Td mono>{l.invoiceId ?? l.earnedBasis ?? "—"}</Td>
            <Td>
              {names.get(l.postedByUserId) ?? l.postedByUserId}
              <div className="text-xs text-slate-500">{l.postedAt.toISOString().replace("T", " ").slice(0, 16)} UTC</div>
            </Td>
            <Td right>
              <Money cents={l.amount} />
            </Td>
            <Td right>
              <Money cents={l.balanceAfter} />
            </Td>
          </tr>
        ))}
      </Table>
      {lines.length === 0 && <p className="text-sm text-slate-600">No entries yet.</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Disputed-funds holds</h2>
        {holds.length === 0 ? (
          <p className="text-sm text-slate-600">None.</p>
        ) : (
          <Table
            head={
              <>
                <Th>Placed</Th>
                <Th>Why</Th>
                <Th right>Amount</Th>
                <Th>Released</Th>
              </>
            }
          >
            {holds.map((h) => (
              <tr key={h.id}>
                <Td>
                  {h.placedAt.toISOString().slice(0, 10)} · {names.get(h.placedByUserId) ?? h.placedByUserId}
                </Td>
                <Td>{h.reason}</Td>
                <Td right>
                  <Money cents={h.amount} />
                </Td>
                <Td>{h.releasedAt ? `${h.releasedAt.toISOString().slice(0, 10)} — ${h.releaseReason}` : "Still held"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
