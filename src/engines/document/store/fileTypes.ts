// File-type sniffing, virus scanning and basic format checks (c84, c49).
// Pure: bytes in, verdicts out.
//
// The built-in scanner is a signature check (EICAR test file, executables,
// scripts, macro-enabled Office files). It is NOT a full anti-virus engine;
// a real scanner plugs in through the VirusScanner interface once the storage
// ADR addendum picks one (vendor.object_storage covers "storage and virus
// scanning"). Anything the scanner cannot vouch for is never shown to a
// person or the AI (c49 rule 11).

import { inflateRawSync, inflateSync } from "node:zlib";

export type SniffedType = "pdf" | "png" | "jpeg" | "heic" | "gif" | "tiff" | "docx" | "zip" | "text" | "executable" | "unknown";

const MIME_TO_TYPE: Record<string, SniffedType> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/gif": "gif",
  "image/tiff": "tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text",
  "message/rfc822": "text",
};

export function typeForMime(mime: string): SniffedType | undefined {
  return MIME_TO_TYPE[mime.toLowerCase().split(";")[0]!.trim()];
}

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((x, i) => b[offset + i] === x);
}

function ascii(b: Uint8Array, start = 0, end = b.byteLength): string {
  return Buffer.from(b.subarray(start, Math.min(end, b.byteLength))).toString("latin1");
}

export function sniffType(b: Uint8Array): SniffedType {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(b, 4, 8) === "ftyp" && /heic|heix|mif1|msf1|hevc/.test(ascii(b, 8, 12))) return "heic";
  if (startsWith(b, [0x4d, 0x5a]) || startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) {
    return "executable";
  }
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    const names = zipEntryNames(b);
    return names.includes("word/document.xml") ? "docx" : "zip";
  }
  if (looksLikeText(b)) return ascii(b, 0, 2) === "#!" ? "executable" : "text";
  return "unknown";
}

function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.byteLength, 4096);
  if (n === 0) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.02;
}

// ---------------------------------------------------------------------------
// Virus scanning
// ---------------------------------------------------------------------------

export interface ScanVerdict {
  status: "clean" | "infected" | "error";
  engine: string;
  detail: string | null;
}

export interface VirusScanner {
  readonly name: string;
  scan(bytes: Uint8Array, declaredMime: string): Promise<ScanVerdict>;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Pure signature scan used by the built-in scanner. */
export function signatureScan(bytes: Uint8Array, declaredMime: string): ScanVerdict {
  const engine = "builtin-signatures";
  const head = ascii(bytes, 0, 1024 * 64);
  if (head.includes(EICAR)) return { status: "infected", engine, detail: "EICAR test signature" };
  const sniffed = sniffType(bytes);
  if (sniffed === "executable") return { status: "infected", engine, detail: "Executable or script content" };
  if (sniffed === "zip" || sniffed === "docx") {
    const names = zipEntryNames(bytes);
    if (names.some((n) => /vbaProject\.bin$/i.test(n))) return { status: "infected", engine, detail: "Macro-enabled Office content" };
    if (names.some((n) => /\.(exe|dll|js|vbs|bat|cmd|ps1|scr|jar)$/i.test(n))) return { status: "infected", engine, detail: "Archive contains executable files" };
  }
  let warning: string | null = null;
  if (sniffed === "pdf") {
    const tail = head + ascii(bytes, Math.max(0, bytes.byteLength - 65536));
    if (/\/Launch\b/.test(tail)) return { status: "infected", engine, detail: "PDF with a launch action" };
    // Fillable court forms often carry form scripts: not quarantined, but noted.
    if (/\/(JavaScript|JS|EmbeddedFile)\b/.test(tail)) warning = "PDF contains scripts or embedded files";
  }
  const expected = typeForMime(declaredMime);
  if (expected && expected !== "text" && sniffed !== expected && !(expected === "docx" && sniffed === "zip")) {
    return { status: "infected", engine, detail: `Content does not match its declared type (${declaredMime})` };
  }
  return { status: "clean", engine, detail: warning };
}

export class BuiltinScanner implements VirusScanner {
  readonly name = "builtin-signatures";
  async scan(bytes: Uint8Array, declaredMime: string): Promise<ScanVerdict> {
    try {
      return signatureScan(bytes, declaredMime);
    } catch (err) {
      return { status: "error", engine: this.name, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

let scanner: VirusScanner = new BuiltinScanner();
export function getVirusScanner(): VirusScanner {
  return scanner;
}
export function setVirusScanner(next: VirusScanner): void {
  scanner = next;
}

// ---------------------------------------------------------------------------
// ZIP (for DOCX): central-directory entry names and one entry's bytes
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function zipEntries(b: Uint8Array): ZipEntry[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.byteLength - 22; i >= Math.max(0, b.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= b.byteLength; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    out.push({ name: ascii(b, p + 46, p + 46 + nameLen), method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipEntryNames(b: Uint8Array): string[] {
  try {
    return zipEntries(b).map((e) => e.name);
  } catch {
    return [];
  }
}

function zipEntryBytes(b: Uint8Array, name: string): Uint8Array | null {
  const e = zipEntries(b).find((x) => x.name === name);
  if (!e) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint32(e.localOffset, true) !== 0x04034b50) return null;
  const start = e.localOffset + 30 + view.getUint16(e.localOffset + 26, true) + view.getUint16(e.localOffset + 28, true);
  const data = b.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method === 8) return new Uint8Array(inflateRawSync(data));
  return null;
}

// ---------------------------------------------------------------------------
// Text extraction (searchable text without OCR)
// ---------------------------------------------------------------------------

export type ExtractResult =
  | { status: "extracted"; method: "text" | "pdf_text"; content: string }
  | { status: "ocr_needed"; reason: string }
  | { status: "none"; reason: string };

const MAX_TEXT = 2_000_000;

function tidy(s: string): string {
  return s.replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, MAX_TEXT);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

export function extractDocxText(b: Uint8Array): string | null {
  const xml = zipEntryBytes(b, "word/document.xml");
  if (!xml) return null;
  const s = Buffer.from(xml).toString("utf8");
  const text = s
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeXmlEntities(text));
}

function unescapePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => {
    const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    return map[e] ?? String.fromCharCode(parseInt(e, 8));
  });
}

function textFromContentStream(s: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ|(T\*|Td|TD|ET)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[2]) {
      out.push("\n");
      continue;
    }
    const chunk = m[1] !== undefined ? m[1] : m[0];
    const strings = chunk.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
    out.push(strings.map((x) => unescapePdfString(x.slice(1, -1))).join(""));
  }
  return out.join("");
}

/** Embedded text of a digital PDF (uncompressed or FlateDecode content streams). Empty for scans. */
export function extractPdfText(b: Uint8Array): string {
  const raw = ascii(b);
  const parts: string[] = [];
  const re = /<<([^]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const dict = m[1] ?? "";
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    const bytes = b.subarray(start, end);
    let content: string | null = null;
    if (/\/FlateDecode/.test(dict)) {
      try {
        content = Buffer.from(inflateSync(bytes)).toString("latin1");
      } catch {
        content = null;
      }
    } else if (!/\/Filter/.test(dict)) {
      content = Buffer.from(bytes).toString("latin1");
    }
    if (content) parts.push(textFromContentStream(content));
    re.lastIndex = end;
  }
  return tidy(parts.join("\n"));
}

export function pdfPageCount(b: Uint8Array): number {
  return (ascii(b).match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

export function pdfIsEncrypted(b: Uint8Array): boolean {
  return /\/Encrypt\b/.test(ascii(b));
}

/** Searchable text for a file, or a note that it needs text recognition (OCR). */
export function extractText(b: Uint8Array, mime: string): ExtractResult {
  const t = sniffType(b);
  if (t === "text") return { status: "extracted", method: "text", content: tidy(Buffer.from(b).toString("utf8")) };
  if (t === "docx") {
    const s = extractDocxText(b);
    return s ? { status: "extracted", method: "text", content: s } : { status: "none", reason: "Word file has no readable body" };
  }
  if (t === "pdf") {
    if (pdfIsEncrypted(b)) return { status: "none", reason: "PDF is password-protected" };
    const s = extractPdfText(b);
    if (s.replace(/\s/g, "").length >= 20) return { status: "extracted", method: "pdf_text", content: s };
    return { status: "ocr_needed", reason: "PDF has no embedded text (scanned)" };
  }
  if (t === "png" || t === "jpeg" || t === "heic" || t === "tiff" || t === "gif") return { status: "ocr_needed", reason: "Image" };
  return { status: "none", reason: `No text extraction for ${mime}` };
}
