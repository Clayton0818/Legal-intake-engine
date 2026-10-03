// Shared plumbing for the Billing & trust admin pages (server components).
// Resolves the tenant and signed-in user the same way the API does, applies
// the trust read check, and turns a refusal into a readable message instead
// of an error page. Read-only: every change goes through the gated API.

import { formatCents, type Cents } from "@/engines/billing-trust/money";
import type { TenantTx } from "@/tenancy/withTenant";

export type PageData<T> = { ok: true; value: T } | { ok: false; message: string };

export async function loadTrustPage<T>(fn: (tx: TenantTx, tenantId: string, userId: string) => Promise<T>): Promise<PageData<T>> {
  try {
    const [{ resolveRequestTenantId, requirePrincipal }, { withTenant }, { ensureServerApprovals }, { loadTrustActor, can }] = await Promise.all([
      import("@/auth/request"),
      import("@/tenancy/withTenant"),
      import("@/compliance/server"),
      import("@/engines/billing-trust/access"),
    ]);
    const tenantId = await resolveRequestTenantId();
    await ensureServerApprovals();
    return await withTenant(tenantId, async (tx) => {
      const me = await requirePrincipal(tx, tenantId);
      if (!me.userId) return { ok: false as const, message: "Trust records need a real signed-in user (set DEV_USER_ID in dev mode)." };
      const actor = await loadTrustActor(tx, tenantId, me.userId);
      if (!can(actor, "read")) return { ok: false as const, message: "Only the firm owner, a bookkeeper or a lawyer can view trust records." };
      return { ok: true as const, value: await fn(tx, tenantId, me.userId) };
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Could not load trust records." };
  }
}

export function Money({ cents, strong = false }: { cents: Cents; strong?: boolean }) {
  const negative = cents < 0n;
  return (
    <span className={`whitespace-nowrap tabular-nums ${negative ? "text-red-700" : "text-slate-900"} ${strong ? "font-semibold" : ""}`}>
      {formatCents(cents)}
    </span>
  );
}

export function Notice({ message }: { message: string }) {
  return <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{message}</div>;
}

export function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium text-slate-600 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

export function Td({ children, right = false, mono = false }: { children: React.ReactNode; right?: boolean; mono?: boolean }) {
  return <td className={`px-3 py-2 align-top ${right ? "text-right" : ""} ${mono ? "font-mono text-xs text-slate-500" : "text-slate-800"}`}>{children}</td>;
}

export function Table({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export const KIND_LABEL: Record<string, string> = {
  deposit: "Deposit",
  disbursement: "Disbursement",
  earned_fee_transfer: "Earned fee to operating",
  refund: "Refund to client",
  transfer: "Transfer between matters",
  cushion_deposit: "Firm cushion deposit",
  cushion_withdrawal: "Firm cushion withdrawal",
  bank_fee: "Bank fee (cushion)",
  reversal: "Reversal (correction)",
};
