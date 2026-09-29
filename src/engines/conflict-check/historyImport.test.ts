import { describe, expect, it } from "vitest";
import { GET as template } from "@/app/api/conflict-check/imports/template/route";
import { dedupeRows, mapColumns, mergeMatterStatus, parseCsv, parseImportDate, prepareImport, summarizeImport, validateRow } from "./historyImport";

describe("parseCsv (c96)", () => {
  it("handles quotes, doubled quotes, CRLF, a BOM and blank lines", () => {
    const rows = parseCsv('﻿name,note\r\n"Doe, Jane","said ""hi"""\r\n\r\nBob,"line1\nline2"\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Doe, Jane", 'said "hi"'],
      ["Bob", "line1\nline2"],
    ]);
  });
});

describe("column mapping (c96)", () => {
  it("recognises common export headers and reports unknown ones", () => {
    const m = mapColumns(["Contact Type", "Full Name", "DOB", "Matter Number", "Favourite colour"]);
    expect([...m.byIndex.values()]).toEqual(["record_type", "name", "date_of_birth", "matter_ref"]);
    expect(m.unknownHeaders).toEqual(["Favourite colour"]);
    expect(m.missingRequired).toEqual([]);
  });

  it("accepts an explicit override and flags missing required columns", () => {
    expect(mapColumns(["Who"], { Who: "name" }).missingRequired).toEqual(["record_type"]);
  });
});

describe("row validation (c96)", () => {
  const mapping = mapColumns(["type", "name", "dob", "email", "matter", "status", "maiden_name"]);

  it("builds an import record with variants and a closed-matter status", () => {
    const r = validateRow(["client", "Ann Carter", "4/5/1980", "ANN@x.com", "M-1", "closed", "Ann Miller"], mapping, 2);
    expect(r.errors).toEqual([]);
    expect(r.record).toMatchObject({ role: "client", matterStatus: "former", dateOfBirth: "1980-04-05", email: "ann@x.com" });
    expect(r.record!.variants).toEqual([{ name: "Ann Miller", type: "maiden" }]);
  });

  it("keeps declined consultations as prospective history", () => {
    const r = validateRow(["declined_consultation", "Pat Prospect", "", "", "C-9", "", ""], mapping, 3);
    expect(r.record).toMatchObject({ role: "prospective_client", involvementKind: "consultation", matterStatus: "prospective" });
  });

  it("reports every problem with the line", () => {
    const r = validateRow(["wizard", "", "31/31/1980", "not-an-email", "", "maybe", ""], mapping, 7);
    expect(r.record).toBeNull();
    expect(r.errors.length).toBe(5);
    expect(r.lineNumber).toBe(7);
  });

  it("generates a reference when none is given, with a warning", () => {
    const r = validateRow(["opposing_party", "Acme Insurance Co", "", "", "", "", ""], mapping, 4);
    expect(r.record).toMatchObject({ matterRef: "line-4", matterRefGenerated: true, kind: "organization" });
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("parses dates strictly", () => {
    expect(parseImportDate("2020-02-29")).toBe("2020-02-29");
    expect(parseImportDate("2/30/2020")).toBe("invalid");
    expect(parseImportDate("")).toBeNull();
  });
});

describe("in-file de-duplication (c96)", () => {
  const csv = [
    "type,name,dob,matter",
    "client,Jane Doe,1985-01-01,M-1",
    "client,Jane Doe,1985-01-01,M-1",
    "client,Jane Doe,1985-01-01,M-2",
    "client,Jane Doe,,M-3",
  ].join("\n");

  it("skips exact repeats, folds the same person, and never merges on name alone", () => {
    const { rows, fatal } = prepareImport(csv);
    expect(fatal).toEqual([]);
    expect(rows[1]!.duplicateOfLine).toBe(2);
    expect(rows[2]!.samePersonAsLine).toBe(2);
    expect(rows[3]!.samePersonAsLine).toBeNull();
    const s = summarizeImport(rows);
    expect(s).toMatchObject({ totalRows: 4, validRows: 3, duplicateRows: 1, samePersonRows: 1, matterRefs: 3 });
  });

  it("dedupeRows leaves error rows alone", () => {
    expect(dedupeRows([{ lineNumber: 2, record: null, errors: ["x"], warnings: [], samePersonAsLine: null, duplicateOfLine: null }])[0]!.errors).toEqual(["x"]);
  });

  it("refuses files without the required columns or rows", () => {
    expect(prepareImport("name\nJane").fatal[0]).toContain("record_type");
    expect(prepareImport("type,name\n").fatal.length).toBe(1);
  });

  it("an open matter wins when rows disagree (over-flag)", () => {
    expect(mergeMatterStatus("former", "current")).toBe("current");
    expect(mergeMatterStatus("prospective", "former")).toBe("former");
  });
});

describe("import template (c96)", () => {
  it("is a valid import with no errors", async () => {
    const text = await template().text();
    const { rows, fatal } = prepareImport(text);
    expect(fatal).toEqual([]);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
    expect(rows.map((r) => r.record!.role)).toEqual(["client", "opposing_party", "prospective_client"]);
  });
});
