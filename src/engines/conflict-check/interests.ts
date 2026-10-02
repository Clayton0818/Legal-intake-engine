// c97 — lawyers' own business and personal interests. Pure rules.
//
// Which interests MUST be listed is legal-rule logic (Rules 1.06(b)(2) and
// 1.08, pending c55): the instructions come from the attorney-reviewed copy
// gate `copy.conflict-check.interest_form_instructions`. Matching a list is
// always safe to run because every hit only goes to the conflicts attorney.

export const INTEREST_TYPES = ["business", "family", "other"] as const;
export type InterestType = (typeof INTEREST_TYPES)[number];

export const IDENTIFIER_KEYS = ["registration", "city", "state"] as const;

export interface DisclosureInput {
  interestType: string;
  name: string;
  relationship: string;
  identifiers?: Record<string, string>;
  startsOn?: string | null;
  endsOn?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// `%` is not a word character, so it is matched on its own rather than inside \b…\b.
const AMOUNT = /[$€£]\s*\d|\b\d{1,3}(,\d{3})+\b|\d\s*%|\b(percent|shares?|amount|worth|value)\b/i;

/** Validation errors (empty = valid). Nothing about the size of an investment is asked or accepted (c97 §4.1.3). */
export function validateDisclosure(input: DisclosureInput): string[] {
  const errors: string[] = [];
  if (!(INTEREST_TYPES as readonly string[]).includes(input.interestType)) errors.push("Choose business, family or other.");
  if (!input.name.trim()) errors.push("Enter the name of the business or person.");
  if (input.name.length > 120) errors.push("The name is too long.");
  if (!input.relationship.trim()) errors.push("Enter the relationship (e.g. owner, director, spouse, investor).");
  if (input.relationship.length > 60) errors.push("Keep the relationship short.");
  for (const text of [input.name, input.relationship, ...Object.values(input.identifiers ?? {})]) {
    if (AMOUNT.test(text)) {
      errors.push("Do not enter amounts, values or percentages.");
      break;
    }
  }
  for (const key of Object.keys(input.identifiers ?? {})) {
    if (!(IDENTIFIER_KEYS as readonly string[]).includes(key)) errors.push(`Unknown identifier '${key}'.`);
  }
  for (const d of [input.startsOn, input.endsOn]) if (d && !DATE.test(d)) errors.push("Dates must be YYYY-MM-DD.");
  if (input.startsOn && input.endsOn && input.startsOn > input.endsOn) errors.push("The end date is before the start date.");
  return errors;
}

/** Next re-confirmation due date: `months` calendar months after `from` (c97 rule 5). Pure. */
export function reconfirmDueAt(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Who must keep a list (c97 rule 6, default all lawyers; staff optional). Pure. */
export function mustKeepList(userRole: string, staffIncluded = false): boolean {
  return userRole === "attorney" || (staffIncluded && (userRole === "intake_staff" || userRole === "firm_admin"));
}
