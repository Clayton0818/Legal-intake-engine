// Approval gates owned by the calendar-alerts engine (c42–c47, c51, c53, c54, c64).
//
// Nothing here is approved. Until a licensed Texas attorney signs off
// (npm run compliance -- approve …) client-facing wording renders as a visible
// "[PENDING ATTORNEY REVIEW …]" placeholder and is HELD (never sent to a
// client), and gated actions are blocked and logged. Drafts are proposals for
// the reviewer, not approved wording.
//
// Shared gates reused (never redefined here):
//   vendor.email            every email this engine queues (via src/core/notify.ts)
//   vendor.ai_model         AI tagging of deadline questions (c44) and AI date extraction (c64)
//   vendor.mailbox_access   reading firm / lawyer mailboxes for court email (c64)
//   vendor.efiling          e-service notices from eFileTexas / CM-ECF (c64)
//   notify.client.reminder      neutral client reminder (c42, c46)
//   notify.client.generic_update minimal "you have a new update" email (c54)

import { defineGate } from "@/compliance/approvals";
import { NOTIFY_COPY_GATES, VENDOR_GATES } from "@/compliance/gates";

export { NOTIFY_COPY_GATES, VENDOR_GATES };

export const ALERT_COPY_GATES = {
  /** c43 — the automatic acknowledgement with the client promise as a concrete time. */
  replyAck: defineGate({
    key: "copy.calendar-alerts.reply_ack",
    cardIds: ["c43"],
    reviewers: ["attorney"],
    description:
      "Automatic acknowledgement of a client message: received, concrete reply-by time, no legal information, does not answer the question",
    draft:
      "Thank you — we have received your message and passed it to your legal team. " +
      "You will hear from us by {replyBy}. This is an automatic message and cannot answer questions about your matter. " +
      "If you are in danger, call 911.",
  }),
  /** c44 — acknowledgement for a question about a deadline: never states, confirms or corrects a date. */
  deadlineReplyAck: defineGate({
    key: "copy.calendar-alerts.deadline_reply_ack",
    cardIds: ["c44"],
    reviewers: ["attorney"],
    description:
      "Automatic acknowledgement of a client question about a court date or deadline: routed to the lawyer, reply-by time, never states, confirms or corrects any date and never describes consequences",
    draft:
      "Thank you — your question has been sent straight to your lawyer, who will reply by {replyBy}. " +
      "This automatic message cannot answer questions about dates or deadlines; only your lawyer can. " +
      "If you are in danger, call 911.",
  }),
  /** c44 §4.5 — added when the client says the event is imminent. */
  urgentCallLine: defineGate({
    key: "copy.calendar-alerts.urgent_call_line",
    cardIds: ["c44"],
    reviewers: ["attorney"],
    description: "Line added to the acknowledgement when the client says the event is imminent: call the firm",
    draft: "If this is urgent, please call our office at {firmPhone}.",
  }),
  /** c43/c44 — minimal email/in-app notice that the acknowledgement is waiting in the portal (c51 minimal content). */
  ackNotice: defineGate({
    key: "copy.calendar-alerts.ack_notice",
    cardIds: ["c43", "c44", "c51"],
    reviewers: ["attorney"],
    description: "Minimal client email: your message was received; see the portal (no matter details)",
    draft:
      "Subject: We received your message — {firmName}\n\n" +
      "We received your message. You can see when to expect a reply in your secure client portal: {portalUrl}",
  }),
  /** c46 — the portal label for the client's own past-due task (neutral, never 'overdue' blame wording). */
  portalPastDueLabel: defineGate({
    key: "copy.calendar-alerts.portal_past_due_label",
    cardIds: ["c46"],
    reviewers: ["attorney"],
    description: "Neutral portal label shown on the client's own past-due task (no legal-consequence language)",
    draft: "Still needed — please take care of this when you can, or tap “I need help”.",
  }),
} as const;

export const ALERT_RULE_GATES = {
  /**
   * c44 — the system prompt for the AI that tags whether a client message is
   * about a deadline. The AI only TAGS (it can add the stricter clock, never
   * remove it) and never answers the question.
   */
  deadlineTagPrompt: defineGate({
    key: "copy.calendar-alerts.deadline_tag_prompt",
    cardIds: ["c44"],
    reviewers: ["attorney"],
    description: "AI prompt that only tags whether a client message is about a deadline (it never answers or states a date)",
    draft:
      "You label client messages for a law firm. Answer ONLY with JSON {\"deadline_related\": true|false, \"confidence\": 0..1}. " +
      "A message is deadline-related if it asks or talks about a court date, hearing, trial, filing, a response or answer " +
      "being due, or any 'when do I have to…' question. Do not answer the message. Do not state or calculate any date.",
  }),
  /**
   * c64 — attorney review of the court-notice rules: what counts as a court
   * sender, and that dates found in a notice are only SUGGESTIONS. Until
   * approved, suggestions are kept as text for the lawyer and are NOT placed
   * on the calendar even as 'proposed' events. Detection and the alert itself
   * always run (failing safe means alerting MORE, not less).
   */
  courtNoticeSuggestions: defineGate({
    key: "rules.calendar-alerts.court_notice_suggestions",
    cardIds: ["c64"],
    reviewers: ["attorney"],
    description:
      "Court-notice handling: dates found in a court email become PROPOSED calendar entries for a lawyer to confirm; relative periods ('within 20 days') are never computed",
  }),
} as const;

export const ALERT_GATE_KEYS: readonly string[] = [
  ...Object.values(ALERT_COPY_GATES),
  ...Object.values(ALERT_RULE_GATES),
].map((g) => g.key);

/** Shared gates this engine depends on (for the admin page). */
export const ALERT_SHARED_GATE_KEYS: readonly string[] = [
  VENDOR_GATES.email.key,
  VENDOR_GATES.aiModel.key,
  VENDOR_GATES.mailboxAccess.key,
  VENDOR_GATES.efiling.key,
  NOTIFY_COPY_GATES.reminder.key,
  NOTIFY_COPY_GATES.genericUpdate.key,
];
