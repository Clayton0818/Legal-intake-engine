// c92 — court-rule deadline arithmetic (pure).
//
// This file is the ENGINE, not the law: every number (how many days, which
// weekday, whether to roll off a weekend, the late e-service cutoff) comes
// from a rule set the firm's lawyer approved, under the product-level gate
// 'rules.court_deadlines'. Every result is a PROPOSAL with a step-by-step
// explanation; a lawyer confirms it before it is calendared, and the AI
// never tells a client a deadline (c44).

import type { Weekday } from "@/core";
import type { DeadlineRuleDef, DeadlineRuleSetConfig, DeadlineRuleStep } from "@/db/tables/calendar-core";
import { addDays, addMonths, addYears, compareDates, endOfLocalDay, instantAt, localMinutes, parseHHMM, todayIn, weekdayOf } from "../dates";

export interface CourtCalendar {
  nonCourtWeekdays: readonly Weekday[];
  holidays: ReadonlySet<string>;
}

export function courtCalendarFor(config: Pick<DeadlineRuleSetConfig, "nonCourtWeekdays" | "courtHolidays">, extraHolidays: readonly string[] = []): CourtCalendar {
  return { nonCourtWeekdays: config.nonCourtWeekdays, holidays: new Set([...config.courtHolidays, ...extraHolidays]) };
}

export function isCourtDay(date: string, cal: CourtCalendar): boolean {
  return !cal.nonCourtWeekdays.includes(weekdayOf(date)) && !cal.holidays.has(date);
}

function describeNonCourtDay(date: string, cal: CourtCalendar): string {
  return cal.holidays.has(date) ? `${date} is a court holiday` : `${date} is a ${weekdayOf(date)}`;
}

const MAX_WALK = 3660;

/** Move `n` court days forward (n > 0) or backward (n < 0), not counting the start day. */
export function addCourtDays(date: string, n: number, cal: CourtCalendar): string {
  let d = date;
  let left = Math.abs(n);
  const step = n >= 0 ? 1 : -1;
  for (let i = 0; left > 0; i++) {
    if (i > MAX_WALK) throw new Error("No court days found — check the court holidays.");
    d = addDays(d, step);
    if (isCourtDay(d, cal)) left--;
  }
  return d;
}

/** `date` if it is a court day, else the next (or previous) one. */
export function rollToCourtDay(date: string, direction: "forward" | "backward", cal: CourtCalendar): string {
  let d = date;
  for (let i = 0; !isCourtDay(d, cal); i++) {
    if (i > MAX_WALK) throw new Error("No court days found — check the court holidays.");
    d = addDays(d, direction === "forward" ? 1 : -1);
  }
  return d;
}

export interface TriggerInput {
  key: string;
  /** When the trigger happened (e.g. the e-service transmission time). */
  at: Date;
  /** e.g. 'e_service', 'mail', 'personal' — as named in the rule set. */
  serviceMethod?: string | null;
}

export interface CalculatedDeadline {
  ruleKey: string;
  label: string;
  eventType: string;
  date: string;
  dueAt: Date;
  allDay: boolean;
  citation: string;
  explanation: string[];
  warnings: string[];
}

export interface CalculationOutput {
  triggerDate: string;
  explanation: string[];
  results: CalculatedDeadline[];
}

function applyStep(date: string, step: DeadlineRuleStep, ctx: { cal: CourtCalendar; method: string | null }): { date: string; note: string } {
  switch (step.op) {
    case "add":
    case "subtract": {
      const sign = step.op === "add" ? 1 : -1;
      const n = sign * step.amount;
      let next: string;
      if (step.unit === "calendar_days") next = addDays(date, n);
      else if (step.unit === "court_days") next = addCourtDays(date, n, ctx.cal);
      else if (step.unit === "weeks") next = addDays(date, n * 7);
      else if (step.unit === "months") next = addMonths(date, n);
      else next = addYears(date, n);
      return { date: next, note: `${step.op === "add" ? "+" : "−"} ${step.amount} ${step.unit.replace("_", " ")} → ${next}` };
    }
    case "next_weekday": {
      let d = addDays(date, 1);
      while (weekdayOf(d) !== step.weekday) d = addDays(d, 1);
      return { date: d, note: `next ${step.weekday} after ${date} → ${d}` };
    }
    case "roll": {
      if (isCourtDay(date, ctx.cal)) return { date, note: `${date} is a court day (no roll)` };
      const d = rollToCourtDay(date, step.direction, ctx.cal);
      return { date: d, note: `${describeNonCourtDay(date, ctx.cal)} → rolled ${step.direction} to ${d}` };
    }
    case "add_for_service_method": {
      const extra = ctx.method ? step.days[ctx.method] ?? 0 : 0;
      if (extra === 0) return { date, note: `no extra days for service by ${ctx.method ?? "unspecified method"}` };
      const d = addDays(date, extra);
      return { date: d, note: `+ ${extra} day(s) for service by ${ctx.method} → ${d}` };
    }
  }
}

/** Run one rule from an (already effective) trigger date. Pure. */
export function applyRule(rule: DeadlineRuleDef, triggerDate: string, cal: CourtCalendar, timeZone: string, method: string | null, today: string): CalculatedDeadline {
  let date = triggerDate;
  const explanation: string[] = [`Start: ${triggerDate}.`];
  for (const step of rule.steps) {
    const r = applyStep(date, step, { cal, method });
    date = r.date;
    explanation.push(r.note);
  }
  const warnings: string[] = [];
  const hasRoll = rule.steps.some((s) => s.op === "roll");
  if (!isCourtDay(date, cal)) {
    warnings.push(`${describeNonCourtDay(date, cal)} and this rule has no roll step — check how the rule treats it.`);
  }
  if (!hasRoll && cal.holidays.size === 0) warnings.push("No court holidays are configured for this rule set.");
  if (compareDates(date, today) < 0) warnings.push("This date has already passed.");
  const dueAt = rule.dueTime ? instantAt(date, rule.dueTime, timeZone) : endOfLocalDay(date, timeZone);
  explanation.push(rule.dueTime ? `Due at ${rule.dueTime} (${timeZone}) on ${date}.` : `Due by the end of ${date} (${timeZone}).`);
  return { ruleKey: rule.key, label: rule.label, eventType: rule.eventType, date, dueAt, allDay: !rule.dueTime, citation: rule.citation, explanation, warnings };
}

/**
 * Effective trigger date: the local date of the trigger, shifted when service
 * by a listed method happened at/after the configured cutoff (e.g. a 5 p.m.
 * e-service rule, if the firm's approved rule set has one). Pure.
 */
export function effectiveTriggerDate(config: DeadlineRuleSetConfig, trigger: TriggerInput): { date: string; notes: string[] } {
  const local = todayIn(config.timeZone, trigger.at);
  const notes = [`Trigger '${trigger.key}' at ${trigger.at.toISOString()} = ${local} local (${config.timeZone}).`];
  const cut = config.lateServiceCutoff;
  if (cut && trigger.serviceMethod && cut.methods.includes(trigger.serviceMethod)) {
    const { hour, minute } = parseHHMM(cut.localTime);
    if (localMinutes(trigger.at, config.timeZone) >= hour * 60 + minute) {
      const shifted = addDays(local, cut.shiftDays);
      notes.push(`Served by ${trigger.serviceMethod} at/after ${cut.localTime} local → treated as ${shifted} under the rule set's late-service rule.`);
      return { date: shifted, notes };
    }
  }
  return { date: local, notes };
}

/** Calculate every rule hanging off the trigger (or only `ruleKeys`). Pure. */
export function calculateDeadlines(
  config: DeadlineRuleSetConfig,
  trigger: TriggerInput,
  opts: { extraHolidays?: readonly string[]; ruleKeys?: readonly string[]; now?: Date } = {}
): CalculationOutput {
  const t = config.triggers.find((x) => x.key === trigger.key);
  if (!t) throw new Error(`Unknown trigger '${trigger.key}'.`);
  if (trigger.serviceMethod && t.serviceMethods && !t.serviceMethods.includes(trigger.serviceMethod)) {
    throw new Error(`Service method '${trigger.serviceMethod}' is not listed for '${t.label}'.`);
  }
  const cal = courtCalendarFor(config, opts.extraHolidays);
  const { date, notes } = effectiveTriggerDate(config, trigger);
  const today = todayIn(config.timeZone, opts.now ?? new Date());
  const rules = config.rules.filter((r) => r.trigger === trigger.key && (!opts.ruleKeys || opts.ruleKeys.includes(r.key)));
  return { triggerDate: date, explanation: notes, results: rules.map((r) => applyRule(r, date, cal, config.timeZone, trigger.serviceMethod ?? null, today)) };
}
