import { describe, expect, it } from "vitest";
import { generateWidgetKey, hashWidgetSecret, normalizeAllowedOrigin, originAllowed, parseWidgetKey, validateAllowedOrigins } from "./keys";
import { tenantForWidgetKey } from "./embeds";
import {
  buildFrameUrl,
  errorText,
  initialState,
  inputForChoice,
  isWidgetMessage,
  parseEmbedConfig,
  parseFrameHash,
  reduce,
  sessionStorageKey,
  summaryForForm,
  type WidgetPrompt,
} from "../../public/widget/core.js";

const TENANT = "11111111-2222-4333-8444-555555555555";

describe("widget keys", () => {
  it("round-trips the tenant and hashes only the secret", () => {
    const { key, keyHash } = generateWidgetKey(TENANT);
    const parsed = parseWidgetKey(key)!;
    expect(parsed.tenantId).toBe(TENANT);
    expect(hashWidgetSecret(parsed.secret)).toBe(keyHash);
    expect(keyHash).not.toContain(parsed.secret);
    expect(tenantForWidgetKey(key)).toBe(TENANT);
  });
  it("rejects malformed keys", () => {
    expect(parseWidgetKey("wk_123_abc")).toBeNull();
    expect(parseWidgetKey(null)).toBeNull();
    expect(() => generateWidgetKey("not-a-uuid")).toThrow();
  });
});

describe("origin allowlist", () => {
  it("normalises entries and rejects junk", () => {
    expect(normalizeAllowedOrigin("HTTPS://Firm.com/")).toBe("https://firm.com");
    expect(normalizeAllowedOrigin("http://firm.com")).toBeNull();
    expect(normalizeAllowedOrigin("https://*")).toBeNull();
    expect(normalizeAllowedOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(validateAllowedOrigins(["https://a.com", "https://a.com", "javascript:x", ""])).toEqual({ origins: ["https://a.com"], invalid: ["javascript:x"] });
  });
  it("matches exact origins and one-label wildcards only", () => {
    const allowed = ["https://firm.com", "https://*.firm.org"];
    expect(originAllowed("https://firm.com", allowed)).toBe(true);
    expect(originAllowed("https://firm.com:8443", allowed)).toBe(false);
    expect(originAllowed("http://firm.com", allowed)).toBe(false);
    expect(originAllowed("https://www.firm.org", allowed)).toBe(true);
    expect(originAllowed("https://firm.org", allowed)).toBe(false);
    expect(originAllowed("https://a.b.firm.org", allowed)).toBe(false);
    expect(originAllowed("https://evilfirm.org", allowed)).toBe(false);
    expect(originAllowed(null, allowed)).toBe(false);
  });
});

describe("widget core (public/widget/core.js)", () => {
  const KEY = `wk_${"a".repeat(32)}_${"B".repeat(32)}`;

  it("parses loader config defensively", () => {
    expect(parseEmbedConfig({ widgetKey: KEY, color: "red;background:url(x)", position: "left" }, "https://app.test/widget/embed.js")).toEqual({
      key: KEY,
      appOrigin: "https://app.test",
      color: "#1d4ed8",
      position: "left",
      label: "Chat with us",
    });
    expect(parseEmbedConfig({ widgetKey: "nope" }, "bad url").key).toBeNull();
  });

  it("puts the key in the fragment and reads it back", () => {
    const url = buildFrameUrl("https://app.test", KEY, "https://firm.com");
    expect(url.startsWith("https://app.test/widget/frame.html#")).toBe(true);
    expect(parseFrameHash(new URL(url).hash)).toEqual({ key: KEY, host: "https://firm.com" });
    expect(parseFrameHash("#key=junk").key).toBeNull();
  });

  it("accepts postMessages only from the expected origin with our marker", () => {
    expect(isWidgetMessage({ origin: "https://app.test", data: { source: "legal-intake-widget", type: "close" } }, "https://app.test")).toBe(true);
    expect(isWidgetMessage({ origin: "https://evil.test", data: { source: "legal-intake-widget", type: "close" } }, "https://app.test")).toBe(false);
    expect(isWidgetMessage({ origin: "https://app.test", data: "close" }, "https://app.test")).toBe(false);
  });

  it("maps choices exactly like the /chat widget", () => {
    const p = (node: string, kind: WidgetPrompt["kind"]): WidgetPrompt => ({ node, kind, message: "", final: false });
    expect(inputForChoice(p("x", "confirm"), { value: "yes", label: "Yes" })).toEqual({ confirmed: true });
    expect(inputForChoice(p("classify_practice_area", "single_choice"), { value: "mediation", label: "M" })).toEqual({ manualPracticeArea: "mediation" });
    expect(inputForChoice(p("language_routing", "single_choice"), { value: "es", label: "ES" })).toEqual({ language: "es" });
    expect(inputForChoice(p("classify_caller", "single_choice"), { value: "new_client", label: "N" })).toEqual({ callerType: "new_client" });
    expect(summaryForForm({ fullName: "A", email: "", phone: "1" })).toBe("A · 1");
    expect(summaryForForm({})).toBe("Submitted.");
  });

  it("isolates sessions per key and hides server errors", () => {
    expect(sessionStorageKey(KEY)).not.toBe(sessionStorageKey(`wk_${"b".repeat(32)}_${"B".repeat(32)}`));
    expect(errorText(400, { error: "Invalid input." })).toBe("Invalid input.");
    expect(errorText(500, { error: "db password=x" })).not.toContain("password");
  });

  it("reduces chat state", () => {
    const prompt: WidgetPrompt = { node: "classify_caller", kind: "single_choice", message: "Hi", final: false };
    let s = reduce(initialState(), { type: "started", sessionId: "s1", prompt });
    s = reduce(s, { type: "sending", text: "New client" });
    expect(s.loading).toBe(true);
    s = reduce(s, { type: "answered", prompt: { ...prompt, message: "Done", final: true } });
    expect(s.messages.map((m) => m.from)).toEqual(["bot", "caller", "bot"]);
    expect(s.ended).toBe(true);
    expect(reduce(s, { type: "failed", error: "x" }).error).toBe("x");
  });
});
