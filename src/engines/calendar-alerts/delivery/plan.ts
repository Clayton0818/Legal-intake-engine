// c51 — what happens after the core outbox has tried to deliver. Pure.
//
// The core (src/core/notify.ts) sends, holds, retries and records provider
// callbacks. This engine owns the follow-ups so "a flag never silently goes
// nowhere" (c51 §4.7–4.8):
//   bounced email to a CLIENT          → internal flag to the responsible lawyer
//   bounced email to a FIRM USER       → internal flag to the firm admin
//   failed after retries (any)         → internal flag to the firm admin
//   client email suppressed for lack
//   of a (safe) address                → internal flag to the lawyer, once per client
// Deliberate opt-outs (client turned email off) are respected, not flagged.
//
// Plus the daily digest of non-urgent internal flag emails (firm setting).

import { fromLocal, toLocal } from "@/core/businessHours";
import { FLAG_TYPES } from "../kinds";

export type FollowupKind = "bounced" | "failed" | "suppressed_no_address" | "email_missing";

export interface OutboxLike {
  channel: string;
  recipientType: string;
  status: string;
  lastError: string | null;
}

export interface FollowupPlan {
  kind: FollowupKind;
  /** Who gets the internal flag. */
  notify: "lawyer" | "admin";
  flagType: string;
  title: string;
  summary: string;
}

/** Reasons from resolveClientAddress() / planDelivery() that mean "we have nowhere safe to send this". */
const NO_ADDRESS = [/no email address on file/i, /no safe email on file/i, /no destination address/i];
const STAFF_NO_EMAIL = /user has no email/i;

export function planFollowup(row: OutboxLike): FollowupPlan | null {
  if (row.channel !== "email") return null;
  const toClient = row.recipientType === "party";
  if (row.status === "bounced") {
    return toClient
      ? {
          kind: "bounced",
          notify: "lawyer",
          flagType: FLAG_TYPES.deliveryBounced,
          title: "Email to the client bounced",
          summary: "An email notice to the client bounced. The portal copy is still there. Please confirm a safe email address with the client.",
        }
      : {
          kind: "bounced",
          notify: "admin",
          flagType: FLAG_TYPES.deliveryBounced,
          title: "Email to a firm user bounced",
          summary: "An internal alert email bounced. The in-app notification was still delivered. Please check the user's email address.",
        };
  }
  if (row.status === "failed") {
    return {
      kind: "failed",
      notify: "admin",
      flagType: FLAG_TYPES.deliveryFailed,
      title: toClient ? "Email to a client could not be sent" : "Alert email could not be sent",
      summary: `The email provider failed after several attempts (${row.lastError ?? "no detail"}). The in-app notification was still delivered.`,
    };
  }
  if (row.status === "suppressed") {
    if (toClient && NO_ADDRESS.some((re) => re.test(row.lastError ?? ""))) {
      return {
        kind: "suppressed_no_address",
        notify: "lawyer",
        flagType: FLAG_TYPES.noSafeAddress,
        title: "Client has no safe email address",
        summary: `A notice was delivered only in the portal: ${row.lastError}. Please ask the client for a safe email address.`,
      };
    }
    if (!toClient && STAFF_NO_EMAIL.test(row.lastError ?? "")) {
      return {
        kind: "email_missing",
        notify: "admin",
        flagType: FLAG_TYPES.deliveryFailed,
        title: "A firm user has no email address",
        summary: "An alert could only be delivered in the app because the user has no email address.",
      };
    }
  }
  return null;
}

/** Is the daily digest due? Once per local day, at or after the firm's digest time. */
export function digestDue(lastRunAt: Date | null, now: Date, timeZone: string, timeLocal: string): boolean {
  const [h, m] = timeLocal.split(":").map(Number) as [number, number];
  const l = toLocal(now, timeZone);
  const todayAt = fromLocal(l.year, l.month, l.day, h, m, timeZone);
  if (now.getTime() < todayAt.getTime()) return false;
  return lastRunAt === null || lastRunAt.getTime() < todayAt.getTime();
}

/** The digest email for one user (internal; minimal detail by default). */
export function composeDigest(items: ReadonlyArray<{ title: string; severity: string; resolved: boolean }>, firmName: string): { subject: string; body: string } {
  const lines = items.map((i) => `- [${i.severity.toUpperCase()}] ${i.title}${i.resolved ? " (since resolved)" : ""}`);
  return {
    subject: `${firmName}: ${items.length} alert${items.length === 1 ? "" : "s"} in your daily digest`,
    body: `Non-urgent alerts since your last digest:\n\n${lines.join("\n")}\n\nOpen the app to see details. Urgent alerts are always emailed straight away.`,
  };
}
