// c38 — framework-free core of the embeddable intake widget. Pure functions
// only (no DOM), shared by frame.js and embed.js and unit-tested from
// src/widget/core.test.ts. Types: ./core.d.ts.
//
// Plain ES2017 module, served as-is from /widget/core.js: no build step, no
// dependencies. Keep it small.

export const WIDGET_VERSION = "1";
export const MESSAGE_SOURCE = "legal-intake-widget";

/** Widget keys look like wk_<32 hex>_<32 base64url>. */
export function isWidgetKey(value) {
  return typeof value === "string" && /^wk_[0-9a-f]{32}_[A-Za-z0-9_-]{32}$/.test(value);
}

/** Read the loader's data-* attributes into a config object. */
export function parseEmbedConfig(dataset, scriptSrc) {
  const key = dataset && dataset.widgetKey ? String(dataset.widgetKey).trim() : "";
  let appOrigin = null;
  try {
    appOrigin = new URL(scriptSrc).origin;
  } catch {
    appOrigin = null;
  }
  const color = dataset && /^#[0-9a-fA-F]{3,8}$/.test(dataset.color || "") ? dataset.color : "#1d4ed8";
  const position = dataset && dataset.position === "left" ? "left" : "right";
  const label = dataset && dataset.label ? String(dataset.label).slice(0, 40) : "Chat with us";
  return { key: isWidgetKey(key) ? key : null, appOrigin, color, position, label };
}

/** URL of the iframe page for a key (key in the fragment, so it never reaches server logs). */
export function buildFrameUrl(appOrigin, key, hostOrigin) {
  const params = new URLSearchParams({ key: key, v: WIDGET_VERSION });
  if (hostOrigin) params.set("host", hostOrigin);
  return appOrigin + "/widget/frame.html#" + params.toString();
}

/** Parse the frame's own fragment. */
export function parseFrameHash(hash) {
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  const key = params.get("key");
  return { key: isWidgetKey(key) ? key : null, host: params.get("host") };
}

/** Only accept postMessages from the expected origin carrying our marker. */
export function isWidgetMessage(event, expectedOrigin) {
  return Boolean(
    event &&
      event.origin === expectedOrigin &&
      event.data &&
      typeof event.data === "object" &&
      event.data.source === MESSAGE_SOURCE &&
      typeof event.data.type === "string"
  );
}

/**
 * The input body for a choice button — mirrors IntakeChatWidget's mapping so
 * both front ends drive the same intake API identically.
 */
export function inputForChoice(prompt, option) {
  if (prompt.kind === "confirm") return { confirmed: option.value === "yes" };
  if (prompt.node === "classify_practice_area") return { manualPracticeArea: option.value };
  if (prompt.node === "language_routing") return { language: option.value };
  return { callerType: option.value };
}

/** The echo shown for a submitted contact form. */
export function summaryForForm(values) {
  const parts = [values.fullName, values.email, values.phone].filter(function (v) {
    return typeof v === "string" && v.trim();
  });
  return parts.length ? parts.join(" · ") : "Submitted.";
}

/** Free-text input body. */
export function inputForText(text) {
  return { practiceAreaFreeText: text };
}

/** localStorage key per widget key, so two firms' widgets never share a session. */
export function sessionStorageKey(widgetKey) {
  return "legal-intake:widget:" + String(widgetKey).slice(3, 15) + ":session";
}

export const GENERIC_ERROR = "Something went wrong. Please try again, or contact the firm directly.";
export const START_ERROR = "We couldn't start your intake right now. Please try again later or contact the firm directly.";

/** Map an API error response to caller-safe text (never a raw server message beyond the API's own user-facing `error`). */
export function errorText(status, body) {
  if (body && typeof body.error === "string" && status >= 400 && status < 500) return body.error;
  return GENERIC_ERROR;
}

/** Pure chat state reducer. */
export function initialState() {
  return { messages: [], prompt: null, sessionId: null, loading: true, error: null, ended: false };
}

export function reduce(state, action) {
  switch (action.type) {
    case "started":
    case "resumed":
      return Object.assign({}, state, {
        sessionId: action.sessionId,
        prompt: action.prompt,
        loading: false,
        error: null,
        ended: Boolean(action.prompt && action.prompt.final),
        messages: state.messages.concat([{ from: "bot", text: action.prompt.message }]),
      });
    case "sending":
      return Object.assign({}, state, {
        loading: true,
        error: null,
        messages: state.messages.concat([{ from: "caller", text: action.text }]),
      });
    case "answered":
      return Object.assign({}, state, {
        prompt: action.prompt,
        loading: false,
        ended: Boolean(action.prompt.final),
        messages: state.messages.concat([{ from: "bot", text: action.prompt.message }]),
      });
    case "failed":
      return Object.assign({}, state, { loading: false, error: action.error });
    default:
      return state;
  }
}
