// Small presentation helpers shared by the admin console's server
// components and its API route error messages. No database access here —
// pure formatting only.

export function formatEnumLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatFieldLabel(key: string): string {
  const withSpaces = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return withSpaces
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: Date | string | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Collected intake answers are a jsonb blob with no fixed shape (they
// depend on the firm's config version and which flow branches ran). This
// renders any top-level value as readable text instead of a raw JSON dump,
// falling back to JSON only for values that are themselves objects/arrays.
export function formatAnswerValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      return value.join(", ") || "—";
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

const STAGE_BADGE_CLASSES: Record<string, string> = {
  prospective: "bg-slate-100 text-slate-700",
  consultation_scheduled: "bg-blue-100 text-blue-700",
  consult_completed_manual_follow_up: "bg-amber-100 text-amber-700",
  pending_review: "bg-amber-100 text-amber-700",
  did_not_schedule: "bg-slate-100 text-slate-500",
  did_not_hire_referred_out: "bg-slate-100 text-slate-500",
  declined_conflict: "bg-red-100 text-red-700",
  retained: "bg-green-100 text-green-700",
  closed: "bg-slate-200 text-slate-600",
};

export function stageBadgeClass(stage: string): string {
  return STAGE_BADGE_CLASSES[stage] ?? "bg-slate-100 text-slate-700";
}

const CONFLICT_OUTCOME_BADGE_CLASSES: Record<string, string> = {
  clear: "bg-green-100 text-green-700",
  possible: "bg-amber-100 text-amber-700",
  definite: "bg-red-100 text-red-700",
};

export function conflictOutcomeBadgeClass(outcome: string): string {
  return CONFLICT_OUTCOME_BADGE_CLASSES[outcome] ?? "bg-slate-100 text-slate-700";
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}
