// c64 — where court email comes from. Vendor-neutral adapter interface.
//
// Real adapters (Microsoft 365 / Gmail read-only mailbox access, eFileTexas /
// PACER CM-ECF service notices) are NOT built: they need the shared vendor
// gates ('vendor.mailbox_access' — DPA + attorney review of privileged-mail
// access — and 'vendor.efiling'), firm authorisation and least-privilege
// scopes. Until then the StubCourtMailSource is installed: it records the
// poll and returns nothing, so no mailbox is ever read.
//
// A real adapter must:
//  - report the provider's SPF / DKIM (with d= domain) / DMARC verdicts;
//  - return only messages it was asked for (the engine discards everything
//    that is not a trusted, authenticated court sender, and keeps only
//    metadata for look-alikes);
//  - never return credentials or tokens in a message.

import { VENDOR_GATES } from "@/compliance/gates";
import type { InboundCourtEmail } from "./detect";

export interface FetchResult {
  messages: InboundCourtEmail[];
  /** Opaque provider cursor stored between polls. */
  cursor: string | null;
}

export interface CourtMailSource {
  /** Unique, stable name, e.g. 'm365:firm-inbox' or 'efiletexas'. */
  readonly name: string;
  readonly kind: "mailbox" | "efiling";
  /** Stubs never read anything and are skipped by the poll. */
  readonly isStub: boolean;
  fetchSince(input: { tenantId: string; cursor: string | null; now: Date }): Promise<FetchResult>;
}

/** The shared vendor gate a source kind needs before it may be polled. */
export function gateForSource(kind: CourtMailSource["kind"] | "manual"): string | null {
  if (kind === "mailbox") return VENDOR_GATES.mailboxAccess.key;
  if (kind === "efiling") return VENDOR_GATES.efiling.key;
  return null;
}

export class StubCourtMailSource implements CourtMailSource {
  readonly isStub = true;
  readonly polls: Array<{ tenantId: string; at: Date }> = [];
  constructor(
    readonly name: string,
    readonly kind: "mailbox" | "efiling"
  ) {}

  async fetchSince(input: { tenantId: string; cursor: string | null; now: Date }): Promise<FetchResult> {
    this.polls.push({ tenantId: input.tenantId, at: input.now });
    return { messages: [], cursor: input.cursor };
  }
}

let sources: CourtMailSource[] = [new StubCourtMailSource("stub:mailbox", "mailbox"), new StubCourtMailSource("stub:efiling", "efiling")];

export function getCourtMailSources(): readonly CourtMailSource[] {
  return sources;
}

/** Install real adapters — only after their vendor gate is approved and the firm authorised access. */
export function setCourtMailSources(next: CourtMailSource[]): void {
  const names = new Set<string>();
  for (const s of next) {
    if (names.has(s.name)) throw new Error(`Duplicate court mail source '${s.name}'.`);
    names.add(s.name);
  }
  sources = [...next];
}
