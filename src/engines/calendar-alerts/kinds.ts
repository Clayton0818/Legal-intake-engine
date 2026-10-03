// Task kinds and flag types written by the calendar-alerts engine. Other
// engines' tasks are flagged too (c45 is ONE mechanism); these are only the
// ones this engine creates.

export const TASK_KINDS = {
  /** c43/c44: the firm owes the client a reply. Timed by the reply clock, not the generic overdue scan. */
  firmReplyDue: "calendar-alerts.firm_reply_due",
  /** c42: the client owes the firm a reply (client-owned, client-visible). */
  clientReplyDue: "calendar-alerts.client_reply_due",
  /** c42/c46 final rung: the lawyer decides the next step. */
  lawyerDecides: "calendar-alerts.lawyer_decides_next_step",
  /** c54: an AI/system-drafted update waiting for lawyer approval. */
  updateApproval: "calendar-alerts.update_approval_due",
  /** c54: the matter's regular client update is due. */
  clientUpdateDue: "calendar-alerts.client_update_due",
} as const;

/** Tasks whose timing is owned by a dedicated clock here; the generic overdue scan leaves them alone. */
export const CLOCK_MANAGED_KINDS: readonly string[] = [TASK_KINDS.firmReplyDue];

export const FLAG_TYPES = {
  replyOverdue: "calendar-alerts.reply_overdue",
  replyUrgent: "calendar-alerts.reply_urgent",
  taskOverdue: "task.overdue",
  clientTaskOverdue: "task.client_overdue",
  clientTaskDeadline: "task.client_overdue_deadline",
  clientNonResponse: "calendar-alerts.client_non_response",
  courtNotice: "calendar-alerts.court_notice",
  courtNoticeUnmatched: "calendar-alerts.court_notice_unmatched",
  courtNoticePhishing: "calendar-alerts.court_notice_phishing",
  stalled: "calendar-alerts.stalled_workflow",
  health: "calendar-alerts.matter_health",
  deliveryBounced: "calendar-alerts.email_bounced",
  deliveryFailed: "calendar-alerts.email_failed",
  noSafeAddress: "calendar-alerts.client_no_safe_email",
  classifierDown: "calendar-alerts.classifier_unavailable",
  courtSendersMissing: "calendar-alerts.court_senders_missing",
  deadlineLinkDropped: "calendar-alerts.deadline_link_dropped",
} as const;

/** Calendar event types that count as a deadline for the c44/c45 safety nets (attorney to confirm the list, c45 §11 q4). */
export const DEADLINE_EVENT_TYPES: readonly string[] = [
  "hearing",
  "trial",
  "deposition",
  "mediation",
  "filing_deadline",
  "response_deadline",
  "limitation_date",
];
