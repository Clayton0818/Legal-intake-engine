// Loads every approval gate in the product: the shared ones (./gates.ts) plus
// each engine's src/engines/<slug>/gates.ts, if that engine has one. Engines
// never edit this file — dropping a gates.ts into their folder is enough.
//
// Use before listing gates (admin "pending approvals" page, the compliance
// CLI) so the list is complete. Code that USES a gate imports the module that
// defines it directly and does not need this.

import "./gates";
import { listGates, type Gate } from "./approvals";
import { ENGINE_SLUGS, isModuleNotFound } from "@/core/engines";

let loaded: Promise<void> | null = null;

async function importEngineGates(slug: string): Promise<void> {
  try {
    // Relative template so bundlers (Next.js) can see the candidate files.
    await import(`../engines/${slug}/gates.ts`);
  } catch (err) {
    if (isModuleNotFound(err, `${slug}/gates`)) return; // engine has no gates yet
    throw err;
  }
}

/** Import every engine's gates.ts once; then listGates() is complete. */
export function loadAllGates(): Promise<void> {
  loaded ??= (async () => {
    for (const slug of ENGINE_SLUGS) await importEngineGates(slug);
  })();
  return loaded;
}

/** All gates, shared and engine-defined, sorted by key. */
export async function listAllGates(): Promise<Gate[]> {
  await loadAllGates();
  return listGates();
}
