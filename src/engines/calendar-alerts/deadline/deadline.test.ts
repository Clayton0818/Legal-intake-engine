import { afterEach, describe, expect, it } from "vitest";
import { InMemoryApprovalSource, refreshApprovals, resetApprovalStateForTests, setApprovalSource } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import { ALERT_RULE_GATES } from "../gates";
import { CAL, TZ, chicago } from "../testFixtures";
import { classifyDeadlineQuestion, detectUrgentSafety, extractClientStatedDates } from "./classify";
import { checkHumanUpdate, checkNeutralWording, checkNoDeadlineStatement, checkUpdateDraft } from "./guard";
import { combineTags, parseModelTag, tryAiTag, type DeadlineTagModel } from "./model";

void CAL;

describe("classifyDeadlineQuestion (c44 detection)", () => {
  it("tags clear deadline questions", () => {
    for (const text of [
      "When is my answer due?",
      "when do I have to file the response",
      "What time is the hearing on Monday?",
      "I got served with papers yesterday",
      "how long do I have to respond?",
      "¿Cuándo tengo que ir a la audiencia?",
      "Is there a deadline for the financial disclosure?",
    ]) {
      const t = classifyDeadlineQuestion(text);
      expect(t.deadlineRelated, text).toBe(true);
      expect(t.certainty, text).toBe("clear");
    }
  });

  it("applies the stricter clock when unsure (weak signals only)", () => {
    const t = classifyDeadlineQuestion("The judge said something about my papers");
    expect(t).toMatchObject({ deadlineRelated: true, certainty: "uncertain" });
  });

  it("leaves unrelated messages untagged", () => {
    expect(classifyDeadlineQuestion("Thanks so much, talk soon!")).toEqual({ deadlineRelated: false, certainty: "none", matched: [] });
  });
});

describe("detectUrgentSafety", () => {
  it("flags safety words and ignores ordinary text", () => {
    expect(detectUrgentSafety("He threatened me again last night and I am not safe").urgent).toBe(true);
    expect(detectUrgentSafety("She took my kids and won't answer").urgent).toBe(true);
    expect(detectUrgentSafety("Can we reschedule our call?").urgent).toBe(false);
  });
});

describe("extractClientStatedDates (client-stated, not verified)", () => {
  const friday5pm = chicago(2, 17); // Fri Oct 2 2026

  it("resolves relative days and weekdays in the firm's zone, earliest first", () => {
    const d = extractClientStatedDates("My hearing is Monday, or maybe tomorrow?", friday5pm, TZ);
    expect(d.map((x) => x.localDate)).toEqual(["2026-10-03", "2026-10-05"]);
    expect(d[0]!.at.toISOString()).toBe(new Date(Date.UTC(2026, 9, 3, 5)).toISOString()); // local midnight
  });

  it("reads month names, numeric and ISO dates, inferring the year", () => {
    const d = extractClientStatedDates("Court on Oct 14th, then 11/3 and 2027-01-05. Also Jan 2.", friday5pm, TZ);
    expect(d.map((x) => x.localDate)).toEqual(["2026-10-14", "2026-11-03", "2027-01-02", "2027-01-05"]);
  });

  it("keeps a date from the last week (yesterday's hearing) but drops older ones", () => {
    expect(extractClientStatedDates("what happened at yesterday's hearing", friday5pm, TZ).map((x) => x.localDate)).toEqual(["2026-10-01"]);
    expect(extractClientStatedDates("back on 9/1 we met", friday5pm, TZ).map((x) => x.localDate)).toEqual(["2027-09-01"]);
  });

  it("reads Spanish", () => {
    expect(extractClientStatedDates("La audiencia es el 14 de octubre", friday5pm, TZ).map((x) => x.localDate)).toEqual(["2026-10-14"]);
  });
});

describe("guards", () => {
  it("rejects dates and consequences in a deadline acknowledgement, except the reply-by promise", () => {
    const replyBy = "Wednesday, October 7 at 5:00 PM CDT";
    expect(checkNoDeadlineStatement(`Your lawyer will reply by ${replyBy}.`, [replyBy])).toEqual([]);
    expect(checkNoDeadlineStatement("Your answer is due on Oct 14.")).toEqual(expect.arrayContaining(["month_day", "is_due"]));
    expect(checkNoDeadlineStatement("Otherwise the case may be dismissed")).toContain("dismissal");
  });

  it("neutral reminders need a lawyer's approval for consequence wording", () => {
    expect(checkNeutralWording("Please upload or your case may be dismissed")).toContain("dismissal");
    expect(checkNeutralWording("Please upload or your case may be dismissed", { consequenceApprovedByUserId: "u1" })).toEqual([]);
  });

  it("AI update drafts carry facts only, never predictions or internal data", () => {
    expect(checkUpdateDraft("A hearing has been set for October 14 at the Travis County courthouse.")).toEqual([]);
    expect(checkUpdateDraft("We will likely win; the judge will agree.")).toEqual(expect.arrayContaining(["likelihood", "judge_expectation"]));
    expect(checkHumanUpdate("Note: this task is overdue internally")).toEqual(expect.arrayContaining(["overdue"]));
  });
});

describe("combineTags (AI only adds the stricter clock)", () => {
  const none = { deadlineRelated: false, certainty: "none" as const, matched: [] };
  it("rules clear wins; AI cannot remove a rule tag", () => {
    const t = combineTags({
      rules: { deadlineRelated: true, certainty: "clear", matched: ["hearing"] },
      ai: { deadlineRelated: false, confidence: 0.99, model: "m" },
      aiMinConfidence: 0.7,
      calendarProximity: false,
    });
    expect(t).toMatchObject({ deadlineRelated: true, source: "rules" });
  });
  it("a low-confidence AI 'no' applies the stricter clock", () => {
    const t = combineTags({ rules: none, ai: { deadlineRelated: false, confidence: 0.4, model: "m" }, aiMinConfidence: 0.7, calendarProximity: false });
    expect(t).toMatchObject({ deadlineRelated: true, source: "ai", appliedBecauseUnsure: true });
  });
  it("calendar proximity tags on its own; staff override decides", () => {
    expect(combineTags({ rules: none, ai: null, aiMinConfidence: 0.7, calendarProximity: true }).source).toBe("calendar");
    expect(combineTags({ rules: none, ai: null, aiMinConfidence: 0.7, calendarProximity: true, staff: false }).deadlineRelated).toBe(false);
  });
  it("parses model replies defensively", () => {
    expect(parseModelTag('{"deadline_related": true, "confidence": 0.9}', "m")).toEqual({ deadlineRelated: true, confidence: 0.9, model: "m" });
    expect(parseModelTag("nonsense", "m")).toBeNull();
    expect(parseModelTag({ deadline_related: "yes", confidence: 2 }, "m")).toBeNull();
  });
});

describe("tryAiTag (vendor-gated)", () => {
  afterEach(() => resetApprovalStateForTests());
  const fake: DeadlineTagModel = {
    name: "fake",
    isStub: false,
    tag: async () => ({ deadlineRelated: true, confidence: 0.95, model: "fake-1" }),
  };

  it("never calls the model while the AI vendor gate is pending", async () => {
    let called = false;
    const spy: DeadlineTagModel = { ...fake, tag: async (i) => ((called = true), fake.tag(i)) };
    expect(await tryAiTag("hi", { model: spy })).toEqual({ status: "gate_pending", gateKey: VENDOR_GATES.aiModel.key });
    expect(called).toBe(false);
  });

  it("uses the model once both gates are approved", async () => {
    const src = new InMemoryApprovalSource();
    src.approve({ gateKey: VENDOR_GATES.aiModel.key, reviewerKind: "vendor_dpa", approvedByName: "Ops" });
    src.approve({ gateKey: ALERT_RULE_GATES.deadlineTagPrompt.key, reviewerKind: "attorney", approvedByName: "Atty" });
    setApprovalSource(src);
    await refreshApprovals();
    expect(await tryAiTag("hi", { model: fake })).toEqual({ status: "used", tag: { deadlineRelated: true, confidence: 0.95, model: "fake-1" } });
  });
});
