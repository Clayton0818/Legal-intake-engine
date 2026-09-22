"use client";

// Covers /admin and every nested segment (e.g. /admin/matters/[id]) that
// doesn't define its own error.tsx. Most failures here in this sandbox/dev
// stage are DEV_TENANT_ID or DATABASE_URL not being set yet (see
// src/tenancy/devTenant.ts, src/tenancy/db.ts) — surfacing the real error
// message is more useful to whoever's staffing this than a generic
// "Something went wrong."
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-6">
      <h2 className="text-sm font-semibold text-red-800">Couldn&apos;t load the staff console.</h2>
      <p className="mt-1 whitespace-pre-wrap text-sm text-red-700">{error.message}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
      >
        Try again
      </button>
    </div>
  );
}
