// c62 — neutral non-engagement letters. Pure helpers (no database).
//
// Client-facing LEGAL WORDING — GATED. The letter text comes only from
// `copy.conflict-check.non_engagement_letter` via legalCopyStatus(); until an
// attorney approves it the render is the visible placeholder and the letter
// cannot be approved or sent. The template has no field for a conflict
// reason, other parties or case facts, and assertNeutralLetter() is a second,
// independent guard against anything leaking in.

import { legalCopyStatus } from "@/compliance/approvals";
import { normalizeName, resolveClientAddress, type ContactPoints } from "@/core";
import { CONFLICT_COPY_GATES } from "./gates";
import type { ConflictSettings } from "./settings";

export const DECLINE_TYPES = ["conflict", "not_eligible", "out_of_scope", "firm_choice", "did_not_hire"] as const;
export type DeclineType = (typeof DECLINE_TYPES)[number];

export function isDeclineType(v: unknown): v is DeclineType {
  return typeof v === "string" && (DECLINE_TYPES as readonly string[]).includes(v);
}

/** c62 rule 1: every decline gets a letter; did-not-hire only when the firm keeps that on. */
export function letterRequired(declineType: DeclineType, settings: Pick<ConflictSettings, "letterForDidNotHire">): boolean {
  return declineType !== "did_not_hire" || settings.letterForDidNotHire;
}

/** c62 rule 4: conflict declines ALWAYS need a lawyer to approve the individual letter. */
export function needsIndividualApproval(declineType: DeclineType, settings: Pick<ConflictSettings, "letterAutoSendTypes">): boolean {
  if (declineType === "conflict") return true;
  return !settings.letterAutoSendTypes.includes(declineType);
}

export interface ReferralSource {
  name: string;
  contact: string;
  practiceArea?: string;
}

/** Pick a referral from the firm's configured list (practice-area match first). No commentary, no advice. */
export function chooseReferral(sources: readonly ReferralSource[], practiceArea: string | null | undefined): ReferralSource | null {
  if (sources.length === 0) return null;
  return sources.find((s) => practiceArea && s.practiceArea === practiceArea) ?? sources.find((s) => !s.practiceArea) ?? sources[0]!;
}

export interface LetterVars {
  prospectName: string;
  firmName: string;
  /** Letter date and contact date, already formatted for the firm's locale. */
  date: string;
  contactDate: string;
  referral?: ReferralSource | null;
}

export interface RenderedLetter {
  text: string;
  approved: boolean;
  pendingReviewers: string[];
  referralIncluded: boolean;
}

/** Render the letter from the approved wording (or the visible placeholder). */
export function renderNonEngagementLetter(vars: LetterVars): RenderedLetter {
  let referralBlock = "";
  let referralIncluded = false;
  if (vars.referral) {
    const ref = legalCopyStatus(CONFLICT_COPY_GATES.nonEngagementReferral.key, {
      referralName: vars.referral.name,
      referralContact: vars.referral.contact,
    });
    // An unapproved referral paragraph is simply left out of an otherwise approved letter.
    if (ref.approved) {
      referralBlock = ref.text;
      referralIncluded = true;
    }
  }
  const letter = legalCopyStatus(CONFLICT_COPY_GATES.nonEngagementLetter.key, {
    prospectName: vars.prospectName,
    firmName: vars.firmName,
    date: vars.date,
    contactDate: vars.contactDate,
    referralBlock,
  });
  return { text: letter.text, approved: letter.approved, pendingReviewers: letter.pendingReviewers, referralIncluded: letter.approved && referralIncluded };
}

export class LetterNotNeutralError extends Error {
  constructor(readonly problems: string[]) {
    super(`Non-engagement letter is not neutral: ${problems.join("; ")}`);
    this.name = "LetterNotNeutralError";
  }
}

const FORBIDDEN_WORDS = ["conflict", "conflicted", "adverse", "opposing", "represents the other"];

/**
 * c62 rule 3: the letter never says there is a conflict and never names any
 * other person. `otherNames` = every party of the inquiry except the prospect.
 */
export function assertNeutralLetter(text: string, otherNames: readonly string[]): void {
  const problems: string[] = [];
  const hay = ` ${normalizeName(text)} `;
  for (const w of FORBIDDEN_WORDS) if (hay.includes(` ${normalizeName(w)} `)) problems.push(`mentions '${w}'`);
  for (const name of otherNames) {
    const n = normalizeName(name);
    if (n.length >= 3 && hay.includes(` ${n} `)) problems.push("names another party");
  }
  if (problems.length > 0) throw new LetterNotNeutralError([...new Set(problems)]);
}

export type LetterChannelChoice =
  | { channel: "portal" }
  | { channel: "email"; address: string }
  | { channel: "none"; reason: string };

/**
 * Delivery channel (c62 §4.3): portal if the prospect has one, else a secure
 * link by email to the DV-safe address from resolveClientAddress() (letters
 * are treated as sensitive). Postal mail is a staff action, recorded separately.
 */
export function chooseLetterChannel(contact: ContactPoints, hasPortal: boolean): LetterChannelChoice {
  if (hasPortal) return { channel: "portal" };
  const decision = resolveClientAddress(contact, "email", { sensitive: true });
  return decision.deliver ? { channel: "email", address: decision.address } : { channel: "none", reason: decision.reason };
}
