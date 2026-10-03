// Text extraction for search (c84). Pure: bytes in, text out, no I/O.
//
// Native extraction covers what we can read without a vendor: plain text,
// CSV/Markdown, HTML, RTF, email (.eml), the text layer of PDFs (best effort:
// Flate-compressed or raw content streams, literal and simple hex strings),
// Word (.docx) and Excel (.xlsx). Scanned PDFs and photos have no text layer:
// they come back as `needs_ocr` and wait for the OCR adapter, which is a
// vendor call gated on vendor.object_storage (see ../storage/adapters.ts).
// Nothing here interprets a document's legal meaning.

import { inflateRawSync, inflateSync } from "node:zlib";

export type ExtractionResult =
  | { status: "extracted"; method: "native"; text: string; pageCount: number | null }
  | { status: "needs_ocr"; pageCount: number | null; detail: string }
  | { status: "unsupported"; detail: string }
  | { status: "failed"; detail: string };

/** Cap on decompressed bytes from any one stream / zip entry (zip-bomb guard). */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

const OCR_TYPES = new Set(["image/jpeg", "image/png", "image/tiff", "image/heic", "image/gif"]);

export function extractText(bytes: Uint8Array, mimeType: string): ExtractionResult {
  try {
    switch (mimeType) {
      case "text/plain":
      case "text/csv":
      case "text/markdown":
        return native(decodeUtf8(bytes));
      case "text/html":
        return native(htmlToText(decodeUtf8(bytes)));
      case "application/rtf":
        return native(rtfToText(Buffer.from(bytes).toString("latin1")));
      case "message/rfc822":
        return native(emailToText(decodeUtf8(bytes)));
      case "application/pdf":
        return extractPdf(bytes);
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return native(docxToText(bytes));
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        return native(xlsxToText(bytes));
      default:
        if (OCR_TYPES.has(mimeType)) return { status: "needs_ocr", pageCount: 1, detail: "Image: text recognition needed." };
        return { status: "unsupported", detail: `No text extractor for ${mimeType}.` };
    }
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

function native(text: string, pageCount: number | null = null): ExtractionResult {
  return { status: "extracted", method: "native", text, pageCount };
}

function decodeUtf8(bytes: Uint8Array): string {
  let s = new TextDecoder("utf-8").decode(bytes);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

/**
 * Normalise extracted text for storage and indexing: drop NULs (Postgres text
 * cannot hold them) and other control characters, collapse runs of spaces and
 * blank lines, then cut to `maxChars` at a word boundary. Pure.
 */
export function finalizeText(text: string, maxChars: number): { text: string; truncated: boolean } {
  let t = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.length <= maxChars) return { text: t, truncated: false };
  t = t.slice(0, maxChars);
  const lastSpace = t.search(/\s\S*$/);
  if (lastSpace > maxChars * 0.5) t = t.slice(0, lastSpace);
  return { text: t.trimEnd(), truncated: true };
}

// ---------------------------------------------------------------------------
// Markup formats
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head|template)[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article|blockquote)\s*>/gi, "\n")
      .replace(/<(td|th)[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, "")
  );
}

export function rtfToText(rtf: string): string {
  let s = rtf
    .replace(/\{\\\*[^{}]*\}/g, "") // ignorable destinations (simple ones)
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\s*\}/g, "")
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n: string) => String.fromCharCode(((Number(n) % 65536) + 65536) % 65536))
    .replace(/\\(par|line|row)\b ?/g, "\n")
    .replace(/\\tab\b ?/g, "\t")
    .replace(/\\([{}\\])/g, "$1");
  s = s.replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, "");
  return s;
}

/** Headers worth indexing plus the readable text parts of an email. */
export function emailToText(raw: string): string {
  const [head, ...rest] = raw.replace(/\r\n/g, "\n").split(/\n\n/);
  const body = rest.join("\n\n");
  const headers = unfoldHeaders(head ?? "");
  const keep = ["subject", "from", "to", "cc", "date"]
    .map((h) => (headers[h] ? `${h[0]!.toUpperCase()}${h.slice(1)}: ${headers[h]}` : null))
    .filter(Boolean)
    .join("\n");
  return `${keep}\n\n${mimeBodyText(headers, body, 0)}`;
}

function unfoldHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function mimeBodyText(headers: Record<string, string>, body: string, depth: number): string {
  const ctype = (headers["content-type"] ?? "text/plain").toLowerCase();
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
  if (ctype.startsWith("multipart/") && boundary && depth < 5) {
    const parts = body.split(`--${boundary}`).slice(1);
    const texts: string[] = [];
    let sawPlain = false;
    for (const part of parts) {
      if (part.startsWith("--")) break;
      const [ph, ...pb] = part.replace(/^\n/, "").split(/\n\n/);
      const pheaders = unfoldHeaders(ph ?? "");
      const pt = (pheaders["content-type"] ?? "text/plain").toLowerCase();
      if (/attachment/i.test(pheaders["content-disposition"] ?? "")) continue;
      if (pt.startsWith("text/plain")) sawPlain = true;
      if (pt.startsWith("text/html") && sawPlain) continue; // alternative of a plain part
      if (pt.startsWith("text/") || pt.startsWith("multipart/")) texts.push(mimeBodyText(pheaders, pb.join("\n\n"), depth + 1));
    }
    return texts.join("\n\n");
  }
  if (!ctype.startsWith("text/")) return "";
  let decoded = body;
  if (encoding === "base64") decoded = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  else if (encoding === "quoted-printable") decoded = decodeQuotedPrintable(body);
  return ctype.startsWith("text/html") ? htmlToText(decoded) : decoded;
}

export function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "=" && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// ---------------------------------------------------------------------------
// ZIP (for .docx / .xlsx) — central-directory reader, deflate/stored only
// ---------------------------------------------------------------------------

export function readZipEntries(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a readable zip file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Damaged zip directory.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Damaged zip entry.");
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES - total });
    else throw new Error(`Unsupported zip compression method ${method}.`);
    total += content.length;
    out.set(name, content);
  }
  return out;
}

function xmlText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ""));
}

export function docxToText(bytes: Uint8Array): string {
  const entries = readZipEntries(bytes, (n) => /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(n));
  const main = entries.get("word/document.xml");
  if (!main) throw new Error("Word file has no document body.");
  const order = ["word/document.xml", ...[...entries.keys()].filter((k) => k !== "word/document.xml").sort()];
  return order
    .map((name) =>
      xmlText(
        entries
          .get(name)!
          .toString("utf8")
          .replace(/<w:tab\/>/g, "\t")
          .replace(/<w:(br|cr)\/>/g, "\n")
          .replace(/<\/w:p>/g, "\n")
          .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "")
      )
    )
    .join("\n");
}

export function xlsxToText(bytes: Uint8Array): string {
  const entries = readZipEntries(bytes, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const parts: string[] = [];
  const shared = entries.get("xl/sharedStrings.xml");
  if (shared) {
    for (const m of shared.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)) parts.push(xmlText(m[1]!));
  }
  for (const [name, xml] of entries) {
    if (name === "xl/sharedStrings.xml") continue;
    for (const m of xml.toString("utf8").matchAll(/<is>([\s\S]*?)<\/is>/g)) parts.push(xmlText(m[1]!));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// PDF text layer (best effort)
// ---------------------------------------------------------------------------

/** Pages reported by the PDF's page objects. */
export function pdfPageCount(latin: string): number | null {
  const n = (latin.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  return n > 0 ? n : null;
}

/** Decode a PDF literal string body (without the outer parentheses). */
export function decodePdfLiteral(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "b" || n === "f") out += " ";
    else if (n === "\n" || n === "\r") {
      if (n === "\r" && s[i + 1] === "\n") i++;
    } else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else out += n;
  }
  return out;
}

function decodePdfHex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  const padded = clean.length % 2 ? clean + "0" : clean;
  const bytes = Buffer.from(padded, "hex");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString("utf16le");
  // Two-byte codes with a zero high byte are common for simple CID fonts.
  if (bytes.length % 2 === 0 && bytes.length > 0 && bytes.every((b, i) => i % 2 === 1 || b === 0)) {
    return Buffer.from(bytes.filter((_b, i) => i % 2 === 1)).toString("latin1");
  }
  return bytes.toString("latin1");
}

/** Pull text out of one page content stream. */
export function textFromContentStream(content: string): string {
  let out = "";
  // Tokens: literal strings (balanced parens), hex strings, arrays, operators, numbers.
  const re = /\((?:\\[\s\S]|[^\\()]|\((?:\\[\s\S]|[^\\()])*\))*\)|<[0-9A-Fa-f\s]*>|\[|\]|[A-Za-z'"*]+|-?\d*\.?\d+/g;
  let pending: string[] = [];
  let inArray = false;
  let lastNumber = 0;
  for (const m of content.matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith("(")) pending.push(decodePdfLiteral(tok.slice(1, -1)));
    else if (tok.startsWith("<")) pending.push(decodePdfHex(tok.slice(1, -1)));
    else if (tok === "[") {
      inArray = true;
      pending = [];
    } else if (tok === "]") inArray = false;
    else if (/^-?\d*\.?\d+$/.test(tok)) {
      lastNumber = Number(tok);
      if (inArray && lastNumber < -200 && pending.length) pending.push(" ");
    } else {
      switch (tok) {
        case "Tj":
        case "TJ":
          out += pending.join("");
          break;
        case "'":
        case '"':
          out += "\n" + pending.join("");
          break;
        case "T*":
          out += "\n";
          break;
        case "Td":
        case "TD":
          if (lastNumber !== 0) out += "\n";
          else out += " ";
          break;
        case "ET":
          out += "\n";
          break;
      }
      if (!inArray) pending = [];
    }
  }
  return out;
}

export function extractPdf(bytes: Uint8Array): ExtractionResult {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin = buf.toString("latin1");
  const pageCount = pdfPageCount(latin);
  if (/\/Encrypt\s/.test(latin)) return { status: "unsupported", detail: "Encrypted PDF: text cannot be read without the password." };

  const texts: string[] = [];
  let inflated = 0;
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    const dictStart = latin.lastIndexOf("obj", m.index);
    const dict = latin.slice(Math.max(dictStart, m.index - 2048), m.index);
    streamRe.lastIndex = end + 9;
    if (/\/Subtype\s*\/Image|\/Type\s*\/(XRef|ObjStm|Metadata|XObject)|\/Length1|\/FontFile/.test(dict)) continue;
    let raw = buf.subarray(start, end);
    if (/\/Filter\s*\[?\s*\/FlateDecode/.test(dict)) {
      try {
        raw = inflateSync(raw, { maxOutputLength: Math.max(1, MAX_INFLATED_BYTES - inflated) });
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue; // other filters (DCT, LZW …) are images or exotic
    inflated += raw.length;
    const content = raw.toString("latin1");
    if (!/\bBT\b/.test(content)) continue;
    texts.push(textFromContentStream(content));
  }
  const text = texts.join("\n");
  const letters = (text.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  if (letters < Math.max(20, (pageCount ?? 1) * 10)) {
    return { status: "needs_ocr", pageCount, detail: "PDF has little or no text layer (likely scanned)." };
  }
  return native(text, pageCount);
}
