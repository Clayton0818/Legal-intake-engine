// Every client-facing ClientCopy item a pack carries, so gates.ts can define
// one copy gate per item and validatePack() can check them. Pure.

import type { ClientCopy, PracticeAreaPack } from "./types";

export interface PackCopyItem extends ClientCopy {
  /** Where in the pack it sits, for the gate description. */
  where: string;
}

export function packCopyItems(pack: PracticeAreaPack): PackCopyItem[] {
  const out: PackCopyItem[] = [];
  for (const q of pack.intake.questions) out.push({ ...q.prompt, where: `intake question '${q.id}'` });
  out.push({ ...pack.intake.safety.notice, where: "safety notice at the start of intake" });
  out.push({ ...pack.intake.safety.signalResponse, where: "reply when a safety signal is detected" });
  for (const c of pack.documents.checklists) {
    for (const i of c.items) if (i.clientRequest) out.push({ ...i.clientRequest, where: `document request '${i.id}'` });
  }
  for (const t of pack.stages.tracks) {
    for (const s of t.stages) if (s.clientLabel) out.push({ ...s.clientLabel, where: `portal stage name '${s.id}'` });
  }
  return out;
}

/** One entry per distinct copy key (the same key may be reused with the SAME draft, e.g. a stage shared by two tracks). */
export function uniqueCopyItems(pack: PracticeAreaPack): PackCopyItem[] {
  const seen = new Map<string, PackCopyItem>();
  for (const item of packCopyItems(pack)) if (!seen.has(item.copyKey)) seen.set(item.copyKey, item);
  return [...seen.values()];
}
