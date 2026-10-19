// secure-composer/privacy-boundary.js — Secure Composer iframe と content script (ISOLATED world) の
// 間の、ページから偽装できない通信路。
//
// なぜ postMessage ではなくこれか:
//   iframe は拡張オリジン、content script はページの ISOLATED world。両者を postMessage でつなぐと、
//   event.origin はどちらもページのオリジンになり、ページ MAIN world のスクリプトと区別できない
//   (ページも同じ iframe に postMessage できる)。そこで chrome.runtime.connect のポートを使う。
//   ポートはページ JS からは作れず、SW 側で port.sender (tab/frameId/url/id) を検証できる。
//
// 経路: iframe ──connect(sc-iframe)──▶ SW ◀──connect(sc-content)── content script
//   SW が同じ tabId のポートをペアにして中継する (background.js の pairing バス)。
//   このモジュールは SW につなぎ、相手側へ届くメッセージを request/response + event で包むだけ。
"use strict";

(function attach(root) {
  function isRuntime() {
    return typeof chrome !== "undefined" && chrome && chrome.runtime && typeof chrome.runtime.connect === "function";
  }

  /**
   * @param {"sc-iframe"|"sc-content"} role
   * @returns {{ request, on, post, onReady, disconnect, connected }}
   */
  function connect(role) {
    if (!isRuntime()) throw new Error("privacy-boundary: chrome.runtime unavailable");
    let port = null;
    let seq = 0;
    const pending = new Map();          // id -> {resolve, timer}
    const handlers = new Map();         // type -> fn(payload) => maybe Promise
    const readyFns = new Set();
    let peerReady = false;

    function wire() {
      port = chrome.runtime.connect({ name: role });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => {
        port = null; peerReady = false;
        for (const { resolve } of pending.values()) resolve({ ok: false, error: "disconnected" });
        pending.clear();
      });
      // SW にペアリングを促す handshake。相手が揃うと {type:"__peer"} が返る。
      try { port.postMessage({ __sc: "hello", role }); } catch (_) {}
    }

    async function onMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.__sc === "peer-ready") { peerReady = true; for (const fn of readyFns) { try { fn(); } catch (_) {} } return; }
      if (msg.__sc === "peer-gone") { peerReady = false; return; }
      // 相手からの応答
      if (msg.__scRes && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer); pending.delete(msg.id);
        resolve(msg.error ? { ok: false, error: msg.error } : { ok: true, result: msg.result });
        return;
      }
      // 相手からの要求/通知
      if (msg.__scReq) {
        const fn = handlers.get(msg.type);
        if (!fn) { if (msg.id && port) port.postMessage({ __scRes: true, id: msg.id, error: "no handler: " + msg.type }); return; }
        try {
          const result = await fn(msg.payload);
          if (msg.id && port) port.postMessage({ __scRes: true, id: msg.id, result: result === undefined ? null : result });
        } catch (e) {
          if (msg.id && port) port.postMessage({ __scRes: true, id: msg.id, error: String((e && e.message) || e) });
        }
      }
    }

    wire();

    return {
      connected() { return !!port; },
      onReady(fn) { if (peerReady) { try { fn(); } catch (_) {} } readyFns.add(fn); return () => readyFns.delete(fn); },
      on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); },
      // 応答を待つ要求
      request(type, payload, timeoutMs = 15000) {
        return new Promise((resolve) => {
          if (!port) { resolve({ ok: false, error: "no port" }); return; }
          const id = `${role}-${++seq}`;
          const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: "timeout" }); } }, timeoutMs);
          pending.set(id, { resolve, timer });
          try { port.postMessage({ __scReq: true, id, type, payload: payload === undefined ? null : payload }); }
          catch (e) { clearTimeout(timer); pending.delete(id); resolve({ ok: false, error: String((e && e.message) || e) }); }
        });
      },
      // 応答不要の通知
      post(type, payload) { if (port) { try { port.postMessage({ __scReq: true, type, payload: payload === undefined ? null : payload }); } catch (_) {} } },
      disconnect() { if (port) { try { port.disconnect(); } catch (_) {} port = null; } },
    };
  }

  const api = { connect };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") { root.__piiGuardSC = root.__piiGuardSC || {}; root.__piiGuardSC.boundary = api; }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
