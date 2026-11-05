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
//
// つなぎ直し (docs/release-1.7.1.md の D-SC-32〜D-SC-35): Chrome は、拡張機能の Service Worker を 30 秒ほど
// 出来事が無いと止める。止まるとポートは切れ、SW の組も消える。切れたら自分でつなぎ直す (connect が SW を起こす)。
// SW に「置き換えた」と知らされたとき (同じタブに同じ役割の新しい部品がつながった) と、拡張機能そのものが
// 入れ替わった (chrome.runtime.id を読めない) ときは、つなぎ直さない。
"use strict";

(function attach(root) {
  const RETRY_FIRST_MS = 50;     // 切れてから、つなぎ直すまでの最初の待ち
  const RETRY_MAX_MS = 5000;     // 続けて切れるたびに倍にする待ちの上限
  const STABLE_MS = 5000;        // これより長く続いたあとに切れたら、待ちを最初に戻す
  const READY_WAIT_MS = 5000;    // 頼みを送る前に、相手がそろうのを待つ上限 (D-SC-33)

  function isRuntime() {
    return typeof chrome !== "undefined" && chrome && chrome.runtime && typeof chrome.runtime.connect === "function";
  }
  // 拡張機能が生きているか (読み込み直し・更新・オフのあとは id を読めない)
  function runtimeAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
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
    const readyWaiters = new Set();     // 相手がそろうのを待っている頼み
    let peerReady = false;
    let retired = false;                // SW が新しいポートに置き換えた / 自分で切った。つなぎ直さない
    let retryMs = 0;
    let retryTimer = 0;
    let connectedAt = 0;

    function wire() {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
      if (port || retired || !runtimeAlive()) return;
      let p;
      try { p = chrome.runtime.connect({ name: role }); } catch (_) { scheduleRetry(); return; }
      port = p;
      connectedAt = Date.now();
      p.onMessage.addListener(onMessage);
      p.onDisconnect.addListener(() => {
        try { void chrome.runtime.lastError; } catch (_) { /* 読むだけ */ }
        if (port !== p) return;
        port = null; peerReady = false;
        // 送ったあとに切れた頼みは失敗にする。届いたかが分からないので送り直さない (二重送信を避ける)
        for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve({ ok: false, error: "disconnected" }); }
        pending.clear();
        scheduleRetry();
      });
      // SW にペアリングを促す handshake。相手が揃うと {__sc:"peer-ready"} が返る。
      try { p.postMessage({ __sc: "hello", role }); } catch (_) {}
    }
    // 切れたあとのつなぎ直し (D-SC-32)。50ms から始め、続けて切れるたびに倍にする (5 秒まで)
    function scheduleRetry() {
      if (retired || retryTimer || port || !runtimeAlive()) return;
      const stable = connectedAt && Date.now() - connectedAt > STABLE_MS;
      retryMs = !retryMs || stable ? RETRY_FIRST_MS : Math.min(retryMs * 2, RETRY_MAX_MS);
      retryTimer = setTimeout(wire, retryMs);
    }
    // 相手がそろうのを待つ (D-SC-33)。そろっていれば true。ms たってもそろわなければ false
    function whenReady(ms) {
      if (port && peerReady) return Promise.resolve(true);
      if (retired || !runtimeAlive()) return Promise.resolve(false);
      if (!port) wire(); // 待たずに、すぐつなぎ直す
      return new Promise((resolve) => {
        const w = { resolve, timer: 0 };
        w.timer = setTimeout(() => { readyWaiters.delete(w); resolve(false); }, ms);
        readyWaiters.add(w);
      });
    }

    async function onMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.__sc === "peer-ready") {
        peerReady = true;
        for (const w of readyWaiters) { clearTimeout(w.timer); w.resolve(true); }
        readyWaiters.clear();
        for (const fn of readyFns) { try { fn(); } catch (_) {} }
        return;
      }
      if (msg.__sc === "peer-gone") { peerReady = false; return; }
      if (msg.__sc === "retired") { retired = true; return; } // 同じ役割の新しい部品がつながった (D-SC-35)
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
      // 応答を待つ要求。相手がそろっていなければ (つなぎ直している途中)、そろうまで待ってから送る (D-SC-33)
      request(type, payload, timeoutMs = 15000) {
        return whenReady(Math.min(timeoutMs, READY_WAIT_MS)).then((ready) => new Promise((resolve) => {
          if (!ready || !port) { resolve({ ok: false, error: port ? "no peer" : "no port" }); return; }
          const id = `${role}-${++seq}`;
          const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: "timeout" }); } }, timeoutMs);
          pending.set(id, { resolve, timer });
          try { port.postMessage({ __scReq: true, id, type, payload: payload === undefined ? null : payload }); }
          catch (e) { clearTimeout(timer); pending.delete(id); resolve({ ok: false, error: String((e && e.message) || e) }); }
        }));
      },
      // 応答不要の通知。切れていたら、すぐつなぎ直す (この通知は届かない。そろったら相手が今の状態を送り直す、D-SC-34)
      post(type, payload) {
        if (!port) { wire(); return; }
        try { port.postMessage({ __scReq: true, type, payload: payload === undefined ? null : payload }); } catch (_) {}
      },
      disconnect() {
        retired = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
        if (port) { const p = port; port = null; peerReady = false; try { p.disconnect(); } catch (_) {} }
      },
    };
  }

  const api = { connect };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") { root.__piiGuardSC = root.__piiGuardSC || {}; root.__piiGuardSC.boundary = api; }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
