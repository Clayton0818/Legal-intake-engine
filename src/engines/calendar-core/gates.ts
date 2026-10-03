// Approval gates used by the calendar-core engine (c91–c95).
//
// Shared gates REUSED (never redefined here):
//   rules.court_deadlines     (RULE_GATES.courtDeadlines)    — applying ANY court-rule deadline
//                                                            calculation (c92). On top of it, each
//                                                            firm rule-set version needs a lawyer's
//                                                            approval inside the firm.
//   rules.limitation_periods  (RULE_GATES.limitationPeriods) — SUGGESTING a limitation date from the
//                                                            firm's period table (c93). Entering,
//                                                            verifying and reminding about a date a
//                                                            lawyer typed in is NOT gated: blocking a
//                                                            safety reminder would fail unsafe.
//   vendor.calendar_sync      (VENDOR_GATES.calendarSync)    — Outlook / Google two-way sync (c91).
//
// Engine-specific gate (nothing approved):
//   rules.calendar-core.licensed_rules_provider — importing rule sets from a licensed rules-based
//   calendaring provider (c92). There is no shared vendor gate for such a provider yet; see
//   "Foundation requests" in WAVE2_SUMMARY.md.
//
// This engine shows NO client-facing wording: limitation and deadline alerts
// are internal flags, the AI never tells a client a deadline (c44/c92), and
// stage changes only create a task for the lawyer to send a client update
// through c54. So it defines no copy.calendar-core.* gates.

import { defineGate } from "@/compliance/approvals";
import { RULE_GATES, VENDOR_GATES } from "@/compliance/gates";

export { RULE_GATES, VENDOR_GATES };

export const CALENDAR_CORE_RULE_GATES = {
  licensedRulesProvider: defineGate({
    key: "rules.calendar-core.licensed_rules_provider",
    cardIds: ["c92"],
    reviewers: ["vendor_dpa", "attorney"],
    description:
      "Licensed court-rules calendaring provider (subprocessor DPA; attorney review of how its rule sets are imported and kept current)",
  }),
} as const;

export const CALENDAR_CORE_GATE_KEYS = Object.values(CALENDAR_CORE_RULE_GATES).map((g) => g.key);

/** Every gate this engine depends on (own + shared), for the admin page. */
export const CALENDAR_CORE_DEPENDENT_GATE_KEYS = [
  RULE_GATES.courtDeadlines.key,
  RULE_GATES.limitationPeriods.key,
  VENDOR_GATES.calendarSync.key,
  ...CALENDAR_CORE_GATE_KEYS,
];
