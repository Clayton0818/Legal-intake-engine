// Test-only builders for small real files (zip/docx/xlsx/pdf), so extraction
// tests run on genuine byte layouts rather than mocks. Not used at runtime.

import { deflateRawSync, deflateSync } from "node:zlib";

export function buildZip(files: Record<string, string>, opts: { store?: boolean } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = opts.store ? raw : deflateRawSync(raw);
    const method = opts.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

export function buildDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return buildZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
  });
}

/** A one- or multi-page PDF whose pages draw the given text lines (Flate-compressed unless raw). */
export function buildPdf(pages: string[][], opts: { compress?: boolean; textLayer?: boolean } = {}): Uint8Array {
  const compress = opts.compress ?? true;
  const parts: string[] = ["%PDF-1.4\n"];
  const bin: Buffer[] = [];
  const push = (s: string | Buffer) => bin.push(typeof s === "string" ? Buffer.from(s, "latin1") : s);
  push(parts[0]!);
  let obj = 1;
  push(`${obj++} 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`);
  push(`${obj++} 0 obj << /Type /Pages /Count ${pages.length} >> endobj\n`);
  for (const lines of pages) {
    const esc = (s: string) => s.replace(/([()\\])/g, "\\$1");
    const content =
      opts.textLayer === false
        ? "q 612 0 0 792 0 0 cm /Im1 Do Q"
        : `BT /F1 12 Tf 72 712 Td ${lines.map((l, i) => `${i ? "0 -14 Td " : ""}(${esc(l)}) Tj`).join(" ")} ET`;
    const data = compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
    push(`${obj++} 0 obj << /Type /Page /Parent 2 0 R /Contents ${obj} 0 R >> endobj\n`);
    push(`${obj++} 0 obj << /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`);
    push(data);
    push("\nendstream endobj\n");
  }
  push("trailer << /Root 1 0 R >>\n%%EOF\n");
  return new Uint8Array(Buffer.concat(bin));
}
