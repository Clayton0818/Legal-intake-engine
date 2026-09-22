// Pure, framework-agnostic step function for the "entry" slice of
// docs/product/spec/intake-flow.yaml (board card c23). No database, no
// Next.js — this is called by the API route handlers under
// src/app/api/intake/, which own persistence (withTenant(), intakeEvents).
// Keeping it pure also means it's trivially unit-testable without a DB.
//
// Covers exactly: classify_caller -> capture_contact -> language_routing
// -> classify_practice_area, ending each session either at a real
// intake-flow.yaml terminal (declined_conflict) or "parked" at the next
// real node this build doesn't implement (out_of_scope_gate,
// existing_caller_handoff) — see types.ts's comment on IntakeNodeId for
// why those particular ids were chosen.

import { classify } from "@/llm/classifier";
import {
  COPY,
  CALLER_TYPE_OPTIONS,
  LANGUAGE_OPTIONS,
  PRACTICE_AREA_LABELS,
  PRACTICE_AREA_OPTIONS,
} from "./copy";
import {
  IntakeValidationError,
  PARKED_NODES,
  TERMINAL_NODES,
} from "./types";
import type {
  CollectedAnswers,
  IntakeEventDraft,
  IntakeNodeId,
  Prompt,
  StepResult,
} from "./types";
import {
  parseCallerType,
  parseConfirmed,
  parseEmail,
  parseFullName,
  parseLanguage,
  parseManualPracticeArea,
  parsePhone,
  parsePracticeAreaFreeText,
} from "./validation";

function event(eventType: string, payload: Record<string, unknown>): IntakeEventDraft {
  return { eventType, payload };
}

/** The prompt to show for a given (node, answers) pair — used both for a
 *  fresh step's response and for GET /sessions/[id] (resuming a session
 *  that already has a currentNode and collectedAnswers in the database). */
export function getPrompt(node: IntakeNodeId, answers: CollectedAnswers): Prompt {
  switch (node) {
    case "classify_caller":
      return {
        node,
        kind: "single_choice",
        message: COPY.askCallerType,
        options: [...CALLER_TYPE_OPTIONS],
        final: false,
      };

    case "capture_contact":
      return {
        node,
        kind: "form",
        message: COPY.askContact,
        fields: [
          { name: "fullName", label: COPY.fullNameLabel, type: "text" },
          { name: "email", label: COPY.emailLabel, type: "email" },
          { name: "phone", label: COPY.phoneLabel, type: "tel" },
        ],
        final: false,
      };

    case "language_routing":
      return {
        node,
        kind: "single_choice",
        message: COPY.askLanguage,
        options: [...LANGUAGE_OPTIONS],
        final: false,
      };

    case "classify_practice_area": {
      if (!answers.practiceArea) {
        return { node, kind: "free_text", message: COPY.askPracticeAreaFreeText, final: false };
      }
      if (!answers.practiceAreaConfirmed) {
        if (answers.practiceArea === "unknown") {
          return {
            node,
            kind: "single_choice",
            message: COPY.askManualPracticeArea,
            options: [...PRACTICE_AREA_OPTIONS],
            final: false,
          };
        }
        return {
          node,
          kind: "confirm",
          message: COPY.confirmGuess(PRACTICE_AREA_LABELS[answers.practiceArea]),
          options: [
            { value: "yes", label: COPY.confirmYes },
            { value: "no", label: COPY.confirmNo },
          ],
          final: false,
        };
      }
      // Confirmed but still on this node shouldn't happen via advance()
      // (it always moves to out_of_scope_gate on confirmation) — fall
      // through defensively rather than asking the caller anything odd.
      return { node, kind: "final", message: COPY.entryComplete, final: true };
    }

    case "existing_caller_handoff":
      return { node, kind: "final", message: COPY.existingCallerHandoff, final: true };

    case "declined_conflict":
      return { node, kind: "final", message: COPY.opposingPartyDeclined, final: true };

    case "out_of_scope_gate":
      return { node, kind: "final", message: COPY.entryComplete, final: true };

    default: {
      const exhaustive: never = node;
      throw new Error(`No prompt defined for intake node: ${String(exhaustive)}`);
    }
  }
}

function stay(node: IntakeNodeId, answers: CollectedAnswers, events: IntakeEventDraft[]): StepResult {
  return {
    collectedAnswers: answers,
    nextNode: node,
    events,
    prompt: getPrompt(node, answers),
    sessionEnded: false,
  };
}

function advanceTo(
  answers: CollectedAnswers,
  nextNode: IntakeNodeId,
  events: IntakeEventDraft[]
): StepResult {
  return {
    collectedAnswers: answers,
    nextNode,
    events,
    prompt: getPrompt(nextNode, answers),
    sessionEnded: PARKED_NODES.has(nextNode) || TERMINAL_NODES.has(nextNode),
    terminalState: TERMINAL_NODES.has(nextNode) ? nextNode : undefined,
  };
}

/**
 * Advances a session by exactly one caller turn.
 *
 * @param currentNode the session's current node (from intake_sessions.current_node)
 * @param collectedAnswers the session's answers so far (from intake_sessions.collected_answers)
 * @param rawInput the caller's raw input for this turn — shape depends on
 *   currentNode (and, for classify_practice_area, on which sub-phase the
 *   answers are already in); validated here, never trusted as-is.
 *
 * Throws IntakeValidationError for bad input. Callers (the API routes) are
 * expected to catch that and return 400 with its fieldErrors.
 */
export function advance(
  currentNode: IntakeNodeId,
  collectedAnswers: CollectedAnswers,
  rawInput: unknown
): StepResult {
  if (PARKED_NODES.has(currentNode) || TERMINAL_NODES.has(currentNode)) {
    throw new IntakeValidationError({
      _session: "This intake is already complete; no further input is accepted.",
    });
  }

  const input: Record<string, unknown> =
    rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};

  switch (currentNode) {
    case "classify_caller": {
      const callerType = parseCallerType(input.callerType);
      const answers: CollectedAnswers = { ...collectedAnswers, callerType };

      // intake-flow.yaml's classify_caller branches:
      if (callerType === "opposing_party") {
        return advanceTo(
          answers,
          "declined_conflict",
          [event("node_transition", { fromNode: currentNode, toNode: "declined_conflict" })]
        );
      }
      if (callerType !== "potential_new_client") {
        // existing_client | former_client | other -> the spec's
        // `default: existing_caller_handoff` branch.
        return advanceTo(
          answers,
          "existing_caller_handoff",
          [event("node_transition", { fromNode: currentNode, toNode: "existing_caller_handoff" })]
        );
      }
      return advanceTo(
        answers,
        "capture_contact",
        [event("node_transition", { fromNode: currentNode, toNode: "capture_contact" })]
      );
    }

    case "capture_contact": {
      const fullName = parseFullName(input.fullName);
      const email = parseEmail(input.email);
      const phone = parsePhone(input.phone);
      const answers: CollectedAnswers = { ...collectedAnswers, fullName, email, phone };
      return advanceTo(
        answers,
        "language_routing",
        [event("node_transition", { fromNode: currentNode, toNode: "language_routing" })]
      );
    }

    case "language_routing": {
      const language = parseLanguage(input.language);
      const answers: CollectedAnswers = { ...collectedAnswers, language };
      return advanceTo(
        answers,
        "classify_practice_area",
        [event("node_transition", { fromNode: currentNode, toNode: "classify_practice_area" })]
      );
    }

    case "classify_practice_area": {
      // Sub-phase is derived from the answers already collected, not a
      // separate stored flag — see types.ts's comment on CollectedAnswers.
      if (!collectedAnswers.practiceArea) {
        // Phase 1: caller describes their situation; run the mock
        // classifier and stay on this node to show the candidate/ask.
        const practiceAreaFreeText = parsePracticeAreaFreeText(input.practiceAreaFreeText);
        const result = classify({ freeText: practiceAreaFreeText, localeHint: collectedAnswers.language });
        const answers: CollectedAnswers = {
          ...collectedAnswers,
          practiceAreaFreeText,
          practiceArea: result.practiceArea,
          practiceAreaConfirmed: false,
        };
        return stay(currentNode, answers, [
          event("classifier_ran", {
            practiceArea: result.practiceArea,
            practiceAreaConfidence: result.practiceAreaConfidence,
            outOfScopeSignal: result.outOfScopeSignal,
            queuePriority: result.queuePriority,
            queuePriorityConfidence: result.queuePriorityConfidence,
            safetyFlag: result.safetyFlag,
            modelVersion: result.modelVersion,
            promptVersion: result.promptVersion,
            // Raw free text is deliberately NOT included here.
            // question-bank.yaml classifies intake free text as
            // `privileged`-tier PII; per llm-triage-classifier.md §9 it
            // inherits that handling wherever it's stored. It already
            // lives in intake_sessions.collected_answers (this is the
            // established place for captured answers); duplicating it
            // into the broader-access, append-only audit log would widen
            // exposure of privileged data for no benefit this card needs.
          }),
        ]);
      }

      const guessPending = collectedAnswers.practiceArea !== "unknown";

      if (guessPending) {
        // Phase 2a: confirm or reject the classifier's candidate guess.
        const confirmed = parseConfirmed(input.confirmed);
        if (confirmed) {
          const answers: CollectedAnswers = { ...collectedAnswers, practiceAreaConfirmed: true };
          return advanceTo(
            answers,
            "out_of_scope_gate",
            [event("node_transition", { fromNode: currentNode, toNode: "out_of_scope_gate" })]
          );
        }
        // Rejected — fall through to the manual-pick prompt on the next
        // turn by resetting to `unknown`, rather than a separate stored
        // sub-phase flag. getPrompt() renders the picker for `unknown`.
        const answers: CollectedAnswers = { ...collectedAnswers, practiceArea: "unknown" };
        return stay(currentNode, answers, [
          event("classification_rejected_by_caller", { originalGuess: collectedAnswers.practiceArea }),
        ]);
      }

      // Phase 2b: manual pick, either because the classifier gave up
      // (unknown from the start) or the caller just rejected its guess.
      const manual = parseManualPracticeArea(input.manualPracticeArea);
      const answers: CollectedAnswers = {
        ...collectedAnswers,
        practiceArea: manual,
        practiceAreaConfirmed: true,
        practiceAreaConfirmedManually: true,
      };
      return advanceTo(
        answers,
        "out_of_scope_gate",
        [event("node_transition", { fromNode: currentNode, toNode: "out_of_scope_gate" })]
      );
    }

    default: {
      // Not an exhaustiveness guard — PARKED_NODES/TERMINAL_NODES (checked
      // above) legitimately narrow currentNode's type to fewer than the
      // full IntakeNodeId union by the time we get here, so this default
      // branch is reachable by construction, not just defensively. It
      // still shouldn't be reached at runtime, since the guard above
      // returns for every node in those two sets — fail loudly rather
      // than silently doing nothing if it somehow is, per ADR-0001's
      // "loud over elegant."
      throw new Error(`No entry-flow handler for intake node: ${String(currentNode)}`);
    }
  }
}
