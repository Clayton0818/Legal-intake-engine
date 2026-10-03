"use client";

// Small fetch helper for the All-engines admin client components.
export async function send(url: string, method: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return null;
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string; details?: string[] } | null;
  return [data?.error ?? data?.message ?? `HTTP ${res.status}`, ...(data?.details ?? [])].join(" ");
}
