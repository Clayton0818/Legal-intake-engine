// Shared, framework-agnostic types for the "entry" slice of the intake
// flow (board card c23). Framework-agnostic on purpose — ADR-0001 §D3
// flags that the client-facing chat surface will eventually need to
// become a standalone embeddable bundle, not a Next.js page. Nothing in
// this file, engine.ts, validation.ts or copy.ts imports from "next" or
// "next/server", so that future rewrite doesn't have to touch this module.
//
// Scope: only the nodes from docs/product/spec/intake-flow.yaml between
// `entry` and the first node this build does NOT implement
// (out_of_scope_gate onward — conflict-check, scheduling, and the
// practice-area-specific question branches are separate, unbuilt cards).
// Node ids below are exactly intake-flow.yaml's ids, so a future full flow
// engine (src/flow/, currently just a README) can pick a session up from
// where this leaves it without a data migration.

import type { PracticeArea } from "@/llm/classifier";

export type { PracticeArea };
export type PracticeAreaOrUnknown = PracticeArea | "unknown";

export type IntakeNodeId =
  | "classify_caller"
  | "capture_contact"
  | "language_routing"
  | "classify_practice_area"
  // Real next node per intake-flow.yaml once classify_practice_area's
  // classification is confirmed (`next: out_of_scope_gate`). NOT
  // implemented by this card — a session parks here, still in progress
  // (terminalState stays null), until the eligibility-gate / conflict
  // engine (future card) picks it up.
  | "out_of_scope_gate"
  // Real node per intake-flow.yaml for existing/former/other callers
  // (`default: existing_caller_handoff`). Real staff routing isn't built
  // — a session parks here with a plain message, in progress, not a
  // terminal state.
  | "existing_caller_handoff"
  // The only node this build treats as an actually-completed intake: a
  // real TERMINAL in intake-flow.yaml's `terminals:` section, reached
  // directly from `classify_caller`'s `opposing_party` branch with no
  // intervening node this card would otherwise have to fake.
  | "declined_conflict";

export const PARKED_NODES: ReadonlySet<IntakeNodeId> = new Set<IntakeNodeId>([
  "out_of_scope_gate",
  "existing_caller_handoff",
]);

export const TERMINAL_NODES: ReadonlySet<IntakeNodeId> = new Set<IntakeNodeId>([
  "declined_conflict",
]);

export type CallerType =
  | "potential_new_client"
  | "existing_client"
  | "former_client"
  | "opposing_party"
  | "other";

export type Language = "en" | "es";

export interface CollectedAnswers {
  callerType?: CallerType;
  fullName?: string;
  email?: string;
  phone?: string;
  language?: Language;
  practiceAreaFreeText?: string;
  practiceArea?: PracticeAreaOrUnknown;
  practiceAreaConfirmed?: boolean;
  practiceAreaConfirmedManually?: boolean;
}

export type PromptKind = "single_choice" | "form" | "free_text" | "confirm" | "final";

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface PromptField {
  name: string;
  label: string;
  type: "text" | "email" | "tel";
}

export interface Prompt {
  node: IntakeNodeId;
  kind: PromptKind;
  message: string;
  /** Present for "single_choice" / "confirm" prompts. */
  options?: ChoiceOption[];
  /** Present for "form" prompts (capture_contact) — which fields to render. */
  fields?: PromptField[];
  /** True once the session has nothing further this build can ask for. */
  final: boolean;
}

export interface IntakeEventDraft {
  eventType: string;
  ruleName?: string;
  payload: Record<string, unknown>;
}

export interface StepResult {
  collectedAnswers: CollectedAnswers;
  nextNode: IntakeNodeId;
  events: IntakeEventDraft[];
  prompt: Prompt;
  /** True once nextNode is in PARKED_NODES or TERMINAL_NODES — i.e. this
   *  build has nothing further to ask, whether or not the DB-level intake
   *  is actually "complete" per intake-flow.yaml's terminal semantics. */
  sessionEnded: boolean;
  /** Only set when nextNode is an actual intake-flow.yaml terminal — see
   *  TERMINAL_NODES. A parked-but-not-terminal node leaves this undefined. */
  terminalState?: IntakeNodeId;
}

export class IntakeValidationError extends Error {
  public readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super("Invalid intake input");
    this.name = "IntakeValidationError";
    this.fieldErrors = fieldErrors;
  }
}
