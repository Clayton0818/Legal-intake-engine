import { describe, expect, it } from "vitest";
import { highlightWords, normalizeToken, parseSearchQuery, tokenize } from "./query";
import { HL_START, HL_STOP, buildSnippet, matchesQuery, parseHeadline, rerank, stem } from "./rank";
import { InMemorySearchBackend, searchDocuments, type BackendRequest, type IndexedRecord, type SearchBackend } from "./search";
import type { AccessContext, StaffViewer } from "../access/policy";

describe("parseSearchQuery", () => {
  it("splits words, phrases, exclusions, OR groups and filters", () => {
    const q = parseSearchQuery('custody "temporary orders" -draft mediation OR hearing type:pleading tag:privileged folder:email');
    expect(q.terms).toEqual(["custody"]);
    expect(q.phrases).toEqual([["temporary", "orders"]]);
    expect(q.excluded).toEqual(["draft"]);
    expect(q.anyOf).toEqual([["mediation", "hearing"]]);
    expect(q.filters).toEqual({ documentType: "pleading", privilegeTag: "privileged", folderKey: "email" });
    expect(q.websearch).toBe('custody "temporary orders" mediation or hearing -draft');
    expect(q.empty).toBe(false);
  });
  it("keeps cause numbers and strips accents", () => {
    expect(tokenize("Cause No. 2024-CI-01234, José's")).toEqual(["cause", "no", "2024-ci-01234", "jose's"]);
    expect(normalizeToken("«Décret»")).toBe("decret");
  });
  it("chains OR and treats a one-word phrase as a word", () => {
    expect(parseSearchQuery("a OR b OR c").anyOf).toEqual([["a", "b", "c"]]);
    expect(parseSearchQuery('"decree"').terms).toEqual(["decree"]);
  });
  it("warns on unknown tags, caps long input and is safe on junk", () => {
    expect(parseSearchQuery("tag:secret x").warnings[0]).toContain("Unknown tag");
    expect(parseSearchQuery("x ".repeat(400)).warnings.join()).toContain("cut");
    const junk = parseSearchQuery(`':&|!()<>* -- OR ""`);
    expect(junk.empty).toBe(true);
    expect(junk.websearch).toBe("");
  });
  it("collects highlight words", () => {
    expect(highlightWords(parseSearchQuery('a "b c" d OR e -f'))).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("snippets", () => {
  it("parses ts_headline markers into ranges and collapses whitespace", () => {
    const s = parseHeadline(`  The ${HL_START}custody${HL_STOP}   order\n of ${HL_START}temporary${HL_STOP} `);
    expect(s.text).toBe("The custody order of temporary");
    expect(s.highlights.map(([a, b]) => s.text.slice(a, b))).toEqual(["custody", "temporary"]);
  });
  it("tolerates unbalanced markers", () => {
    const s = parseHeadline(`x ${HL_STOP}y ${HL_START}z`);
    expect(s.text).toBe("x y z");
    expect(s.highlights.map(([a, b]) => s.text.slice(a, b))).toEqual(["z"]);
  });
  it("builds a window around the densest cluster with highlights", () => {
    const filler = "lorem ipsum ".repeat(50);
    const content = `${filler} the respondent filed a motion for custody modification ${filler} custody`;
    const s = buildSnippet(content, parseSearchQuery("custody motion"), 80);
    expect(s.text.startsWith("… ")).toBe(true);
    expect(s.text.endsWith(" …")).toBe(true);
    const marked = s.highlights.map(([a, b]) => s.text.slice(a, b));
    expect(marked).toContain("motion");
    expect(marked).toContain("custody");
    expect(s.text.length).toBeLessThanOrEqual(80 + 4);
  });
  it("starts at the top when nothing matches, and handles empty text", () => {
    expect(buildSnippet("Short text.", parseSearchQuery("zzz"), 50)).toEqual({ text: "Short text.", highlights: [] });
    expect(buildSnippet("", parseSearchQuery("x"), 50).text).toBe("");
  });
});

describe("matching and ranking", () => {
  it("stems simple English endings", () => {
    expect(stem("filings")).toBe("fil");
    expect(stem("filed")).toBe(stem("filing"));
    expect(stem("parties")).toBe("party");
    expect(stem("is")).toBe("is");
  });
  it("matches terms, phrases, OR groups and exclusions", () => {
    const text = "Temporary orders were filed in the custody case.";
    expect(matchesQuery(text, parseSearchQuery('"temporary orders" custody'))).toBe(true);
    expect(matchesQuery(text, parseSearchQuery('"orders temporary"'))).toBe(false);
    expect(matchesQuery(text, parseSearchQuery("custody -filed"))).toBe(false);
    expect(matchesQuery(text, parseSearchQuery("divorce OR custody"))).toBe(true);
    expect(matchesQuery(text, parseSearchQuery("divorce OR adoption"))).toBe(false);
  });
  it("reranks by relevance, title match, current version and recency", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const q = parseSearchQuery("decree");
    const hits = [
      { id: "old-body", title: "Notes", rank: 1, isCurrentVersion: true, createdAt: new Date("2020-01-01") },
      { id: "title", title: "Final Decree", rank: 0.6, isCurrentVersion: true, createdAt: new Date("2026-09-01") },
      { id: "superseded", title: "Final Decree", rank: 0.6, isCurrentVersion: false, createdAt: new Date("2026-09-01") },
    ];
    const order = rerank(hits, q, now).map((h) => h.id);
    expect(order).toEqual(["title", "old-body", "superseded"]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over the in-memory backend
// ---------------------------------------------------------------------------

const T = "tenant-1";
const lawyer: StaffViewer = { kind: "staff", userId: "u1", role: "attorney", permissions: ["documents.read", "documents.write"] };
const staff: StaffViewer = { kind: "staff", userId: "u2", role: "intake_staff", permissions: ["documents.read"] };
const access = (over: Partial<AccessContext> = {}): AccessContext => ({
  screenedMatterIds: new Set(),
  allowedMatterIds: null,
  restrictedTags: { sealed: ["attorney", "firm_admin"] },
  staffMayDownloadUnscanned: true,
  ...over,
});

function rec(over: Partial<IndexedRecord> & Pick<IndexedRecord, "documentId" | "matterId" | "title" | "content">): IndexedRecord {
  return {
    tenantId: T,
    groupId: over.documentId,
    documentType: "general",
    privilegeTag: "none",
    clientVisible: false,
    version: 1,
    isCurrentVersion: true,
    folderId: null,
    createdAt: new Date("2026-09-01"),
    ...over,
  };
}

function backend() {
  return new InMemorySearchBackend([
    rec({ documentId: "d1", matterId: "mA", title: "Final Decree", content: "The court grants the divorce and custody orders." }),
    rec({ documentId: "d2", matterId: "mB", title: "Custody evaluation", content: "Custody evaluation for the screened matter." }),
    rec({ documentId: "d3", matterId: "mA", title: "Sealed report", content: "Custody report of the child.", privilegeTag: "sealed" }),
    rec({ documentId: "d4", matterId: "mA", title: "Decree draft v1", content: "custody draft", isCurrentVersion: false, version: 1, groupId: "g4" }),
    rec({ documentId: "d5", matterId: "mA", title: "Other firm", content: "custody", tenantId: "tenant-2" }),
    rec({ documentId: "d6", matterId: "mA", title: "Email", content: "custody hearing email", folderKey: "email", documentType: "email" }),
  ]);
}

const run = (b: SearchBackend, over: Partial<Parameters<typeof searchDocuments>[1]> = {}) =>
  searchDocuments(b, { tenantId: T, viewer: lawyer, access: access(), text: "custody", pageSize: 25, snippetChars: 120, ...over });

describe("searchDocuments", () => {
  it("searches the whole firm but never another tenant or old versions by default", async () => {
    const out = await run(backend());
    expect(out.results.map((r) => r.documentId).sort()).toEqual(["d1", "d2", "d3", "d6"]);
    const all = await run(backend(), { allVersions: true });
    expect(all.results.map((r) => r.documentId)).toContain("d4");
  });

  it("drops screened matters from a firm-wide search", async () => {
    const out = await run(backend(), { access: access({ screenedMatterIds: new Set(["mB"]) }) });
    expect(out.results.map((r) => r.documentId)).not.toContain("d2");
  });

  it("returns nothing (and says so) for a matter the viewer is screened from", async () => {
    const out = await run(backend(), { matterId: "mB", access: access({ screenedMatterIds: new Set(["mB"]) }) });
    expect(out).toMatchObject({ results: [], matterDenied: true });
  });

  it("hides restricted tags from roles that may not see them", async () => {
    const out = await run(backend(), { viewer: staff });
    expect(out.results.map((r) => r.documentId)).not.toContain("d3");
  });

  it("re-checks every hit even if a backend ignores the scoping", async () => {
    const leaky: SearchBackend = {
      name: "leaky",
      search: async (req: BackendRequest) => backend().search({ ...req, excludeMatterIds: [], hiddenTags: [] }),
    };
    const out = await run(leaky, { viewer: staff, access: access({ screenedMatterIds: new Set(["mB"]) }) });
    expect(out.results.map((r) => r.documentId).sort()).toEqual(["d1", "d6"]);
    expect(out.droppedByRecheck).toBe(2);
  });

  it("applies filters and matter scope", async () => {
    expect((await run(backend(), { text: "custody folder:email" })).results.map((r) => r.documentId)).toEqual(["d6"]);
    expect((await run(backend(), { text: "type:email custody" })).results.map((r) => r.documentId)).toEqual(["d6"]);
    expect((await run(backend(), { access: access({ allowedMatterIds: new Set(["mB"]) }) })).results.map((r) => r.documentId)).toEqual(["d2"]);
  });

  it("refuses an empty firm-wide search but lists a matter", async () => {
    expect((await run(backend(), { text: "" })).results).toEqual([]);
    expect((await run(backend(), { text: "", matterId: "mA" })).results.length).toBeGreaterThan(0);
  });

  it("refuses viewers without documents.read", async () => {
    const out = await run(backend(), { viewer: { kind: "staff", userId: "x", role: "integration_service", permissions: [] } });
    expect(out.results).toEqual([]);
  });

  it("builds highlighted snippets", async () => {
    const out = await run(backend(), { text: "divorce" });
    const s = out.results[0]!.snippet;
    expect(s.highlights.map(([a, b]) => s.text.slice(a, b))).toEqual(["divorce"]);
  });

  it("pages", async () => {
    const p1 = await run(backend(), { pageSize: 2, page: 1 });
    const p2 = await run(backend(), { pageSize: 2, page: 2 });
    expect(p1.results).toHaveLength(2);
    expect(p2.results).toHaveLength(2);
    expect(new Set([...p1.results, ...p2.results].map((r) => r.documentId)).size).toBe(4);
  });
});
