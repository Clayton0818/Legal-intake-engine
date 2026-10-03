// c76 — one trust account's book: client-matter ledgers, the check register
// with running balance, and every reconciliation ever prepared.

import Link from "next/link";
import { getAccountRegister, getTrustAccount, listSubledgers } from "@/engines/billing-trust/ledgerService";
import { listReconciliations, listStatements } from "@/engines/billing-trust/reconciliationService";
import { KIND_LABEL, loadTrustPage, Money, Notice, Table, Td, Th } from "../../_lib/data";

export const dynamic = "force-dynamic";

export default async function TrustAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadTrustPage(async (tx, tenantId) => ({
    account: await getTrustAccount(tx, tenantId, id),
    subledgers: await listSubledgers(tx, tenantId, id),
    register: await getAccountRegister(tx, tenantId, id),
    reconciliations: await listReconciliations(tx, tenantId, id),
    statements: await listStatements(tx, tenantId, id),
  }));
  if (!data.ok) return <Notice message={data.message} />;
  const { account, subledgers, register, reconciliations, statements } = data.value;
  const book = register.at(-1)?.runningBalance ?? 0n;
  const total = subledgers.reduce((s, l) => s + l.balance, 0n);

  return (
    <div className="space-y-6">
      <div>
        <Link className="text-xs text-sky-700 underline" href="/admin/billing-trust">
          ← Trust accounts
        </Link>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">{account.name}</h1>
        <p className="text-sm text-slate-600">
          {account.bankName} ••{account.accountNumberLast4} · {account.accountType.toUpperCase()} · opened {account.openedOn}
        </p>
        <p className="mt-2 text-sm">
          Book balance <Money cents={book} strong /> · Sum of client ledgers <Money cents={total} strong />{" "}
          {book === total ? (
            <span className="text-emerald-700">(agree)</span>
          ) : (
            <span className="font-semibold text-red-700">(DO NOT AGREE — investigate now)</span>
          )}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Client ledgers</h2>
        <Table
          head={
            <>
              <Th>Client — matter</Th>
              <Th right>Balance</Th>
              <Th right>Held (disputed)</Th>
              <Th right>Available</Th>
            </>
          }
        >
          {subledgers.map((s) => (
            <tr key={s.id}>
              <Td>
                <Link className="text-sky-700 underline" href={`/admin/billing-trust/subledgers/${s.id}`}>
                  {s.label}
                </Link>
                {s.matterClosedAt && s.balance > 0n && <div className="text-xs text-amber-800">Matter closed — review for refund</div>}
              </Td>
              <Td right>
                <Money cents={s.balance} />
              </Td>
              <Td right>
                <Money cents={s.held} />
              </Td>
              <Td right>
                <Money cents={s.available} />
              </Td>
            </tr>
          ))}
        </Table>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Register (check register / account book)</h2>
        {register.length === 0 ? (
          <p className="text-sm text-slate-600">No entries yet.</p>
        ) : (
          <Table
            head={
              <>
                <Th>#</Th>
                <Th>Date</Th>
                <Th>Entry</Th>
                <Th>Payee / payer · ref</Th>
                <Th>Why</Th>
                <Th right>Amount</Th>
                <Th right>Balance</Th>
              </>
            }
          >
            {register.map((r) => (
              <tr key={r.id}>
                <Td mono>{r.sequence}</Td>
                <Td>{r.effectiveDate}</Td>
                <Td>
                  {KIND_LABEL[r.kind] ?? r.kind}
                  {r.reversedById && <div className="text-xs text-amber-800">Reversed</div>}
                </Td>
                <Td>
                  {r.counterparty ?? "—"}
                  {r.reference ? ` · ${r.reference}` : ""}
                </Td>
                <Td>{r.reason}</Td>
                <Td right>
                  <Money cents={r.netAmount} />
                </Td>
                <Td right>
                  <Money cents={r.runningBalance} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Reconciliations (all kept)</h2>
        {reconciliations.length === 0 ? (
          <p className="text-sm text-slate-600">
            None yet. {statements.length === 0 ? "Enter the month's bank statement first, then prepare the reconciliation." : ""}
          </p>
        ) : (
          <Table
            head={
              <>
                <Th>Month</Th>
                <Th>Status</Th>
                <Th right>Adjusted bank</Th>
                <Th right>Book</Th>
                <Th right>Client ledgers</Th>
                <Th>Prepared</Th>
              </>
            }
          >
            {reconciliations.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link className="text-sky-700 underline" href={`/admin/billing-trust/reconciliations/${r.id}`}>
                    {r.period}
                  </Link>
                </Td>
                <Td>
                  {r.closedMonth ? "Closed" : r.superseded ? "Superseded" : r.status === "balanced" ? "Balanced — awaiting sign-off" : `Does not balance (${r.differences})`}
                </Td>
                <Td right>
                  <Money cents={r.adjustedBankBalance} />
                </Td>
                <Td right>
                  <Money cents={r.bookBalance} />
                </Td>
                <Td right>
                  <Money cents={r.clientLedgerTotal} />
                </Td>
                <Td>{r.preparedAt.toISOString().slice(0, 10)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
