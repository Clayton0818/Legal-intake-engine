/*
 * c38 — embeddable intake widget loader.
 *
 * On the firm's site:
 *   <script src="https://<app>/widget/embed.js" data-widget-key="wk_…" async></script>
 * Optional: data-label="Chat with us" data-color="#1d4ed8" data-position="right|left".
 *
 * It adds a launcher button and, on click, an iframe pointing at
 * https://<app>/widget/frame.html. All intake traffic happens INSIDE the
 * iframe, on the app's own origin — the host page never sees the caller's
 * answers, and the app needs no CORS. Self-contained classic script (no
 * modules, no dependencies) so it works with a plain <script> tag.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__legalIntakeWidgetLoaded) return;
  window.__legalIntakeWidgetLoaded = true;

  var MESSAGE_SOURCE = "legal-intake-widget";
  var ds = script.dataset || {};
  var key = String(ds.widgetKey || "").trim();
  if (!/^wk_[0-9a-f]{32}_[A-Za-z0-9_-]{32}$/.test(key)) {
    if (window.console) console.warn("[intake widget] missing or invalid data-widget-key; widget not loaded.");
    return;
  }
  var appOrigin;
  try {
    appOrigin = new URL(script.src).origin;
  } catch {
    return;
  }
  var color = /^#[0-9a-fA-F]{3,8}$/.test(ds.color || "") ? ds.color : "#1d4ed8";
  var side = ds.position === "left" ? "left" : "right";
  var label = ds.label ? String(ds.label).slice(0, 40) : "Chat with us";

  var params = new URLSearchParams({ key: key, v: "1", host: window.location.origin });
  var frameUrl = appOrigin + "/widget/frame.html#" + params.toString();

  var root = document.createElement("div");
  root.setAttribute("data-legal-intake-widget", "");
  root.style.cssText = "position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;font-family:system-ui,sans-serif;";

  var button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-expanded", "false");
  button.style.cssText =
    "background:" + color + ";color:#fff;border:0;border-radius:999px;padding:12px 18px;font-size:15px;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.2);cursor:pointer;";

  var panel = null;

  function open() {
    if (!panel) {
      panel = document.createElement("iframe");
      panel.src = frameUrl;
      panel.title = label;
      panel.setAttribute("allow", "clipboard-write");
      panel.style.cssText =
        "display:block;width:min(380px,calc(100vw - 40px));height:min(600px,calc(100vh - 100px));border:0;" +
        "border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);background:#fff;margin-bottom:12px;";
      root.insertBefore(panel, button);
    }
    panel.style.display = "block";
    button.setAttribute("aria-expanded", "true");
  }

  function close() {
    if (panel) panel.style.display = "none";
    button.setAttribute("aria-expanded", "false");
    button.focus();
  }

  button.addEventListener("click", function () {
    if (panel && panel.style.display !== "none") close();
    else open();
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== appOrigin || !event.data || event.data.source !== MESSAGE_SOURCE) return;
    if (event.data.type === "close") close();
  });

  root.appendChild(button);
  (document.body || document.documentElement).appendChild(root);
})();
