// c76 — the three-way reconciliation worksheet: bank vs book vs client
// ledgers, outstanding items, itemised differences, sign-offs and export.

import Link from "next/link";
import { getReconciliation, reviveReport } from "@/engines/billing-trust/reconciliationService";
import { loadTrustPage, Money, Notice, Table, Td, Th } from "../../_lib/data";

export const dynamic = "force-dynamic";

export default async function TrustReconciliationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadTrustPage((tx, tenantId) => getReconciliation(tx, tenantId, id));
  if (!data.ok) return <Notice message={data.message} />;
  const { reconciliation: r, signoffs, supersededBy, closed, preparedByName, worksheetIntact } = data.value;
  const report = reviveReport(r.worksheet);

  return (
    <div className="space-y-6">
      <div>
        <Link className="text-xs text-sky-700 underline" href={`/admin/billing-trust/accounts/${r.trustAccountId}`}>
          ← Account book
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">Three-way reconciliation — {r.period}</h1>
        <p className="text-sm text-slate-600">
          Prepared {r.preparedAt.toISOString().slice(0, 16).replace("T", " ")} UTC by {preparedByName ?? r.preparedByUserId} ·{" "}
          {closed ? "Month closed" : supersededBy ? "Superseded by a newer reconciliation" : r.status === "balanced" ? "Balanced — awaiting sign-off" : "DOES NOT BALANCE — the month cannot close"}
        </p>
        {!worksheetIntact && <Notice message="The stored worksheet no longer matches the hash that was signed. Treat this record as altered." />}
        {!r.rulesApproved && (
          <p className="mt-1 text-xs text-amber-800">Prepared while the trust-accounting rules were pending attorney + CPA review.</p>
        )}
        <p className="mt-2 text-sm">
          Download: <a className="text-sky-700 underline" href={`/api/billing-trust/reconciliations/${r.id}/export?format=csv`}>CSV</a> ·{" "}
          <a className="text-sky-700 underline" href={`/api/billing-trust/reconciliations/${r.id}/export?format=json`}>JSON</a>
        </p>
      </div>

      <Table
        head={
          <>
            <Th>Figure</Th>
            <Th right>Amount</Th>
          </>
        }
      >
        <tr><Td>Bank statement closing balance</Td><Td right><Money cents={report.bank.closingBalance} /></Td></tr>
        <tr><Td>Plus deposits in transit</Td><Td right><Money cents={report.bank.depositsInTransit} /></Td></tr>
        <tr><Td>Less outstanding checks / withdrawals</Td><Td right><Money cents={report.bank.outstandingWithdrawals} /></Td></tr>
        <tr><Td><strong>(1) Adjusted bank balance</strong></Td><Td right><Money cents={report.bank.adjustedBalance} strong /></Td></tr>
        <tr><Td><strong>(2) Trust book balance</strong></Td><Td right><Money cents={report.bookBalance} strong /></Td></tr>
        <tr><Td><strong>(3) Sum of client ledgers</strong></Td><Td right><Money cents={report.clientLedgerTotal} strong /></Td></tr>
        <tr>
          <Td>All three agree</Td>
          <Td right>{report.threeWay.agree ? <span className="text-emerald-700">Yes</span> : <span className="font-semibold text-red-700">No</span>}</Td>
        </tr>
      </Table>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Differences ({report.differences.length})</h2>
        {report.differences.length === 0 ? (
          <p className="text-sm text-emerald-700">None.</p>
        ) : (
          <Table
            head={
              <>
                <Th>Item</Th>
                <Th>Blocks closing</Th>
                <Th right>Amount</Th>
              </>
            }
          >
            {report.differences.map((d, i) => (
              <tr key={i}>
                <Td>
                  {d.message}
                  <div className="font-mono text-xs text-slate-500">{d.code}</div>
                </Td>
                <Td>{d.blocking ? "Yes" : "No (warning)"}</Td>
                <Td right>{d.amount === undefined ? "—" : <Money cents={d.amount} />}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Client ledgers at {report.periodEnd}</h2>
        <Table
          head={
            <>
              <Th>Client — matter</Th>
              <Th right>Balance</Th>
              <Th right>Held</Th>
            </>
          }
        >
          {report.ledgers.map((l) => (
            <tr key={l.subledgerId}>
              <Td>{l.label}</Td>
              <Td right><Money cents={l.balanceAtPeriodEnd} /></Td>
              <Td right><Money cents={l.held} /></Td>
            </tr>
          ))}
        </Table>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Outstanding items</h2>
        {report.outstanding.length === 0 ? (
          <p className="text-sm text-slate-600">None.</p>
        ) : (
          <Table
            head={
              <>
                <Th>#</Th>
                <Th>Date</Th>
                <Th>Payee / payer · ref</Th>
                <Th right>Amount</Th>
                <Th right>Age</Th>
              </>
            }
          >
            {report.outstanding.map((o) => (
              <tr key={o.transactionId}>
                <Td mono>{o.sequence}</Td>
                <Td>{o.effectiveDate}</Td>
                <Td>{o.counterparty ?? "—"}{o.reference ? ` · ${o.reference}` : ""}</Td>
                <Td right><Money cents={o.amount} /></Td>
                <Td right>{o.ageDays} days</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Sign-offs</h2>
        {signoffs.length === 0 ? (
          <p className="text-sm text-slate-600">None yet. Sign with <code>POST /api/billing-trust/reconciliations/{r.id}/signoffs</code>.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm text-slate-800">
            {signoffs.map((s) => (
              <li key={s.role}>
                {s.role}: {s.name ?? s.userId} on {s.signedAt.toISOString().slice(0, 10)}
                {s.reportHash !== r.reportHash && <span className="text-red-700"> (signed a different version!)</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="font-mono text-xs text-slate-400">Report hash {r.reportHash}</p>
      </section>
    </div>
  );
}
