// Service worker — MV3 background entry point (ES module).
//
// Responsibilities:
// 1. Keep a per-tab count of masked detections and surface it on the
//    action badge.
// 2. Respond to popup queries for "how many masks on tab X".
// 3. Seed ``chrome.storage.local.enabled`` to ``true`` on install so
//    the content script can assume the key exists.
// 4. Reset per-tab counters on navigation / tab close so the badge
//    doesn't carry stale numbers across page boundaries.
// 5. Proxy LLM_FETCH calls to the user-configured Ollama endpoint
//    (host-locked, sender-id-checked).
// 6. Lazy-load transformers.js and serve ML_DETECT inference requests
//    from the bundled distilbert-multilingual-ner-hrl model.
//
// MV3 service workers are ephemeral — any in-memory state is wiped
// when the worker sleeps. The badge itself is persisted by Chrome, so
// that's fine, but ``tabCounts`` below lives in memory and will reset
// after ~30s of inactivity. That's acceptable for a detection counter
// (the user is either actively interacting or the data is stale).
//
// The ML pipeline cache (``mlPipeline``) is also in memory only — if
// the SW sleeps mid-session, the next ML_DETECT will rebuild it from
// the on-disk model cache (transformers.js IndexedDB). The fresh
// build is fast (~1-2s) since the WASM + weights are already on disk.

// ML inference is hosted in an offscreen document, NOT in this
// service worker. Reason: onnxruntime-web internally uses dynamic
// `import()` to load its WASM threading worker, which the HTML spec
// forbids on `ServiceWorkerGlobalScope`. An offscreen document is a
// hidden DOM-bearing extension context where dynamic imports are
// allowed; see browser-extension/offscreen.{html,js}.
//
// The SW's role for ML is reduced to:
//   1. Lazily create the offscreen document on first ML_DETECT /
//      ML_PREWARM.
//   2. Forward the message there with target:"offscreen".
//   3. Relay the offscreen response back to the original sender.
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  if (
    typeof chrome.offscreen?.hasDocument === "function" &&
    (await chrome.offscreen.hasDocument())
  ) {
    return;
  }
  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }
  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    // "WORKERS" is the documented justification for hosting code that
    // can't run in the service worker because of platform restrictions
    // (here: dynamic import in the WASM backend).
    reasons: ["WORKERS"],
    justification:
      "Run transformers.js NER pipeline (ONNX Runtime Web) for in-browser PII detection. " +
      "The WASM backend uses dynamic import which is forbidden in service workers.",
  });
  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

async function relayToOffscreen(payload) {
  await ensureOffscreenDocument();
  // The offscreen listener filters on target:"offscreen" so the SW's
  // own onMessage listener doesn't catch the relay and infinite-loop.
  return chrome.runtime.sendMessage({ target: "offscreen", ...payload });
}

const BADGE_BG_OK = "#2166cc";
const BADGE_BG_WARN = "#b84a00";

/** Per-tab detection counts. Keyed by tab id. */
const tabCounts = new Map();

function updateBadge(tabId, count) {
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: count > 0 ? BADGE_BG_OK : BADGE_BG_WARN,
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  // Ensure all three keys exist so every subsequent read is a plain
  // ``storage.get(key)`` without a fallback branch. Defaults:
  //   * ``enabled``     true — the master switch.
  //   * ``interactive`` true — review-before-send is the headline UX.
  //   * ``uiMode``      "sidebar" — Milestone 8 Wave B default;
  //                     legacy modal experience is opt-in.
  const stored = await chrome.storage.local.get([
    "enabled",
    "interactive",
    "uiMode",
    // The Chrome Web Store variant has no `http://*/*` host permission
    // and ships no LLM UI, so these keys are stripped from the
    // default-value migration too.
    "localLlmEnabled",
    "localLlmMode",
    "localLlmTimeoutMs",
  ]);
  const patch = {};
  if (typeof stored.enabled !== "boolean") patch.enabled = true;
  if (typeof stored.interactive !== "boolean") patch.interactive = true;
  if (stored.uiMode !== "sidebar" && stored.uiMode !== "modal") {
    patch.uiMode = "sidebar";
  }
  if (typeof stored.localLlmEnabled !== "boolean") patch.localLlmEnabled = false;
  if (stored.localLlmMode !== "detect" && stored.localLlmMode !== "replace") {
    patch.localLlmMode = "detect";
  }
  if (typeof stored.localLlmTimeoutMs !== "number") patch.localLlmTimeoutMs = 120000;
  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "DETECTION_COUNT") {
    // Content script reports "N detections on this page fetch" after
    // each intercepted request.
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId === "number") {
      const prev = tabCounts.get(tabId) || 0;
      const next = prev + (message.count || 0);
      tabCounts.set(tabId, next);
      updateBadge(tabId, next);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_TAB_COUNT") {
    // Popup asking for a single tab's counter.
    const tabId = typeof message.tabId === "number" ? message.tabId : null;
    sendResponse({ count: (tabId !== null && tabCounts.get(tabId)) || 0 });
    return true;
  }

  // The Chrome Web Store variant has no `http://*/*` host permission
  // so LAN/localhost fetches would be impossible anyway. We strip the
  // handler from the Store bundle to eliminate any reviewer concern
  // about the extension attempting to reach `http://localhost:*`.
  //
  // v0.5.0 — LLM fetch proxy. Chrome's Private Network Access (PNA)
  // blocks HTTPS-page content scripts from calling http://localhost,
  // even with host_permissions. The service worker is in a privileged
  // context and is not subject to the same mixed-content restriction,
  // so we route all LLM calls here.
  if (message.type === "LLM_FETCH") {
    (async () => {
      // [CRITICAL] Sender-origin + URL host lock.
      // The SW must not be usable as a general proxy. We require:
      //   (1) the message comes from our own extension (popup /
      //       options) or from a content script injected by us;
      //   (2) the requested URL's host matches the user-configured
      //       localLlmUrl host — no other host is ever reachable via
      //       this handler.
      if (sender && sender.id && sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: "forbidden: foreign sender" });
        return;
      }
      const { url, method, body, timeoutMs } = message;
      let requested;
      try {
        requested = new URL(url);
      } catch (_) {
        sendResponse({ ok: false, error: "bad url" });
        return;
      }
      const { localLlmUrl } = await chrome.storage.local.get("localLlmUrl");
      if (!localLlmUrl) {
        sendResponse({ ok: false, error: "llm url not configured" });
        return;
      }
      let configured;
      try {
        configured = new URL(localLlmUrl);
      } catch (_) {
        sendResponse({ ok: false, error: "stored llm url invalid" });
        return;
      }
      if (
        requested.host !== configured.host ||
        requested.protocol !== configured.protocol
      ) {
        sendResponse({
          ok: false,
          error: `forbidden: host mismatch (${requested.host} vs ${configured.host})`,
        });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || 120000);
      try {
        const resp = await fetch(requested.toString(), {
          method: method || "GET",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body || undefined,
          signal: controller.signal,
        });
        const status = resp.status;
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status, body: text });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      } finally {
        clearTimeout(timer);
      }
    })();
    return true; // keep the channel open for async response
  }

  // ML_DETECT / ML_PREWARM — relay to the offscreen document. The SW
  // does not run inference itself; see ensureOffscreenDocument() above
  // for the rationale. Skip messages the offscreen has already
  // re-targeted at itself (target:"offscreen") so the relay doesn't
  // bounce in a loop.
  if (
    (message.type === "ML_DETECT" || message.type === "ML_PREWARM") &&
    message.target !== "offscreen"
  ) {
    (async () => {
      if (sender && sender.id && sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: "forbidden: foreign sender" });
        return;
      }
      try {
        const resp = await relayToOffscreen({
          type: message.type,
          text: typeof message.text === "string" ? message.text : "",
        });
        sendResponse(resp || { ok: false, error: "no response from offscreen" });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});

// Reset a tab's counter when the user navigates to a new top-level
// URL. ``tabs.onUpdated`` works with the ``activeTab`` permission we
// already request, so no extra host/perm grants are needed. We key
// on the ``loading`` status of a URL change to capture both full
// reloads and client-side navigations that rewrite ``tab.url``.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // ``changeInfo.url`` fires on every URL mutation, including SPA
  // pushState navigations. Resetting there keeps the badge meaningful
  // as the user moves between chats in Claude.ai / ChatGPT.
  if (typeof changeInfo.url === "string") {
    tabCounts.delete(tabId);
    updateBadge(tabId, 0);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCounts.delete(tabId);
});
