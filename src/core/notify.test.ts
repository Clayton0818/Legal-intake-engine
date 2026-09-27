import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  assertMinimalClientPayload,
  CHANNEL_GATES,
  planDelivery,
  processOutboxRow,
  renderNotification,
  retryDelayMs,
  StubProvider,
  type EmailProvider,
  type OutboxRowContext,
  type SendResult,
} from "./notify";
import { NOTIFY_COPY_GATES } from "@/compliance/gates";
import { isPlaceholder, resetApprovalStateForTests, setApprovals, setBlockedActionSink, type ApprovalRecord } from "@/compliance/approvals";
import { fromLocal } from "./businessHours";
import type { ContactPoints } from "./contacts";

const chi = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi, "America/Chicago");
const NOW = chi(2026, 9, 25, 10);

function approve(...records: Array<Omit<ApprovalRecord, "approvedAt" | "approvedByName">>) {
  setApprovals(records.map((r) => ({ approvedAt: NOW, approvedByName: "Reviewer", ...r })));
}

const flagCopy = NOTIFY_COPY_GATES.flagUpdate;

beforeEach(() => {
  resetApprovalStateForTests();
  setBlockedActionSink(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("assertMinimalClientPayload (c51 minimal content)", () => {
  it("allows ids only", () => {
    expect(() => assertMinimalClientPayload({ flagId: "f", taskId: "t" })).not.toThrow();
    expect(() => assertMinimalClientPayload({ flagId: "f", amountOwed: 1200 })).toThrow(/amountOwed/);
  });
});

describe("planDelivery", () => {
  const party = (over: Partial<ContactPoints> = {}) => ({
    type: "party" as const,
    contact: { email: "ana@home.example", phone: "+15125550100", safeContact: {}, dvSensitive: false, ...over },
  });

  it("in-app rows are delivered on insert", () => {
    expect(planDelivery({ channel: "in_app", recipient: party(), now: NOW }).status).toBe("delivered");
  });

  it("staff email goes to the user's address; staff SMS is suppressed", () => {
    expect(planDelivery({ channel: "email", recipient: { type: "user", email: "l@firm.example" }, now: NOW })).toMatchObject({
      status: "pending",
      address: "l@firm.example",
    });
    expect(planDelivery({ channel: "sms", recipient: { type: "user", email: "l@firm.example" }, now: NOW }).status).toBe("suppressed");
    expect(
      planDelivery({ channel: "email", recipient: { type: "user", email: "l@firm.example", status: "disabled" }, now: NOW }).status
    ).toBe("suppressed");
  });

  it("uses the client's safe address, and never a DV-sensitive client's unsafe one", () => {
    expect(planDelivery({ channel: "email", recipient: party({ safeContact: { safeEmail: "safe@x.example" } }), now: NOW }).address).toBe(
      "safe@x.example"
    );
    const dv = planDelivery({ channel: "email", recipient: party({ dvSensitive: true }), now: NOW });
    expect(dv.status).toBe("suppressed");
    expect(dv.reason).toMatch(/DV-sensitive/);
  });

  it("honours 'no sensitive email' for sensitive notices", () => {
    const p = party({ safeContact: { sensitiveByEmail: false } });
    expect(planDelivery({ channel: "email", recipient: p, now: NOW, sensitive: true }).status).toBe("suppressed");
    expect(planDelivery({ channel: "email", recipient: p, now: NOW }).status).toBe("pending");
  });

  it("requires documented SMS consent", () => {
    expect(planDelivery({ channel: "sms", recipient: party(), now: NOW }).reason).toMatch(/consent/);
    const ok = planDelivery({ channel: "sms", recipient: party({ safeContact: { smsConsentAt: "2026-09-01T00:00:00Z" } }), now: NOW });
    expect(ok).toMatchObject({ status: "pending", address: "+15125550100" });
  });

  it("delays non-urgent client messages until quiet hours end; urgent ones go now", () => {
    const quiet = { window: { start: "21:00", end: "08:00" }, timeZone: "America/Chicago" };
    const late = chi(2026, 9, 25, 22);
    expect(planDelivery({ channel: "email", recipient: party(), now: late, quiet }).notBefore).toEqual(chi(2026, 9, 26, 8));
    expect(planDelivery({ channel: "email", recipient: party(), now: late, quiet, urgent: true }).notBefore).toBeNull();
  });
});

describe("renderNotification", () => {
  const partyRow = { recipientType: "party", templateKey: flagCopy.key, payload: { flagId: "f-1" } };
  const ctx = { firmName: "Smith Family Law", portalUrl: "https://portal.example" };

  it("shows the visible placeholder until the client wording is approved", () => {
    const r = renderNotification(partyRow, ctx);
    expect(r.approved).toBe(false);
    expect(isPlaceholder(r.text)).toBe(true);
    expect(r.pendingGate).toBe(flagCopy.key);
  });

  it("renders the approved wording with the subject line split out", () => {
    approve({ gateKey: flagCopy.key, reviewerKind: "attorney", draftHash: flagCopy.draftHash });
    const r = renderNotification(partyRow, ctx);
    expect(r.approved).toBe(true);
    expect(r.subject).toBe("An update on your matter with Smith Family Law");
    expect(r.text).toContain("https://portal.example");
    expect(r.text).not.toContain("Subject:");
  });

  it("staff messages use the payload subject/body", () => {
    const r = renderNotification({ recipientType: "user", templateKey: "flag.internal", payload: { subject: "S", body: "B" } }, ctx);
    expect(r).toEqual({ subject: "S", text: "B", approved: true, pendingGate: null });
  });
});

describe("processOutboxRow (worker drain, one row)", () => {
  const baseRow = {
    id: "n-1",
    channel: "email",
    recipientType: "user",
    recipientAddress: "lawyer@firm.example",
    templateKey: "flag.internal",
    payload: { subject: "Overdue", body: "Task overdue" },
    attempts: 0,
    notBefore: null,
    flagId: "f-1",
    matterId: null,
  };

  function ctx(email: EmailProvider = new StubProvider()): OutboxRowContext {
    const stub = new StubProvider();
    return {
      tenantId: "t-1",
      now: NOW,
      firmName: "Smith Family Law",
      settings: { emailFromAddress: "office@smithfamilylaw.example", emailReplyTo: null, clientPortalUrl: null },
      providers: { email, sms: stub },
    };
  }

  class FakeProvider implements EmailProvider {
    readonly name = "fake";
    readonly isStub = false;
    sent: unknown[] = [];
    constructor(private readonly result: SendResult | Error) {}
    async sendEmail(message: unknown): Promise<SendResult> {
      if (this.result instanceof Error) throw this.result;
      this.sent.push(message);
      return this.result;
    }
  }

  it("in-app rows are simply marked delivered", async () => {
    const out = await processOutboxRow({ ...baseRow, channel: "in_app" }, ctx());
    expect(out).toEqual({ result: "delivered", set: { status: "delivered", deliveredAt: NOW } });
  });

  it("HOLDS email while the vendor DPA gate is pending — the provider is never called", async () => {
    const provider = new FakeProvider({ outcome: "sent", providerMessageId: "m-1" });
    const out = await processOutboxRow(baseRow, ctx(provider));
    expect(out.result).toBe("held");
    expect(out.set.lastError).toContain(`gate: ${CHANNEL_GATES.email}`);
    expect(provider.sent).toHaveLength(0);
  });

  it("with the gate approved, the stub provider records and still holds", async () => {
    approve({ gateKey: CHANNEL_GATES.email, reviewerKind: "vendor_dpa" });
    const stub = new StubProvider();
    const out = await processOutboxRow(baseRow, ctx(stub));
    expect(out.result).toBe("held");
    expect(stub.recorded).toHaveLength(1);
    expect(stub.recorded[0]?.message).toMatchObject({ to: "lawyer@firm.example", subject: "Overdue" });
  });

  it("never sends placeholder client wording, even when the vendor is approved", async () => {
    approve({ gateKey: CHANNEL_GATES.email, reviewerKind: "vendor_dpa" });
    const provider = new FakeProvider({ outcome: "sent" });
    const out = await processOutboxRow(
      { ...baseRow, recipientType: "party", templateKey: flagCopy.key, payload: { flagId: "f-1" } },
      ctx(provider)
    );
    expect(out.result).toBe("held");
    expect(out.set.lastError).toMatch(/Client wording pending review/);
    expect(provider.sent).toHaveLength(0);
  });

  it("sends through a real provider once vendor and wording are approved, and audits it", async () => {
    approve(
      { gateKey: CHANNEL_GATES.email, reviewerKind: "vendor_dpa" },
      { gateKey: flagCopy.key, reviewerKind: "attorney", draftHash: flagCopy.draftHash }
    );
    const provider = new FakeProvider({ outcome: "sent", providerMessageId: "m-42" });
    const out = await processOutboxRow(
      { ...baseRow, recipientType: "party", recipientAddress: "safe@x.example", templateKey: flagCopy.key, payload: { flagId: "f-1" } },
      ctx(provider)
    );
    expect(out.result).toBe("sent");
    expect(out.set).toMatchObject({ status: "sent", providerMessageId: "m-42", attempts: 1, provider: "fake" });
    expect(out.audit?.action).toBe("notification.sent");
    expect(provider.sent[0]).toMatchObject({ to: "safe@x.example", fromName: "Smith Family Law" });
  });

  it("suppresses rows with no destination", async () => {
    approve({ gateKey: CHANNEL_GATES.email, reviewerKind: "vendor_dpa" });
    const out = await processOutboxRow({ ...baseRow, recipientAddress: null }, ctx());
    expect(out.result).toBe("suppressed");
  });

  it("retries failures with backoff, then gives up and audits", async () => {
    approve({ gateKey: CHANNEL_GATES.email, reviewerKind: "vendor_dpa" });
    const provider = new FakeProvider(new Error("provider down"));
    const first = await processOutboxRow(baseRow, ctx(provider));
    expect(first.set).toMatchObject({ status: "pending", attempts: 1, lastError: "provider down" });
    expect(first.set.notBefore).toEqual(new Date(NOW.getTime() + retryDelayMs(1)));
    expect(first.audit).toBeUndefined();

    const last = await processOutboxRow({ ...baseRow, attempts: 4 }, ctx(provider));
    expect(last.set.status).toBe("failed");
    expect(last.audit?.action).toBe("notification.failed");
  });

  it("the SMS channel is gated separately (vendor DPA + attorney for TCPA)", async () => {
    approve({ gateKey: CHANNEL_GATES.email, reviewerKind: "vendor_dpa" }, { gateKey: CHANNEL_GATES.sms, reviewerKind: "vendor_dpa" });
    const out = await processOutboxRow({ ...baseRow, channel: "sms", recipientAddress: "+15125550100" }, ctx());
    expect(out.result).toBe("held");
    expect(out.set.lastError).toContain("PENDING ATTORNEY REVIEW");
  });
});

describe("retryDelayMs", () => {
  it("grows quadratically in minutes", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 240_000, 540_000, 960_000]);
  });
});
