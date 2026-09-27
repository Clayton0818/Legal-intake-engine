// E-signature vendor boundary for conflict waivers (c59 §4.4).
//
// VENDOR — GATED. The real provider needs a signed DPA (`vendor.esignature`).
// Until then the stub adapter records the request and returns 'held', so
// nothing leaves the platform. A real adapter implements the same interface
// and is installed with setESignatureProvider() at startup.

export interface SignatureRequest {
  tenantId: string;
  waiverId: string;
  signerPartyId: string;
  documentId: string | null;
  /** Firm countersignature required after the client signs. */
  countersign: boolean;
}

export interface SignatureSendResult {
  outcome: "sent" | "held" | "failed";
  envelopeId?: string;
  detail?: string;
}

export interface ESignatureProvider {
  readonly name: string;
  readonly isStub: boolean;
  sendForSignature(req: SignatureRequest): Promise<SignatureSendResult>;
}

/** Records every request; never sends. */
export class StubESignatureProvider implements ESignatureProvider {
  readonly name = "stub-esignature";
  readonly isStub = true;
  readonly recorded: SignatureRequest[] = [];

  async sendForSignature(req: SignatureRequest): Promise<SignatureSendResult> {
    this.recorded.push({ ...req });
    return { outcome: "held", detail: "Stub e-signature provider: recorded, not sent (vendor.esignature DPA pending)." };
  }
}

let provider: ESignatureProvider = new StubESignatureProvider();

export function getESignatureProvider(): ESignatureProvider {
  return provider;
}

export function setESignatureProvider(next: ESignatureProvider): void {
  provider = next;
}
