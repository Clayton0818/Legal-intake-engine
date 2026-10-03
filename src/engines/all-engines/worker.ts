// All-engines worker hooks (discovered by src/worker/hooks.ts).

import type { EngineWorkerModule } from "@/worker/hooks";
import { ensureDefaultPackAdoptions } from "./practiceAreas/service";

export const worker: EngineWorkerModule = {
  tickHooks: [
    {
      name: "all-engines.publish_practice_area_packs",
      engine: "all-engines",
      run: async ({ tx, tenantId }) => ({ ...(await ensureDefaultPackAdoptions(tx, tenantId)) }),
    },
  ],
};
