// Admin/staff console (board card c24). Real path segment (/admin/...), not
// a Next.js route group — the URL distinction matters here since this is a
// staff-only surface, separate from the client-facing /chat/... path, and
// eventually sits behind real auth (Clerk/WorkOS, ADR-0001 §D8) once that's
// wired up. `middleware.ts`'s auth stub currently tags every request as
// unauthenticated — do not treat this layout as access-controlled yet.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-6 py-3">
        <span className="text-sm font-semibold text-slate-900">Legal Intake — Staff Console</span>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-6">{children}</div>
    </div>
  );
}
