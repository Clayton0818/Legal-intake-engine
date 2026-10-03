import { describe, expect, it } from "vitest";
import {
  decodePdfLiteral,
  decodeQuotedPrintable,
  emailToText,
  extractText,
  finalizeText,
  htmlToText,
  readZipEntries,
  rtfToText,
  textFromContentStream,
} from "./extract";
import { buildDocx, buildPdf, buildZip } from "./testFiles";

const enc = (s: string) => new TextEncoder().encode(s);

function extracted(r: ReturnType<typeof extractText>): string {
  if (r.status !== "extracted") throw new Error(`expected extracted, got ${r.status}: ${"detail" in r ? r.detail : ""}`);
  return r.text;
}

describe("plain formats", () => {
  it("reads UTF-8 text and drops a BOM", () => {
    expect(extracted(extractText(enc("﻿Custody — José"), "text/plain"))).toBe("Custody — José");
  });
  it("turns HTML into text without scripts or styles", () => {
    const t = htmlToText("<html><head><title>x</title></head><style>p{}</style><p>Hello&nbsp;<b>Court</b></p><script>evil()</script><p>A &amp; B &#8212; &#x41;</p>");
    expect(t).toContain("Hello Court");
    expect(t).toContain("A & B — A");
    expect(t).not.toContain("evil");
    expect(t).not.toContain("p{}");
  });
  it("strips RTF control words", () => {
    const t = rtfToText("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Motion to \\b modify\\b0\\par Caf\\'e9 \\u8212?}");
    expect(t).toContain("Motion to modify");
    expect(t).toContain("Café");
    expect(t).toContain("—");
    expect(t).not.toContain("Arial");
  });
});

describe("email", () => {
  it("keeps key headers and readable parts, skips attachments", () => {
    const raw = [
      "From: Opposing Counsel <oc@example.com>",
      "To: lawyer@firm.example",
      "Subject: Proposed parenting",
      "  plan",
      'Content-Type: multipart/mixed; boundary="XX"',
      "",
      "--XX",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Please find the plan attached =E2=80=94 thanks.",
      "--XX",
      "Content-Type: text/html",
      "",
      "<p>Duplicate html part</p>",
      "--XX",
      "Content-Type: application/pdf",
      "Content-Disposition: attachment; filename=plan.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQK",
      "--XX--",
    ].join("\r\n");
    const t = emailToText(raw);
    expect(t).toContain("Subject: Proposed parenting plan");
    expect(t).toContain("From: Opposing Counsel");
    expect(t).toContain("Please find the plan attached — thanks.");
    expect(t).not.toContain("Duplicate html part");
    expect(t).not.toContain("JVBER");
  });
  it("decodes base64 single-part bodies", () => {
    const raw = `Subject: x\nContent-Transfer-Encoding: base64\n\n${Buffer.from("Hearing moved").toString("base64")}`;
    expect(emailToText(raw)).toContain("Hearing moved");
  });
  it("decodes quoted-printable soft breaks", () => {
    expect(decodeQuotedPrintable("long=\nline =3D ok")).toBe("longline = ok");
  });
});

describe("zip / docx / xlsx", () => {
  it("reads stored and deflated entries", () => {
    for (const store of [true, false]) {
      const z = buildZip({ "a.txt": "alpha", "b/c.xml": "<x>beta</x>" }, { store });
      const entries = readZipEntries(z, () => true);
      expect(entries.get("a.txt")!.toString()).toBe("alpha");
      expect(entries.get("b/c.xml")!.toString()).toBe("<x>beta</x>");
    }
  });
  it("refuses garbage", () => {
    expect(() => readZipEntries(enc("not a zip at all, definitely not"), () => true)).toThrow();
  });
  it("extracts Word paragraphs and entities", () => {
    const t = extracted(
      extractText(buildDocx(["Final Decree of Divorce", "Petitioner &amp; Respondent"]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    );
    expect(t).toContain("Final Decree of Divorce\n");
    expect(t).toContain("Petitioner & Respondent");
  });
  it("extracts Excel shared strings", () => {
    const x = buildZip({
      "xl/sharedStrings.xml": "<sst><si><t>Account</t></si><si><t>Balance</t></si></sst>",
      "xl/worksheets/sheet1.xml": '<worksheet><c t="inlineStr"><is><t>Inline note</t></is></c></worksheet>',
    });
    const t = extracted(extractText(x, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    expect(t).toContain("Account\nBalance");
    expect(t).toContain("Inline note");
  });
  it("reports a Word file with no body as failed, not as empty text", () => {
    expect(extractText(buildZip({ "x.txt": "y" }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document").status).toBe("failed");
  });
});

describe("pdf", () => {
  it("decodes literal-string escapes", () => {
    expect(decodePdfLiteral("a\\(b\\)\\\\c\\101\\n")).toBe("a(b)\\cA\n");
  });
  it("reads Tj / TJ / quote operators and kerning gaps", () => {
    const t = textFromContentStream("BT /F1 12 Tf 72 712 Td (Hello) Tj 0 -14 Td [(Wor) -20 (ld) -400 (again)] TJ (next) ' <00480069> Tj ET");
    expect(t).toContain("Hello\nWorld again");
    expect(t).toContain("\nnext");
    expect(t).toContain("Hi");
  });
  it("extracts a compressed multi-page text PDF and counts pages", () => {
    const pdf = buildPdf([
      ["IN THE DISTRICT COURT OF TRAVIS COUNTY", "Final Decree of Divorce"],
      ["The Court finds that the parties (Petitioner and Respondent) agree."],
    ]);
    const r = extractText(pdf, "application/pdf");
    expect(r.status).toBe("extracted");
    if (r.status === "extracted") {
      expect(r.pageCount).toBe(2);
      expect(r.text).toContain("Final Decree of Divorce");
      expect(r.text).toContain("(Petitioner and Respondent)");
    }
  });
  it("extracts an uncompressed PDF", () => {
    expect(extracted(extractText(buildPdf([["Uncompressed content stream with enough letters"]], { compress: false }), "application/pdf"))).toContain(
      "Uncompressed content"
    );
  });
  it("sends a scanned PDF (no text layer) to OCR", () => {
    const r = extractText(buildPdf([[], []], { textLayer: false }), "application/pdf");
    expect(r).toMatchObject({ status: "needs_ocr", pageCount: 2 });
  });
  it("does not try to read encrypted PDFs", () => {
    expect(extractText(enc("%PDF-1.4\ntrailer << /Encrypt 5 0 R >>"), "application/pdf").status).toBe("unsupported");
  });
});

describe("routing", () => {
  it("sends images to OCR and unknown types to unsupported", () => {
    expect(extractText(new Uint8Array([1]), "image/jpeg").status).toBe("needs_ocr");
    expect(extractText(new Uint8Array([1]), "application/x-foo").status).toBe("unsupported");
  });
});

describe("finalizeText", () => {
  it("removes NULs and control chars, collapses whitespace", () => {
    expect(finalizeText("a\u0000b  \t c\r\n\n\n\n d", 100)).toEqual({ text: "a b c\n\nd", truncated: false });
  });
  it("truncates at a word boundary", () => {
    const r = finalizeText("alpha beta gamma delta epsilon", 20);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20);
    expect(r.text).toBe("alpha beta gamma");
  });
});
