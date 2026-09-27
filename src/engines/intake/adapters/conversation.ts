// VENDOR ADAPTER: replies inside an intake conversation (c65).
//
// Web chat, web forms and staff-entered intakes show replies in the page or
// to the staff member reading a script — no vendor involved. Text messages
// and AI phone calls go through a subprocessor (voice / SMS vendor), which
// needs a signed DPA before any real client data reaches it: until the
// matching vendor gate is approved, the stub adapter RECORDS the reply
// (intake_messages, status 'held') instead of sending it.
//
// Email replies from the intake inbox use the shared notification outbox
// (src/core/notify.ts), which is gated on 'vendor.email' by the core.

import { isApproved } from "@/compliance/approvals";
import { VENDOR_GATES } from "@/compliance/gates";
import type { SendResult } from "@/core/notify";
import { CHANNEL_RULE_GATES } from "../gates";
import type { IntakeChannel } from "../channels/records";

export interface ConversationMessage {
  tenantId: string;
  intakeSessionId: string;
  channel: IntakeChannel;
  to: string | null;
  text: string;
}

export interface ConversationProvider {
  readonly name: string;
  readonly isStub: boolean;
  send(msg: ConversationMessage): Promise<SendResult>;
}

/** Records what would have been sent; never sends. */
export class StubConversationProvider implements ConversationProvider {
  readonly name = "stub";
  readonly isStub = true;
  readonly recorded: ConversationMessage[] = [];
  async send(msg: ConversationMessage): Promise<SendResult> {
    this.recorded.push(msg);
    return { outcome: "held", detail: "Stub conversation provider: recorded, not sent." };
  }
}

let provider: ConversationProvider = new StubConversationProvider();

export function getConversationProvider(): ConversationProvider {
  return provider;
}

/** Swap in a real voice/SMS provider (only once its vendor gate is approved). */
export function setConversationProvider(next: ConversationProvider): void {
  provider = next;
}

/** In-page / spoken-by-staff channels need no vendor. */
export const IN_PAGE_CHANNELS: readonly IntakeChannel[] = ["web_chat", "web_form", "walk_in", "phone_manual", "phone_staff", "referral"];

/** The vendor gate a conversational reply on this channel depends on (null = none). Pure. */
export function vendorGateFor(channel: IntakeChannel): string | null {
  if (channel === "sms") return VENDOR_GATES.sms.key;
  if (channel === "phone_ai") return VENDOR_GATES.voice.key;
  if (channel === "email") return VENDOR_GATES.email.key;
  return null;
}

export type ReplyDecision =
  | { mode: "show" }
  | { mode: "send" }
  | { mode: "hold"; reason: string };

/**
 * Decide what happens to one conversational reply (pure apart from reading
 * approval state):
 *  - wording not approved → shown in-page as the visible placeholder, never
 *    sent through a vendor;
 *  - vendor not approved → held;
 *  - SMS before the person's separate text opt-in → held unless the
 *    same-conversation reply rule is approved (TCPA, attorney review);
 *  - safety-flagged person without a confirmed safe contact → held (c66).
 */
export function decideReply(args: {
  channel: IntakeChannel;
  copyApproved: boolean;
  smsOptIn: boolean;
  safetySuppressed: boolean;
  /** Safety replies (911 message, safe-contact question) go to the open conversation itself. */
  isSafetyReply?: boolean;
}): ReplyDecision {
  if (IN_PAGE_CHANNELS.includes(args.channel)) return { mode: "show" };
  if (!args.copyApproved) return { mode: "hold", reason: "Reply wording is pending attorney review." };
  if (args.safetySuppressed && !args.isSafetyReply) return { mode: "hold", reason: "Safety flag: no messages until a safe contact method is confirmed (c66)." };
  const gate = vendorGateFor(args.channel);
  if (gate && !isApproved(gate)) return { mode: "hold", reason: `Vendor gate '${gate}' is pending.` };
  if (args.channel === "sms" && !args.smsOptIn && !isApproved(CHANNEL_RULE_GATES.smsConversationReply.key)) {
    return { mode: "hold", reason: "No SMS opt-in yet and same-conversation replies are pending attorney review (TCPA)." };
  }
  return { mode: "send" };
}
