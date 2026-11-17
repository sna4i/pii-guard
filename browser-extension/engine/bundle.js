// engine/bundle.js — launcher. Verifies every submodule attached
// itself to window.__localMaskMCP.engine and flips engine.ready true.
// injected.js checks engine.ready before dispatching standalone calls.
"use strict";

(function launcher() {
  const ns = (window.__localMaskMCP = window.__localMaskMCP || {});
  const engine = (ns.engine = ns.engine || {});

  const required = [
    "patterns",
    "classification",
    "severity",
    "categories",
    "aggregate",
    "forceMask",
    "blocklist",
    "maskAggregated",
    "maskSanitize",
  ];
  const missing = required.filter((k) => typeof engine[k] === "undefined");
  if (missing.length > 0) {
    // 動作ログ (docs/diagnostic-log.md)。isolated world と拡張機能のページでは直接、
    // ページの世界では content script 経由で残す。コンソールには書かない
    try {
      if (window.PiiGuardDiagLog) window.PiiGuardDiagLog.log("engine.unavailable", { where: "engine-load" });
      else window.postMessage({ source: "mask-mcp-inpage", type: "diag-log", entry: { code: "engine.unavailable", d: { where: "engine-load" } } }, "*");
    } catch (_) { /* 何もしない */ }
    engine.ready = false;
    return;
  }
  engine.ready = true;
  engine.version = "phase1-0.1.0";
  try {
    window.dispatchEvent(
      new CustomEvent("mask-mcp:engine-ready", {
        detail: { version: engine.version },
      })
    );
  } catch (_) {
    // CustomEvent unavailable → injected.js polling path takes over.
  }
})();
