// c92 — rule-set validation, the licensed-provider adapter, and one EXAMPLE
// rule set that shows the mechanism.
//
// Rule sets are legal rules. They are firm config, versioned, and usable only
// when (1) the product-level gate 'rules.court_deadlines' is approved and (2)
// a lawyer of the firm approved that exact version. Approved versions are
// never edited — a change is a new version.

import { isValidTimeZone } from "@/core";
import type { CourtWeekday, DeadlineRuleSetConfig, DeadlineRuleStep } from "@/db/tables/calendar-core";
import { isHHMM, parseDate } from "../dates";

export type { DeadlineRuleSetConfig };

const WEEKDAYS: readonly CourtWeekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const UNITS = ["calendar_days", "court_days", "weeks", "months", "years"];
const KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;

function validStep(s: DeadlineRuleStep): string | null {
  if (!s || typeof s !== "object") return "a step must be an object";
  switch (s.op) {
    case "add":
    case "subtract":
      if (!Number.isInteger(s.amount) || s.amount < 0 || s.amount > 3650) return "amount must be a whole number 0–3650";
      if (!UNITS.includes(s.unit)) return `unit must be one of ${UNITS.join(", ")}`;
      return null;
    case "next_weekday":
      return WEEKDAYS.includes(s.weekday) ? null : "weekday is not valid";
    case "roll":
      return s.direction === "forward" || s.direction === "backward" ? null : "direction must be forward or backward";
    case "add_for_service_method":
      if (!s.days || typeof s.days !== "object") return "days must map service methods to day counts";
      return Object.values(s.days).every((d) => Number.isInteger(d) && d >= 0 && d <= 60) ? null : "extra days must be 0–60";
    default:
      return `unknown step '${(s as { op?: string }).op}'`;
  }
}

/** Validate a rule-set config. Pure. */
export function validateRuleSetConfig(c: DeadlineRuleSetConfig): string[] {
  const errors: string[] = [];
  if (!c || typeof c !== "object") return ["The rule set must be an object."];
  if (!isValidTimeZone(c.timeZone ?? "")) errors.push(`Unknown time zone '${c.timeZone}'.`);
  if (!Array.isArray(c.nonCourtWeekdays) || !c.nonCourtWeekdays.every((d) => WEEKDAYS.includes(d))) errors.push("nonCourtWeekdays must list weekdays.");
  else if (c.nonCourtWeekdays.length >= 7) errors.push("The court must sit on at least one weekday.");
  if (!Array.isArray(c.courtHolidays)) errors.push("courtHolidays must be a list of dates.");
  else
    for (const h of c.courtHolidays) {
      try {
        parseDate(h);
      } catch {
        errors.push(`Court holiday '${h}' is not a date.`);
      }
    }
  if (c.lateServiceCutoff) {
    const l = c.lateServiceCutoff;
    if (!isHHMM(l.localTime)) errors.push("lateServiceCutoff.localTime must be 'HH:MM'.");
    if (!Array.isArray(l.methods) || l.methods.length === 0) errors.push("lateServiceCutoff.methods must list service methods.");
    if (!Number.isInteger(l.shiftDays) || l.shiftDays < 0 || l.shiftDays > 10) errors.push("lateServiceCutoff.shiftDays must be 0–10.");
  }
  const triggerKeys = new Set<string>();
  if (!Array.isArray(c.triggers) || c.triggers.length === 0) errors.push("At least one trigger is required.");
  else
    for (const t of c.triggers) {
      if (!KEY.test(t.key ?? "")) errors.push(`Trigger key '${t.key}' is not valid.`);
      if (triggerKeys.has(t.key)) errors.push(`Duplicate trigger '${t.key}'.`);
      triggerKeys.add(t.key);
      if (!t.label?.trim()) errors.push(`Trigger '${t.key}' needs a label.`);
    }
  const ruleKeys = new Set<string>();
  if (!Array.isArray(c.rules) || c.rules.length === 0) errors.push("At least one rule is required.");
  else
    for (const r of c.rules) {
      const at = `Rule '${r.key}'`;
      if (!KEY.test(r.key ?? "")) errors.push(`Rule key '${r.key}' is not valid.`);
      if (ruleKeys.has(r.key)) errors.push(`Duplicate rule '${r.key}'.`);
      ruleKeys.add(r.key);
      if (!r.label?.trim()) errors.push(`${at}: label required.`);
      if (!triggerKeys.has(r.trigger)) errors.push(`${at}: unknown trigger '${r.trigger}'.`);
      if (!/^[a-z][a-z_]{1,39}$/.test(r.eventType ?? "")) errors.push(`${at}: event type is not valid.`);
      if (r.dueTime !== null && !isHHMM(r.dueTime)) errors.push(`${at}: dueTime must be 'HH:MM' or null.`);
      if (!r.citation?.trim()) errors.push(`${at}: a citation is required so the confirming lawyer can check it.`);
      if (!Array.isArray(r.steps) || r.steps.length === 0 || r.steps.length > 20) errors.push(`${at}: 1–20 steps.`);
      else
        r.steps.forEach((s, i) => {
          const e = validStep(s);
          if (e) errors.push(`${at}, step ${i + 1}: ${e}.`);
        });
    }
  return errors;
}

/**
 * EXAMPLE ONLY — shows how a rule set is expressed. NOT VERIFIED, NOT LEGAL
 * ADVICE, never active by default. The citations name the Texas rules a
 * reviewing attorney would check (TRCP 99(b) answer day, TRCP 4 computation,
 * TRCP 21a service timing and mail days); the values must be verified against
 * the current rules and any local rules before a lawyer approves a version.
 */
export const EXAMPLE_RULE_SET: { key: string; name: string; jurisdiction: string; court: string | null; config: DeadlineRuleSetConfig } = {
  key: "example-tx-civil",
  name: "EXAMPLE — Texas civil (UNVERIFIED, for attorney review)",
  jurisdiction: "TX",
  court: null,
  config: {
    timeZone: "America/Chicago",
    nonCourtWeekdays: ["sat", "sun"],
    courtHolidays: [],
    lateServiceCutoff: { localTime: "17:00", methods: ["e_service"], shiftDays: 1 },
    triggers: [
      { key: "citation_served", label: "Citation served on our client", serviceMethods: ["personal", "certified_mail", "substituted"] },
      { key: "document_served", label: "Pleading/motion served on us", serviceMethods: ["e_service", "mail", "personal", "fax"] },
    ],
    rules: [
      {
        key: "answer_due",
        label: "Answer due (example)",
        trigger: "citation_served",
        eventType: "response_deadline",
        steps: [
          { op: "add", amount: 20, unit: "calendar_days" },
          { op: "next_weekday", weekday: "mon" },
          { op: "roll", direction: "forward" },
        ],
        dueTime: "10:00",
        citation: "Tex. R. Civ. P. 99(b), 4 — VERIFY before approving",
      },
      {
        key: "response_example",
        label: "Response to served document — example period",
        trigger: "document_served",
        eventType: "response_deadline",
        steps: [
          { op: "add", amount: 14, unit: "calendar_days" },
          { op: "add_for_service_method", days: { mail: 3 } },
          { op: "roll", direction: "forward" },
        ],
        dueTime: null,
        citation: "Placeholder period; Tex. R. Civ. P. 4, 21a — VERIFY the period for the specific filing",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Licensed rules provider (VENDOR ADAPTER) — gated on
// 'rules.calendar-core.licensed_rules_provider'. Imports land as DRAFT
// versions that a firm lawyer must still approve.
// ---------------------------------------------------------------------------

export type ProviderFetch =
  | { outcome: "ok"; name: string; jurisdiction: string; court: string | null; config: DeadlineRuleSetConfig }
  | { outcome: "held" | "failed"; detail: string };

export interface CourtRulesProvider {
  readonly name: string;
  readonly isStub: boolean;
  fetchRuleSet(providerKey: string): Promise<ProviderFetch>;
}

export class StubCourtRulesProvider implements CourtRulesProvider {
  readonly name = "stub";
  readonly isStub = true;
  readonly requests: string[] = [];
  async fetchRuleSet(providerKey: string): Promise<ProviderFetch> {
    this.requests.push(providerKey);
    return { outcome: "held", detail: "Stub court-rules provider: recorded, not fetched." };
  }
}

let rulesProvider: CourtRulesProvider = new StubCourtRulesProvider();
export function getCourtRulesProvider(): CourtRulesProvider {
  return rulesProvider;
}
export function setCourtRulesProvider(p: CourtRulesProvider): void {
  rulesProvider = p;
}
