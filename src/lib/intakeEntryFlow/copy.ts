// Caller-facing copy for the entry portion of the intake flow.
//
// IMPORTANT — NOT ATTORNEY-REVIEWED. Per ADR-0001 ("scripted client-facing
// language... eventually needs attorney review before real use") and
// CLAUDE.md's compliance guardrails ("when in doubt, under-claim"), none
// of the strings below have been reviewed by an attorney. They are
// functional placeholders written to satisfy intake-flow.yaml's
// requirements (a confirmed classification read back to the caller, an
// honest terminal message that doesn't overclaim what happened) without
// making any legal characterization or promise the firm hasn't
// authorized. Flagged again in this card's PR description for human
// review — do not treat this file as final, ship-ready copy.

import type { PracticeAreaOrUnknown } from "./types";

export const CALLER_TYPE_OPTIONS = [
  { value: "potential_new_client", label: "I'm a new potential client" },
  { value: "existing_client", label: "I'm a current client" },
  { value: "former_client", label: "I'm a former client" },
  { value: "opposing_party", label: "I'm involved in a matter against this firm's client" },
  { value: "other", label: "Something else" },
] as const;

export const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
] as const;

export const PRACTICE_AREA_LABELS: Record<PracticeAreaOrUnknown, string> = {
  family_divorce: "Divorce",
  family_custody: "Child custody",
  family_modification: "Modifying an existing family court order",
  family_enforcement: "Enforcing an existing family court order",
  family_other: "Another family law matter",
  expunction: "Expunction / clearing a criminal record",
  personal_injury: "Personal injury",
  mediation: "Mediation",
  unknown: "None of these / I'm not sure",
};

export const PRACTICE_AREA_OPTIONS = (
  Object.entries(PRACTICE_AREA_LABELS) as [PracticeAreaOrUnknown, string][]
).map(([value, label]) => ({ value, label }));

export const COPY = {
  askCallerType: "First — how do you know this firm?",
  existingCallerHandoff:
    "Thanks — since you're already connected with this firm, we'll make sure your message reaches the right person on the team directly, rather than through this intake chat.",
  opposingPartyDeclined:
    "Thanks for letting us know. Because you're on the opposing side of a matter this firm may be involved in, we're not able to assist you here. If you'd like legal help of your own, your state or local bar association's lawyer referral service is a good place to start.",
  askContact: "Great — let's get your contact details so someone can follow up if we get disconnected.",
  fullNameLabel: "Full name",
  emailLabel: "Email address",
  phoneLabel: "Best callback number",
  askLanguage: "Which language do you prefer?",
  askPracticeAreaFreeText:
    'In a sentence or two, what\'s going on? For example: "I want to file for divorce" or "I need help enforcing a custody order."',
  confirmGuess: (label: string) =>
    `Based on what you told us, this sounds like it may be a matter about: ${label}. Is that right?`,
  askManualPracticeArea: "No problem — which of these best describes your situation?",
  confirmYes: "Yes, that's right",
  confirmNo: "No, let me pick",
  entryComplete:
    "Thanks — someone from the firm will follow up with you. We've recorded what you've told us so far, so you won't need to repeat it.",
} as const;
