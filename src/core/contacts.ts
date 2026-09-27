// Contact helpers shared by every engine. Contacts are rows of `parties`
// (schema.ts; aliased as `contacts` in src/db/tables/foundation.ts).
//
// resolveClientAddress() is the ONLY sanctioned way to pick an email address
// or phone number for a client/party message: it applies the safe-contact
// preferences, DV-safe rules and SMS consent (c42, c51, c103).

import type { SafeContactPreferences } from "@/db/types";

export type { SafeContactPreferences };

/**
 * Normalise a name for storage in `normalizedName` / `normalizedAliases`:
 * lowercase, accents removed, punctuation dropped, whitespace collapsed.
 * (Fuzzy matching — nicknames, phonetics, Spanish surnames — is the
 * conflict-check engine's job, c57; this is only the canonical stored form.)
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip combining accents (Unicode marks)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ContactPoints {
  email: string | null;
  emails?: readonly string[];
  phone: string | null;
  phones?: readonly string[];
  safeContact: SafeContactPreferences | null | undefined;
  dvSensitive: boolean;
}

export type AddressDecision =
  | { deliver: true; address: string }
  | { deliver: false; reason: string };

/**
 * Choose the destination for an email or SMS to a party, or explain why
 * nothing may be sent. Rules:
 *  - the party's chosen safe address always wins;
 *  - a DV-sensitive party is contacted ONLY at a safe address they chose;
 *  - email can be switched off entirely, or off for sensitive flags only;
 *  - SMS needs documented consent (TCPA) and can be switched off.
 */
export function resolveClientAddress(
  contact: ContactPoints,
  channel: "email" | "sms",
  opts: { sensitive?: boolean } = {}
): AddressDecision {
  const prefs = contact.safeContact ?? {};
  if (channel === "email") {
    if (prefs.emailAllowed === false) return { deliver: false, reason: "Client has turned off email." };
    if (opts.sensitive && prefs.sensitiveByEmail === false) {
      return { deliver: false, reason: "Client turned off email for sensitive notices." };
    }
    const safe = prefs.safeEmail?.trim();
    if (safe) return { deliver: true, address: safe };
    if (contact.dvSensitive) {
      return { deliver: false, reason: "DV-sensitive client has no safe email on file; in-app only." };
    }
    const fallback = contact.email?.trim() || contact.emails?.find((e) => e.trim())?.trim();
    return fallback ? { deliver: true, address: fallback } : { deliver: false, reason: "No email address on file." };
  }

  if (prefs.smsAllowed === false) return { deliver: false, reason: "Client has turned off text messages." };
  if (!prefs.smsConsentAt) return { deliver: false, reason: "No documented SMS consent (TCPA)." };
  if (opts.sensitive && prefs.sensitiveByEmail === false) {
    return { deliver: false, reason: "Client turned off messages for sensitive notices." };
  }
  const safe = prefs.safePhone?.trim();
  if (safe) return { deliver: true, address: safe };
  if (contact.dvSensitive) {
    return { deliver: false, reason: "DV-sensitive client has no safe phone on file; in-app only." };
  }
  const fallback = contact.phone?.trim() || contact.phones?.find((p) => p.trim())?.trim();
  return fallback ? { deliver: true, address: fallback } : { deliver: false, reason: "No phone number on file." };
}
