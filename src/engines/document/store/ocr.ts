// Text recognition for scanned PDFs and photos (c84). The recogniser is an
// AI/vision vendor, so it sits behind vendor.ai_model: until that gate is
// approved nothing leaves the platform and the document is marked
// 'ocr_blocked' (visible, logged). The stub adapter records the request and
// returns "held" instead of calling anyone.

export interface OcrRequest {
  tenantId: string;
  documentId: string;
  mimeType: string;
  bytes: Uint8Array;
}

export type OcrResult = { outcome: "recognized"; text: string; model: string } | { outcome: "held"; detail: string } | { outcome: "failed"; detail: string };

export interface OcrProvider {
  readonly name: string;
  readonly isStub: boolean;
  recognize(req: OcrRequest): Promise<OcrResult>;
}

export class StubOcrProvider implements OcrProvider {
  readonly name = "stub-ocr";
  readonly isStub = true;
  readonly recorded: Array<{ tenantId: string; documentId: string; mimeType: string; sizeBytes: number }> = [];
  async recognize(req: OcrRequest): Promise<OcrResult> {
    this.recorded.push({ tenantId: req.tenantId, documentId: req.documentId, mimeType: req.mimeType, sizeBytes: req.bytes.byteLength });
    return { outcome: "held", detail: "Stub OCR adapter: request recorded, no vendor called." };
  }
}

let provider: OcrProvider = new StubOcrProvider();
export function getOcrProvider(): OcrProvider {
  return provider;
}
export function setOcrProvider(next: OcrProvider): void {
  provider = next;
}
