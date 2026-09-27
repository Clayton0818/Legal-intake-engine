// Shapes of the jsonb columns introduced by the case-management foundation.
//
// Kept here (a dependency-free file under src/db/) rather than in src/core/
// so the schema files never import application code — drizzle-kit loads the
// schema files on their own when generating migrations. src/core/* re-exports
// these types, so engine code can import them from either place.

/** Weekday keys used everywhere a weekly schedule is stored. */
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** One open interval inside a local day, as 24h "HH:MM" wall-clock strings. */
export interface BusinessInterval {
  /** Inclusive start, "HH:MM" (00:00–23:59). */
  start: string;
  /** Exclusive end, "HH:MM" (00:01–24:00). "24:00" means midnight at the end of the day. */
  end: string;
}

/** Business hours per weekday. A missing or empty day means closed. */
export type WeeklyHours = Partial<Record<Weekday, BusinessInterval[]>>;

/** A firm holiday: a whole local calendar day (in the firm's time zone) with no business hours. */
export interface FirmHoliday {
  /** "YYYY-MM-DD", interpreted in the firm's time zone. */
  date: string;
  name?: string;
}

/** Quiet hours for non-urgent client messages, local "HH:MM" (may wrap midnight). */
export interface QuietHours {
  start: string;
  end: string;
}

/**
 * Safe-contact preferences for a party (c42, c51, c103). Every outbound
 * client notification resolves its destination through these — never by
 * reading `parties.email` / `parties.phone` directly — so a DV-sensitive
 * client's shared or monitored inbox is never used.
 */
export interface SafeContactPreferences {
  /** The address the client chose as safe for email. Takes precedence over `parties.email`. */
  safeEmail?: string | null;
  /** The number the client chose as safe for SMS. Takes precedence over `parties.phone`. */
  safePhone?: string | null;
  /** Email allowed at all. Default true (false for dvSensitive parties without a safeEmail). */
  emailAllowed?: boolean;
  /** SMS allowed at all. SMS additionally requires `smsConsentAt` (TCPA). */
  smsAllowed?: boolean;
  /** ISO timestamp of documented SMS consent. No consent, no SMS. */
  smsConsentAt?: string | null;
  /** When false, flags marked `sensitive` are never emailed to this party (in-app only). */
  sensitiveByEmail?: boolean;
  /** Voicemail allowed (phone engines). */
  voicemailAllowed?: boolean;
  /** Per-party quiet hours override (otherwise the firm's quiet hours apply). */
  quietHours?: QuietHours | null;
  /** Staff-only note about safe contact (never shown to other parties). */
  note?: string | null;
}

/** Open-ended per-engine settings bag, keyed by engine slug (see src/engines/README.md). */
export type EngineSettings = Record<string, Record<string, unknown>>;

/** Actor recorded on audit events, flags, and task completions. */
export type ActorType = "system" | "user" | "client" | "ai";
