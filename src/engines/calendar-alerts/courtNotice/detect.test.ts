import { describe, expect, it } from "vitest";
import { CAL, TZ, chicago } from "../testFixtures";
import type { TrustedCourtSender } from "../settings";
import {
  ackDueAt,
  arrivalNote,
  authenticationPasses,
  classifyCourtEmail,
  domainOf,
  escalationStepDue,
  extractDateSuggestions,
  findCauseNumbers,
  mentionsName,
  normalizeCauseNumber,
  normalizedNoticeText,
} from "./detect";
import { gateForSource, getCourtMailSources, setCourtMailSources, StubCourtMailSource } from "./source";

const SENDERS: TrustedCourtSender[] = [
  { domain: "efiletexas.gov", label: "eFileTexas", kind: "efiling" },
  { domain: "txcourts.gov", label: "Texas courts", kind: "court" },
];
const PASS = { spf: "pass", dkim: "pass", dkimDomain: "efiletexas.gov", dmarc: "pass" } as const;
const email = (over: Partial<Parameters<typeof classifyCourtEmail>[0]> = {}) => ({
  fromAddress: "notifications@notices.efiletexas.gov",
  fromDisplayName: "eFileTexas",
  subject: "Notification of Service for Case: 2026-CI-01234",
  auth: { ...PASS },
  ...over,
});

describe("classifyCourtEmail (c64 detection)", () => {
  it("a trusted (sub-)domain with passing authentication is a court notice", () => {
    expect(classifyCourtEmail(email(), SENDERS)).toMatchObject({ classification: "court_verified", trustedSender: SENDERS[0] });
  });

  it("a trusted domain that fails DMARC/DKIM is possible phishing, never a notice", () => {
    const r = classifyCourtEmail(email({ auth: { spf: "fail", dkim: "fail", dkimDomain: null, dmarc: "fail" } }), SENDERS);
    expect(r.classification).toBe("possible_phishing");
    expect(r.reasons[0]).toMatch(/authentication failed/);
    // DKIM signed by someone else's domain is not aligned.
    expect(authenticationPasses({ dmarc: "pass", dkim: "pass", dkimDomain: "mailer.example.com", spf: "fail" }, "efiletexas.gov").ok).toBe(false);
    expect(authenticationPasses({ dmarc: "pass", dkim: "fail", spf: "pass" }, "efiletexas.gov").ok).toBe(true);
    expect(authenticationPasses({}, "efiletexas.gov").ok).toBe(false);
  });

  it("look-alike domains and court-claiming display names are possible phishing", () => {
    expect(classifyCourtEmail(email({ fromAddress: "service@efi1etexas.gov" }), SENDERS).classification).toBe("possible_phishing");
    expect(classifyCourtEmail(email({ fromAddress: "service@efiletexas-notices.com" }), SENDERS).classification).toBe("possible_phishing");
    expect(classifyCourtEmail(email({ fromAddress: "clerk@gmail.com", fromDisplayName: "District Clerk" }), SENDERS).classification).toBe("possible_phishing");
  });

  it("ordinary mail is ignored and never stored", () => {
    expect(classifyCourtEmail(email({ fromAddress: "opposing@lawfirm.com", fromDisplayName: "Jane Roe", subject: "Re: settlement" }), SENDERS).classification).toBe("ignore");
  });

  it("with no trusted senders configured nothing is ever verified", () => {
    expect(classifyCourtEmail(email(), []).classification).not.toBe("court_verified");
  });

  it("parses sender domains defensively", () => {
    expect(domainOf("Clerk <Clerk@TXCourts.gov>")).toBe("txcourts.gov");
  });
});

describe("matching inputs", () => {
  it("finds and normalises cause numbers", () => {
    expect(findCauseNumbers("Cause No. 2026-ci-01234 in the 53rd District Court; Case Number: D-1-FM-26-000123.")).toEqual(["2026-CI-01234", "D-1-FM-26-000123"]);
    expect(normalizeCauseNumber("d-1-fm 26--000123.")).toBe("D-1-FM26-000123");
    expect(findCauseNumbers("Case No. pending")).toEqual([]);
  });

  it("matches full party names only", () => {
    const text = normalizedNoticeText("In the Matter of the Marriage of María López and John Smith", "");
    expect(mentionsName(text, "maria lopez")).toBe(true);
    expect(mentionsName(text, "smith")).toBe(false); // single words are too weak
    expect(mentionsName(text, "john smithers")).toBe(false);
  });
});

describe("extractDateSuggestions (suggestions only — never a calculation)", () => {
  it("proposes explicit dates with nearby labels and keeps the time when stated", () => {
    const s = extractDateSuggestions("A hearing is set for October 14, 2026 at 9:30 a.m. in the 53rd District Court.", TZ);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "explicit_date", label: "hearing" });
    expect(s[0]!.proposedAt!.toISOString()).toBe(chicago(14, 9, 30).toISOString());
  });

  it("keeps relative periods as text with NO date", () => {
    const s = extractDateSuggestions("You must file a written answer within twenty days after service. Trial setting: 11/02/2026.", TZ);
    const rel = s.find((x) => x.kind === "relative_period")!;
    expect(rel.proposedAt).toBeNull();
    expect(rel.label).toBe("deadline");
    expect(s.find((x) => x.kind === "explicit_date")).toMatchObject({ label: "trial" });
  });

  it("ignores impossible dates", () => {
    expect(extractDateSuggestions("Due 02/30/2026", TZ)).toEqual([]);
  });
});

describe("acknowledgement and escalation (real clock)", () => {
  it("2 hours in business hours; first thing next business morning otherwise", () => {
    expect(ackDueAt(chicago(5, 10), CAL, 120, 60).toISOString()).toBe(chicago(5, 12).toISOString());
    // Saturday night → Monday 09:00 opening + 60 minutes.
    expect(ackDueAt(chicago(3, 22), CAL, 120, 60).toISOString()).toBe(chicago(5, 10).toISOString());
  });

  it("escalates to the backup lawyer at the deadline, then to owner/admin one window later; acknowledgement stops it", () => {
    const base = { step: 0, ackDueAt: chicago(5, 12), ackMinutes: 120, acknowledged: false };
    expect(escalationStepDue({ ...base, now: chicago(5, 11) })).toBeNull();
    expect(escalationStepDue({ ...base, now: chicago(5, 12) })).toBe(1);
    expect(escalationStepDue({ ...base, step: 1, now: chicago(5, 13) })).toBeNull();
    expect(escalationStepDue({ ...base, step: 1, now: chicago(5, 14) })).toBe(2);
    expect(escalationStepDue({ ...base, step: 2, now: chicago(9, 9) })).toBeNull();
    expect(escalationStepDue({ ...base, acknowledged: true, now: chicago(9, 9) })).toBeNull();
  });

  it("the arrival note is factual and says nothing was calculated", () => {
    const note = arrivalNote(chicago(2, 18, 15), CAL);
    expect(note).toContain("(outside business hours), after 5:00 p.m. local time");
    expect(note).toContain("none have been calendared or calculated");
  });
});

describe("sources", () => {
  it("default sources are stubs that read nothing; each kind maps to its shared vendor gate", async () => {
    const defaults = getCourtMailSources();
    expect(defaults.every((s) => s.isStub)).toBe(true);
    const stub = new StubCourtMailSource("t", "mailbox");
    expect(await stub.fetchSince({ tenantId: "x", cursor: "c1", now: new Date() })).toEqual({ messages: [], cursor: "c1" });
    expect(gateForSource("mailbox")).toBe("vendor.mailbox_access");
    expect(gateForSource("efiling")).toBe("vendor.efiling");
    expect(() => setCourtMailSources([stub, new StubCourtMailSource("t", "efiling")])).toThrow(/Duplicate/);
    setCourtMailSources([...defaults]);
  });
});
