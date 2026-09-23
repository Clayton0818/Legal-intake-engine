// Field validation for the entry-flow steps, matching
// docs/product/spec/question-bank.yaml's field definitions for the fields
// this build actually captures (full_name, email, phone, language,
// practice_area, caller_type). Deliberately simple — this is input
// hygiene, not a general-purpose form validation library, and the real
// field catalogue's richer rules (e.g. person_name formatting) can grow
// here incrementally without touching the engine that calls these.

import { IntakeValidationError } from "./types";
import type { CallerType, Language, PracticeAreaOrUnknown } from "./types";

const CALLER_TYPES: readonly CallerType[] = [
  "potential_new_client",
  "existing_client",
  "former_client",
  "opposing_party",
  "other",
];

const LANGUAGES: readonly Language[] = ["en", "es"];

const PRACTICE_AREAS_OR_UNKNOWN: readonly PracticeAreaOrUnknown[] = [
  "family_divorce",
  "family_custody",
  "family_modification",
  "family_enforcement",
  "family_other",
  "expunction",
  "personal_injury",
  "mediation",
  "unknown",
];

export function parseCallerType(value: unknown): CallerType {
  if (typeof value !== "string" || !CALLER_TYPES.includes(value as CallerType)) {
    throw new IntakeValidationError({ callerType: "Choose one of the listed options." });
  }
  return value as CallerType;
}

export function parseFullName(value: unknown): string {
  if (typeof value !== "string") {
    throw new IntakeValidationError({ fullName: "Enter your full name." });
  }
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 200 || !/[A-Za-z]/.test(trimmed)) {
    throw new IntakeValidationError({ fullName: "Enter your full name." });
  }
  return trimmed;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseEmail(value: unknown): string {
  if (typeof value !== "string" || !EMAIL_RE.test(value.trim())) {
    throw new IntakeValidationError({ email: "Enter a valid email address." });
  }
  return value.trim().toLowerCase();
}

export function parsePhone(value: unknown): string {
  if (typeof value !== "string") {
    throw new IntakeValidationError({ phone: "Enter a callback phone number." });
  }
  const digitCount = value.replace(/[^0-9]/g, "").length;
  if (digitCount < 7 || digitCount > 15) {
    throw new IntakeValidationError({ phone: "Enter a valid phone number." });
  }
  return value.trim();
}

export function parseLanguage(value: unknown): Language {
  if (typeof value !== "string" || !LANGUAGES.includes(value as Language)) {
    throw new IntakeValidationError({ language: "Choose a supported language." });
  }
  return value as Language;
}

export function parsePracticeAreaFreeText(value: unknown): string {
  if (typeof value !== "string") {
    throw new IntakeValidationError({ practiceAreaFreeText: "Tell us briefly what's going on." });
  }
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 2000) {
    throw new IntakeValidationError({
      practiceAreaFreeText: "Tell us a bit more (a sentence or two is fine).",
    });
  }
  return trimmed;
}

export function parseManualPracticeArea(value: unknown): PracticeAreaOrUnknown {
  if (typeof value !== "string" || !PRACTICE_AREAS_OR_UNKNOWN.includes(value as PracticeAreaOrUnknown)) {
    throw new IntakeValidationError({ practiceArea: "Choose one of the listed options." });
  }
  return value as PracticeAreaOrUnknown;
}

export function parseConfirmed(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new IntakeValidationError({ confirmed: "Let us know whether that's right." });
  }
  return value;
}
