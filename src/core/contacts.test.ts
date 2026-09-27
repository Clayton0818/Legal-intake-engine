import { describe, it, expect } from "vitest";
import { normalizeName, resolveClientAddress, type ContactPoints } from "./contacts";

const contact = (over: Partial<ContactPoints> = {}): ContactPoints => ({
  email: "ana@shared.example",
  phone: "+15125550100",
  safeContact: {},
  dvSensitive: false,
  ...over,
});

describe("normalizeName", () => {
  it("lowercases, strips accents and punctuation, collapses spaces", () => {
    expect(normalizeName("  María-José  O'Brien ")).toBe("maria jose o brien");
    expect(normalizeName("GARCÍA   LÓPEZ")).toBe("garcia lopez");
  });
});

describe("resolveClientAddress (safe contact, c42/c51/c103)", () => {
  it("prefers the client's chosen safe email", () => {
    expect(resolveClientAddress(contact({ safeContact: { safeEmail: "safe@x.example" } }), "email")).toEqual({
      deliver: true,
      address: "safe@x.example",
    });
  });

  it("falls back to the email on file for non-DV clients", () => {
    expect(resolveClientAddress(contact(), "email")).toEqual({ deliver: true, address: "ana@shared.example" });
    expect(resolveClientAddress(contact({ email: null, emails: ["", "alt@x.example"] }), "email")).toEqual({
      deliver: true,
      address: "alt@x.example",
    });
  });

  it("never uses a DV-sensitive client's unsafe address", () => {
    const r = resolveClientAddress(contact({ dvSensitive: true }), "email");
    expect(r.deliver).toBe(false);
    const sms = resolveClientAddress(contact({ dvSensitive: true, safeContact: { smsConsentAt: "2026-01-01" } }), "sms");
    expect(sms.deliver).toBe(false);
  });

  it("respects email switched off, and sensitive-by-email off", () => {
    expect(resolveClientAddress(contact({ safeContact: { emailAllowed: false } }), "email").deliver).toBe(false);
    const prefs = contact({ safeContact: { sensitiveByEmail: false } });
    expect(resolveClientAddress(prefs, "email", { sensitive: true }).deliver).toBe(false);
    expect(resolveClientAddress(prefs, "email").deliver).toBe(true);
  });

  it("requires documented SMS consent and prefers the safe phone", () => {
    expect(resolveClientAddress(contact(), "sms")).toMatchObject({ deliver: false });
    expect(
      resolveClientAddress(contact({ safeContact: { smsConsentAt: "2026-01-01", safePhone: "+15125550199" } }), "sms")
    ).toEqual({ deliver: true, address: "+15125550199" });
    expect(resolveClientAddress(contact({ safeContact: { smsConsentAt: "2026-01-01", smsAllowed: false } }), "sms").deliver).toBe(false);
  });

  it("explains when nothing is on file", () => {
    expect(resolveClientAddress(contact({ email: null }), "email")).toEqual({ deliver: false, reason: "No email address on file." });
  });
});
