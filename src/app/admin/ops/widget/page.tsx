// c38 — manage where the firm embeds the intake widget, and copy the snippet.
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

async function createEmbed(formData: FormData) {
  "use server";
  const label = String(formData.get("label") ?? "");
  const origins = String(formData.get("origins") ?? "").split(/[\s,]+/);
  const [{ resolveRequestTenantId, requirePrincipal }, { withTenant }, { createWidgetEmbed }] = await Promise.all([
    import("@/auth/request"),
    import("@/tenancy/withTenant"),
    import("@/widget/embeds"),
  ]);
  const tenantId = await resolveRequestTenantId();
  let result: { key: string } | { error: string };
  try {
    result = await withTenant(tenantId, async (tx) => {
      const by = await requirePrincipal(tx, tenantId, "widget.manage");
      const { key } = await createWidgetEmbed(tx, { by, label, allowedOrigins: origins });
      return { key };
    });
  } catch (err) {
    result = { error: err instanceof Error ? err.message : "Could not create the embed." };
  }
  // The key is public by design (it sits in the firm's page source), so it may travel in the URL.
  redirect(`/admin/ops/widget?${"key" in result ? `key=${encodeURIComponent(result.key)}` : `error=${encodeURIComponent(result.error)}`}`);
}

export default async function WidgetEmbedsPage({ searchParams }: { searchParams: Promise<{ key?: string; error?: string }> }) {
  const sp = await searchParams;
  const [{ resolveRequestTenantId, requirePrincipal }, { withTenant }, { listWidgetEmbeds }] = await Promise.all([
    import("@/auth/request"),
    import("@/tenancy/withTenant"),
    import("@/widget/embeds"),
  ]);
  let embeds;
  try {
    const tenantId = await resolveRequestTenantId();
    embeds = await withTenant(tenantId, async (tx) => {
      await requirePrincipal(tx, tenantId, "widget.manage");
      return listWidgetEmbeds(tx, tenantId);
    });
  } catch (err) {
    return <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-700">{(err as Error).message}</div>;
  }
  const h = await headers();
  const appOrigin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "your-app"}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Website chat widget</h1>
        <Link href="/admin/ops" className="text-sm text-slate-500 hover:underline">
          ← Attention needed
        </Link>
      </div>

      {sp.error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{sp.error}</p>}
      {sp.key && (
        <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
          <p className="font-medium text-emerald-900">Embed created. Paste this before &lt;/body&gt; on the allowed site(s):</p>
          <pre className="overflow-x-auto rounded bg-white p-3 text-xs text-slate-800">
            {`<script src="${appOrigin}/widget/embed.js" data-widget-key="${sp.key}" async></script>`}
          </pre>
          <p className="text-emerald-900">
            The site must also be listed in this deployment&apos;s WIDGET_FRAME_ANCESTORS setting, or browsers will refuse to show the chat.
          </p>
        </div>
      )}

      <form action={createEmbed} className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm font-medium text-slate-900">New embed</p>
        <input name="label" required placeholder="Label (e.g. Main website)" className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <input
          name="origins"
          required
          placeholder="Allowed sites, e.g. https://firm.com https://*.firm.com"
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Create embed key
        </button>
      </form>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-slate-600">Label</th>
              <th className="px-4 py-2 text-left font-medium text-slate-600">Allowed sites</th>
              <th className="px-4 py-2 text-left font-medium text-slate-600">Status</th>
              <th className="px-4 py-2 text-left font-medium text-slate-600">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {embeds.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-4 text-slate-500">
                  No embeds yet.
                </td>
              </tr>
            ) : (
              embeds.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 font-medium text-slate-900">{e.label}</td>
                  <td className="px-4 py-2 text-slate-700">{e.allowedOrigins.join(", ")}</td>
                  <td className="px-4 py-2">{e.enabled ? "Enabled" : "Disabled"}</td>
                  <td className="px-4 py-2 text-slate-500">{e.createdAt.toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
