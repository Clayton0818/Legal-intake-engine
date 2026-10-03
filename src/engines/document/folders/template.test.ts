import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOLDER_TEMPLATE,
  REQUIRED_FOLDER_KEYS,
  folderNameProblems,
  missingFolders,
  normalizeFolderName,
  pickTemplate,
  planFolders,
  validateFolderTemplate,
  type FolderTemplateNode,
} from "./template";

const minimal = (): FolderTemplateNode[] => [
  { key: "correspondence", name: "Letters", children: [{ key: "email", name: "Email" }] },
  { key: "client_uploads", name: "Client" },
  { key: "agreements", name: "Signed" },
];

describe("validateFolderTemplate", () => {
  it("accepts the product default", () => {
    const v = validateFolderTemplate(DEFAULT_FOLDER_TEMPLATE);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("accepts a minimal template that keeps the required keys, and trims names", () => {
    const t = minimal();
    t[1]!.name = "  From   the client ";
    const v = validateFolderTemplate(t);
    expect(v.ok).toBe(true);
    expect(v.normalized[1]!.name).toBe("From the client");
  });

  it("requires every key other features depend on", () => {
    const v = validateFolderTemplate([{ key: "misc", name: "Misc" }]);
    expect(v.ok).toBe(false);
    for (const k of REQUIRED_FOLDER_KEYS) expect(v.errors.join("\n")).toContain(`'${k}'`);
  });

  it("rejects duplicate keys, duplicate sibling names (case-insensitive) and bad keys", () => {
    const t: FolderTemplateNode[] = [
      ...minimal(),
      { key: "notes", name: "Notes" },
      { key: "notes", name: "NOTES" },
      { key: "Bad Key", name: "Other" },
    ];
    const v = validateFolderTemplate(t);
    expect(v.ok).toBe(false);
    const all = v.errors.join("\n");
    expect(all).toContain("key 'notes' is used more than once");
    expect(all).toContain("both called");
    expect(all).toContain("key must be lowercase");
  });

  it("allows the same name under different parents", () => {
    const t: FolderTemplateNode[] = [
      ...minimal(),
      { key: "a", name: "Party A", children: [{ key: "a_misc", name: "Misc" }] },
      { key: "b", name: "Party B", children: [{ key: "b_misc", name: "Misc" }] },
    ];
    expect(validateFolderTemplate(t).ok).toBe(true);
  });

  it("limits depth", () => {
    const deep: FolderTemplateNode = {
      key: "l1",
      name: "1",
      children: [{ key: "l2", name: "2", children: [{ key: "l3", name: "3", children: [{ key: "l4", name: "4", children: [{ key: "l5", name: "5" }] }] }] }],
    };
    const v = validateFolderTemplate([...minimal(), deep]);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("at most 4 levels");
  });

  it("rejects unknown privilege tags and non-list input", () => {
    expect(validateFolderTemplate([...minimal(), { key: "x", name: "X", defaultPrivilegeTag: "secret" }]).errors.join()).toContain(
      "unknown privilege tag"
    );
    expect(validateFolderTemplate({ key: "x" }).ok).toBe(false);
    expect(validateFolderTemplate([]).errors.join()).toContain("at least one folder");
  });
});

describe("folder names", () => {
  it("normalises for uniqueness", () => {
    expect(normalizeFolderName("  Court   Filings ")).toBe("court filings");
    expect(normalizeFolderName("ＣＯＵＲＴ")).toBe("court");
  });
  it("rejects slashes, dots and control characters", () => {
    expect(folderNameProblems("a/b")).not.toEqual([]);
    expect(folderNameProblems("..")).not.toEqual([]);
    expect(folderNameProblems("a\u0001")).not.toEqual([]);
    expect(folderNameProblems("x".repeat(121))).not.toEqual([]);
    expect(folderNameProblems("Pleadings")).toEqual([]);
  });
});

describe("planFolders / missingFolders", () => {
  it("orders parents before children, builds paths and inherits privilege tags", () => {
    const plan = planFolders([
      ...minimal(),
      { key: "drafts", name: "Drafts", defaultPrivilegeTag: "work_product", children: [{ key: "old", name: "Old" }] },
    ]);
    const email = plan.find((p) => p.key === "email")!;
    expect(email.parentKey).toBe("correspondence");
    expect(email.path).toBe("Letters / Email");
    expect(email.depth).toBe(2);
    expect(plan.findIndex((p) => p.key === "correspondence")).toBeLessThan(plan.findIndex((p) => p.key === "email"));
    expect(plan.find((p) => p.key === "old")!.defaultPrivilegeTag).toBe("work_product");
    expect(plan.find((p) => p.key === "client_uploads")!.defaultPrivilegeTag).toBe("none");
  });

  it("is idempotent against existing folders", () => {
    const plan = planFolders(minimal());
    expect(missingFolders(plan, [])).toHaveLength(4);
    const existing = [
      { id: "1", templateKey: "correspondence" },
      { id: "2", templateKey: "email" },
      { id: "3", templateKey: null },
    ];
    expect(missingFolders(plan, existing).map((p) => p.key)).toEqual(["client_uploads", "agreements"]);
  });
});

describe("pickTemplate", () => {
  const family = { id: "fam", practiceArea: "family", status: "active", folders: minimal() };
  const firm = { id: "firm", practiceArea: null, status: "active", folders: minimal() };
  const draft = { id: "draft", practiceArea: "immigration", status: "draft", folders: minimal() };

  it("prefers the practice-area template, then firm-wide, then the product default", () => {
    expect(pickTemplate([family, firm], "family")).toMatchObject({ templateId: "fam", source: "practice_area" });
    expect(pickTemplate([family, firm], "personal_injury")).toMatchObject({ templateId: "firm", source: "firm_default" });
    expect(pickTemplate([draft], "immigration")).toMatchObject({ templateId: null, source: "product_default" });
    expect(pickTemplate([], null).folders).toBe(DEFAULT_FOLDER_TEMPLATE);
  });
});
