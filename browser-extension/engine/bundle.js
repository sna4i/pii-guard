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
    console.error(
      "[pii-guard] engine bundle: missing submodule(s):",
      missing.join(", ")
    );
    engine.ready = false;
    return;
  }
  engine.ready = true;
  engine.version = "phase1-0.1.0";
  console.info(
    "[pii-guard] engine ready (phase1, standalone), version",
    engine.version
  );
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
