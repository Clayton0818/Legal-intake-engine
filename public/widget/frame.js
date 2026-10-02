// c38 — the widget's iframe page logic. Runs on the app's own origin and
// talks to the existing intake API (/api/intake/sessions…) exactly like the
// /chat page does. All text is rendered with textContent (never innerHTML).
import {
  GENERIC_ERROR,
  MESSAGE_SOURCE,
  START_ERROR,
  errorText,
  initialState,
  inputForChoice,
  inputForText,
  parseFrameHash,
  reduce,
  sessionStorageKey,
  summaryForForm,
} from "./core.js";

const API = "/api/intake";
// Shown only when the notice endpoint isn't reachable: the same visible
// placeholder legalCopy() renders while the gate is pending.
const NOTICE_FALLBACK =
  "[PENDING ATTORNEY REVIEW — Embeddable intake widget notice (not legal advice; no attorney-client relationship yet) (gate: copy.platform.widget_notice)]";

const $ = (id) => document.getElementById(id);
const { key, host: hashHost } = parseFrameHash(window.location.hash);
const ancestors = window.location.ancestorOrigins;
// ancestorOrigins is browser-provided (not spoofable by the parent); the hash value is a fallback.
const host = ancestors && ancestors.length > 0 ? ancestors[0] : hashHost;

let state = initialState();

function dispatch(action) {
  state = reduce(state, action);
  render();
}

function headers(json) {
  const h = { "x-widget-key": key || "" };
  if (host) h["x-widget-host"] = host;
  if (json) h["content-type"] = "application/json";
  return h;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function loadConfig() {
  try {
    const qs = new URLSearchParams({ key: key || "" });
    if (host) qs.set("host", host);
    const res = await fetch("/api/widget/config?" + qs.toString(), { headers: headers(false) });
    const body = await readJson(res);
    if (res.ok && body) {
      $("notice").textContent = body.notice;
      if (body.firmName) $("title").textContent = "Talk to " + body.firmName;
      return true;
    }
    if (body && body.reason) {
      dispatch({ type: "failed", error: body.error || "This chat is not available on this site." });
      return false;
    }
  } catch {
    /* fall through to the placeholder notice */
  }
  $("notice").textContent = NOTICE_FALLBACK;
  return true;
}

async function start() {
  if (!key) {
    dispatch({ type: "failed", error: "This chat is not set up correctly." });
    return;
  }
  if (!(await loadConfig())) return;
  const store = storage();
  const storeKey = sessionStorageKey(key);
  try {
    const existing = store && store.getItem(storeKey);
    if (existing) {
      const res = await fetch(API + "/sessions/" + encodeURIComponent(existing), { headers: headers(false) });
      if (res.ok) {
        const data = await res.json();
        dispatch({ type: "resumed", sessionId: data.id, prompt: data.prompt });
        return;
      }
    }
    const res = await fetch(API + "/sessions", { method: "POST", headers: headers(false) });
    const data = await readJson(res);
    if (!res.ok || !data) {
      dispatch({ type: "failed", error: data && data.error ? data.error : START_ERROR });
      return;
    }
    if (store) {
      try {
        store.setItem(storeKey, data.id);
      } catch {
        /* private mode: session won't resume after reload */
      }
    }
    dispatch({ type: "started", sessionId: data.id, prompt: data.prompt });
  } catch {
    dispatch({ type: "failed", error: START_ERROR });
  }
}

async function submit(input, echo) {
  if (!state.sessionId) return;
  dispatch({ type: "sending", text: echo });
  try {
    const res = await fetch(API + "/sessions/" + encodeURIComponent(state.sessionId) + "/messages", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ input }),
    });
    const data = await readJson(res);
    if (!res.ok || !data) {
      dispatch({ type: "failed", error: errorText(res.status, data) });
      return;
    }
    dispatch({ type: "answered", prompt: data.prompt });
  } catch {
    dispatch({ type: "failed", error: GENERIC_ERROR });
  }
}

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInput(footer, prompt) {
  if (prompt.kind === "single_choice" || prompt.kind === "confirm") {
    const wrap = el("div", { class: "choices" });
    for (const opt of prompt.options || []) {
      const b = el("button", { type: "button" }, opt.label);
      b.addEventListener("click", () => submit(inputForChoice(prompt, opt), opt.label));
      wrap.appendChild(b);
    }
    footer.appendChild(wrap);
    return;
  }
  if (prompt.kind === "form") {
    const form = el("form", { class: "stack" });
    for (const f of prompt.fields || []) {
      const type = f.type === "email" || f.type === "tel" ? f.type : "text";
      form.appendChild(el("input", { name: f.name, type, placeholder: f.label, "aria-label": f.label }));
    }
    form.appendChild(el("button", { type: "submit", class: "primary" }, "Continue"));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = {};
      for (const f of prompt.fields || []) values[f.name] = form.elements.namedItem(f.name).value;
      submit(values, summaryForForm(values));
    });
    footer.appendChild(form);
    return;
  }
  const form = el("form", { class: "row" });
  const ta = el("textarea", { rows: "2", placeholder: "Type your answer…", "aria-label": "Your answer" });
  form.appendChild(ta);
  form.appendChild(el("button", { type: "submit", class: "primary" }, "Send"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (text) submit(inputForText(text), text);
  });
  footer.appendChild(form);
  ta.focus();
}

function render() {
  const log = $("log");
  log.replaceChildren(...state.messages.map((m) => el("div", { class: "msg " + m.from }, m.text)));
  log.scrollTop = log.scrollHeight;

  const err = $("error");
  err.textContent = state.error || "";
  err.style.display = state.error ? "block" : "none";

  const footer = $("input");
  footer.replaceChildren();
  if (state.loading) footer.appendChild(el("p", { class: "muted" }, "…"));
  else if (state.ended) footer.appendChild(el("p", { class: "muted" }, "This conversation is complete."));
  else if (state.prompt) renderInput(footer, state.prompt);
}

$("close").addEventListener("click", () => {
  if (window.parent !== window) window.parent.postMessage({ source: MESSAGE_SOURCE, type: "close" }, host || "*");
});

render();
start();
