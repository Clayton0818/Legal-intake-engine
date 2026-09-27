// Shared types of the Conflict-check engine. Pure (no database imports).

export const CHECK_TRIGGERS = ["intake", "party_added", "reopened", "lateral_hire", "periodic", "interest", "manual"] as const;
export type CheckTrigger = (typeof CHECK_TRIGGERS)[number];

export type ConflictOutcome = "clear" | "possible" | "definite";

export const INDEX_ROLES = [
  "prospective_client",
  "client",
  "former_client",
  "opposing_party",
  "opposing_counsel",
  "related_party",
  "co_party",
  "insurer",
  "co_defendant",
  "other",
] as const;
export type IndexRole = (typeof INDEX_ROLES)[number];

export const NAME_TYPES = ["legal", "alias", "former", "maiden", "married", "nickname", "business", "dba"] as const;
export type NameType = (typeof NAME_TYPES)[number];

export const NAME_SOURCES = ["intake", "matter", "document", "import", "manual"] as const;
export type NameSource = (typeof NAME_SOURCES)[number];

/** One name searched by a check, as entered. */
export interface SearchedName {
  name: string;
  /** Role of this person in the NEW matter/inquiry (c3 is role-sensitive). */
  role: string;
  /** The index record created/selected for this name, if any. */
  partyId?: string | null;
  /** Caller refused or could not name this party: the check can never be clear (c56 rule 7). */
  nameUnknown?: boolean;
  completeness?: "full" | "partial";
  dateOfBirth?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Where an index entry came from. Lateral lists and lawyer interests are stored apart from `parties`. */
export type IndexSourceType = "party" | "lateral_list" | "interest";

/** One involvement of an indexed party in a matter or inquiry. */
export interface Involvement {
  kind: "matter" | "inquiry";
  id: string;
  role: string;
  relationship?: string | null;
  /** 'current' | 'former' (closed matter / ended inquiry) | 'prospective' (inquiry never retained). */
  status: "current" | "former" | "prospective";
  isAdverse?: boolean | null;
  stage?: string | null;
}

/** A searchable entry assembled from the party index, a lateral list or a disclosure list. */
export interface IndexEntry {
  sourceType: IndexSourceType;
  /** party id, lateral_prior_matters id, or interest_disclosures id. */
  sourceId: string;
  /** For party entries: the record the entry resolves to (the merge survivor, if merged). */
  partyId?: string | null;
  displayName: string;
  /** Normalised names (legal name + every variant). */
  names: ReadonlyArray<{ normalized: string; type: string }>;
  kind?: "person" | "organization";
  dateOfBirth?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
  involvements: readonly Involvement[];
  /** Lateral hire or disclosing lawyer (lateral_list / interest entries). Conflicts role only. */
  ownerUserId?: string | null;
  /** Extra detail for the reviewer, e.g. interest type or the prior matter's general subject. */
  note?: string | null;
}

export type MatchKind =
  | "exact"
  | "reordered"
  | "variant"
  | "subset"
  | "nickname"
  | "initial"
  | "fuzzy"
  | "single_token"
  | "email"
  | "phone"
  | "dob_name"
  | "org_link";

/** One hit, stored on the check (internal; conflicts role only). */
export interface ConflictHit {
  searchedIndex: number;
  searchedName: string;
  searchedRole: string;
  sourceType: IndexSourceType;
  sourceId: string;
  partyId: string | null;
  displayName: string;
  matchedName: string;
  matchKind: MatchKind;
  /** 0..1; higher is a stronger match. */
  strength: number;
  reasons: string[];
  involvements: Involvement[];
  ownerUserId: string | null;
  note: string | null;
  /** Set when the hit was found through a parent/subsidiary/affiliate link. */
  viaOrgLinkFromPartyId?: string | null;
}

export const DECISIONS = ["cleared", "proceed_with_consent", "proceed_with_screen", "declined"] as const;
export type Decision = (typeof DECISIONS)[number];

export type GateState = "open" | "closed";
export type GateClosedReason = "pending_review" | "awaiting_consent" | "awaiting_screen" | "declined" | "no_check";

export type GateSubject = { type: "intake_session"; id: string } | { type: "matter"; id: string };
