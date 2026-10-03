// Document engine worker module (discovered by src/worker/hooks.ts).
//
// Tick hooks, once per active firm per tick:
//   document.provision_folders  give every open matter without folders its template folders,
//                               so a matter opened by any engine gets folders without importing this one
//   document.index_text         extract text for pending versions; retry scanned files only when an
//                               approved OCR service is wired (vendor.object_storage)
// Both are idempotent and bounded by firm settings (batch sizes).

import type { EngineWorkerModule } from "@/worker/hooks";
import { getFirmSettings } from "@/core";
import { readDocumentSettings } from "./settings";
import { mattersWithoutFolders, provisionMatterFolders } from "./folders/service";
import { processTextBacklog } from "./extraction/service";

export const worker: EngineWorkerModule = {
  tickHooks: [
    {
      name: "document.provision_folders",
      engine: "document",
      run: async ({ tx, tenantId }) => {
        const settings = readDocumentSettings(await getFirmSettings(tx, tenantId));
        const ids = await mattersWithoutFolders(tx, tenantId, settings.provisionBatchSize);
        let folders = 0;
        for (const id of ids) folders += (await provisionMatterFolders(tx, tenantId, id)).created;
        return { matters: ids.length, folders };
      },
    },
    {
      name: "document.index_text",
      engine: "document",
      run: async ({ tx, tenantId, now }) => {
        const settings = readDocumentSettings(await getFirmSettings(tx, tenantId));
        return processTextBacklog(tx, tenantId, settings, { now });
      },
    },
  ],
  scheduledTaskHandlers: {},
};
