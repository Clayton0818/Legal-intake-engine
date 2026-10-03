// c43 / c44 — the automatic acknowledgement. Pure (reads only the in-process
// approval snapshot).
//
// The acknowledgement states a CONCRETE reply-by time (c43 rule 6), contains
// no legal information and never answers the question. For a deadline
// question it never states, confirms or corrects any date other than the
// reply-by promise (c44 rule 5) — checked in code, not only by review.
//
// Until the attorney approves the wording, the acknowledgement is HELD: it is
// recorded (so the record shows it was attempted) but never shown or sent to
// the client. The reply clock runs either way.

import { legalCopyStatus } from "@/compliance/approvals";
import { ALERT_COPY_GATES } from "../gates";
import { checkNoDeadlineStatement } from "../deadline/guard";
import { formatReplyBy, type ClockTier } from "./plan";

export interface AckPlan {
  /** Text recorded on the outbound auto-ack row (the placeholder while held). */
  text: string;
  /** True only when every piece of wording is approved and passes the guard. */
  deliverable: boolean;
  replyBy: string;
  /** Why it is held (pending gate keys, guard findings). */
  heldBecause: string[];
}

export function composeAcknowledgement(input: {
  tier: ClockTier;
  promiseAt: Date;
  timeZone: string;
  /** Add the "if urgent, call us" line (client says the event is imminent, c44 §4.5). */
  imminent: boolean;
  firmPhone: string | null;
}): AckPlan {
  const replyBy = formatReplyBy(input.promiseAt, input.timeZone);
  const mainKey = input.tier === "deadline" ? ALERT_COPY_GATES.deadlineReplyAck.key : ALERT_COPY_GATES.replyAck.key;
  const main = legalCopyStatus(mainKey, { replyBy });
  const parts = [main.text];
  const heldBecause: string[] = [];
  if (!main.approved) heldBecause.push(`pending review: ${mainKey}`);

  if (input.imminent && input.firmPhone) {
    const line = legalCopyStatus(ALERT_COPY_GATES.urgentCallLine.key, { firmPhone: input.firmPhone });
    parts.push(line.text);
    if (!line.approved) heldBecause.push(`pending review: ${ALERT_COPY_GATES.urgentCallLine.key}`);
  }
  const text = parts.join(" ");

  if (input.tier === "deadline" && heldBecause.length === 0) {
    // The phone number is allowed through the guard as well (digits could look like a date).
    const findings = checkNoDeadlineStatement(text, [replyBy, input.firmPhone ?? ""]);
    if (findings.length > 0) heldBecause.push(`deadline guard: ${findings.join(", ")}`);
  }
  return { text, deliverable: heldBecause.length === 0, replyBy, heldBecause };
}
