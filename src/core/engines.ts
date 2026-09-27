// The seven engine slugs (see src/engines/README.md). Each slug owns
//   src/engines/<slug>/**        domain code + tests
//   src/db/tables/<slug>.ts      its tables
//   src/app/api/<slug>/**        its API routes
//   src/app/admin/<slug>/**      its admin pages
// and may plug into shared infrastructure WITHOUT editing shared files, by
// convention-named modules that are discovered at runtime:
//   src/engines/<slug>/gates.ts   approval gates (loaded by src/compliance/allGates.ts)
//   src/engines/<slug>/worker.ts  worker tick hooks + scheduled-task handlers (src/worker/hooks.ts)

export const ENGINE_SLUGS = [
  "intake",
  "conflict-check",
  "document",
  "calendar-alerts",
  "calendar-core",
  "billing-trust",
  "all-engines",
] as const;

export type EngineSlug = (typeof ENGINE_SLUGS)[number];

/** 'core' is used for audit entries written by src/core itself. */
export type AuditEngine = EngineSlug | "core";

export const ENGINE_INFO: Readonly<Record<EngineSlug, { label: string; cards: string }>> = {
  intake: { label: "Intake engine", cards: "c48, c65–c74" },
  "conflict-check": { label: "Conflict-check engine", cards: "c3, c55–c63, c96, c97" },
  document: { label: "Document engine", cards: "c39–c41, c49, c84–c90" },
  "calendar-alerts": { label: "Calendar & deadline engine — alerts", cards: "c42–c47, c51, c53, c54, c64" },
  "calendar-core": { label: "Calendar & deadline engine — calendar core", cards: "c91–c95" },
  "billing-trust": { label: "Billing & trust engine", cards: "c50, c52, c75–c83" },
  "all-engines": { label: "All engines (cross-cutting)", cards: "c98–c105" },
};

export function isEngineSlug(value: unknown): value is EngineSlug {
  return typeof value === "string" && (ENGINE_SLUGS as readonly string[]).includes(value);
}

/**
 * True when a failed dynamic import means "this engine has no such module
 * yet" (fine) rather than "the module exists but threw while loading" (a
 * real bug that must surface).
 */
export function isModuleNotFound(err: unknown, specifierFragment: string): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string }).code;
  // Error codes/messages from Node + tsx, webpack (Next.js), and Vite's
  // variable-dynamic-import helper (vitest), in that order.
  const notFound =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find module|Failed to load url|Unknown variable dynamic import/i.test(err.message);
  return notFound && err.message.includes(specifierFragment);
}
