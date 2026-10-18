// tests/fixtures/cdp-recorder.mjs — Chrome DevTools Protocol で「ブラウザから出ようとした通信」を記録する。
//
// Playwright とは別に、ブラウザ全体の DevTools 接続 (--remote-debugging-port) に直接つなぎ、
// Target.setAutoAttach (flatten) ですべての target (ページ・iframe (OOPIF)・Worker・
// Service Worker・拡張機能の service worker / offscreen) に Network.enable を掛ける。
// 記録するもの (spec 12.1 / 12.4):
//   Network.requestWillBeSent / requestWillBeSentExtraInfo / getRequestPostData /
//   responseReceived / loadingFailed (blockedReason, ERR_BLOCKED_BY_CLIENT) /
//   webSocketCreated / webSocketFrameSent
// 「発行の試み」(requestWillBeSent) と「ブラウザでの遮断」(loadingFailed) を分けて持つ。
// 実際にサーバへ届いたかは mock-chatgpt/server.mjs の記録と突き合わせる。
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readActivePort(userDataDir, timeoutMs = 15000) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const [port, wsPath] = fs.readFileSync(file, "utf8").trim().split("\n");
      if (port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    } catch (_) { /* not yet */ }
    await sleep(100);
  }
  throw new Error("DevToolsActivePort not found");
}

export async function startCdpRecorder(userDataDir) {
  const url = await readActivePort(userDataDir);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const sessions = new Map(); // sessionId -> { type, url, targetId }
  const requests = new Map(); // key(sessionId,requestId) -> record
  const wsFrames = [];
  const wsSockets = new Map();
  const errors = [];

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const keyOf = (sid, rid) => `${sid || "browser"}|${rid}`;

  async function enableOn(sessionId, info) {
    sessions.set(sessionId, { type: info.type, url: info.url, targetId: info.targetId });
    try {
      await send("Network.enable", { maxPostDataSize: 1 << 20 }, sessionId);
    } catch (e) { errors.push(`Network.enable(${info.type}): ${e.message}`); }
    try {
      await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    } catch (_) { /* some targets do not support nested auto-attach */ }
    try { await send("Runtime.runIfWaitingForDebugger", {}, sessionId); } catch (_) {}
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
      return;
    }
    const sid = msg.sessionId;
    const params = msg.params || {};
    switch (msg.method) {
      case "Target.attachedToTarget": {
        const info = params.targetInfo || {};
        enableOn(params.sessionId, info);
        break;
      }
      case "Target.detachedFromTarget":
        sessions.delete(params.sessionId);
        break;
      case "Network.requestWillBeSent": {
        const r = params.request || {};
        const k = keyOf(sid, params.requestId);
        const prev = requests.get(k);
        const rec = {
          sessionId: sid, target: sessions.get(sid) ? { ...sessions.get(sid) } : null,
          requestId: params.requestId, t: Date.now(), wallTime: params.wallTime,
          url: r.url, method: r.method, headers: { ...(r.headers || {}) },
          hasPostData: !!r.hasPostData, body: r.postData != null ? String(r.postData) : (prev && prev.body) || null,
          resourceType: params.type, initiator: params.initiator ? params.initiator.type : null,
          redirectedFrom: prev && params.redirectResponse ? prev.url : null,
          status: null, failed: null, extraHeaders: null,
        };
        requests.set(k, rec);
        if (rec.hasPostData && rec.body == null) {
          send("Network.getRequestPostData", { requestId: params.requestId }, sid)
            .then((d) => { rec.body = d && d.postData != null ? String(d.postData) : rec.body; })
            .catch(() => {});
        }
        break;
      }
      case "Network.requestWillBeSentExtraInfo": {
        const rec = requests.get(keyOf(sid, params.requestId));
        if (rec) rec.extraHeaders = { ...(params.headers || {}) };
        break;
      }
      case "Network.responseReceived": {
        const rec = requests.get(keyOf(sid, params.requestId));
        if (rec) rec.status = params.response ? params.response.status : null;
        break;
      }
      case "Network.loadingFailed": {
        const rec = requests.get(keyOf(sid, params.requestId));
        if (rec) rec.failed = { errorText: params.errorText, blockedReason: params.blockedReason || null, canceled: !!params.canceled };
        break;
      }
      case "Network.webSocketCreated":
        wsSockets.set(keyOf(sid, params.requestId), params.url);
        break;
      case "Network.webSocketFrameSent":
        wsFrames.push({ t: Date.now(), url: wsSockets.get(keyOf(sid, params.requestId)) || null, data: String(params.response && params.response.payloadData) });
        break;
      default:
        break;
    }
  };

  await send("Target.setDiscoverTargets", { discover: true });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos) {
    if (["page", "iframe", "worker", "service_worker", "shared_worker", "other"].includes(t.type) && !t.attached) {
      try { await send("Target.attachToTarget", { targetId: t.targetId, flatten: true }); } catch (_) {}
    }
  }

  return {
    errors,
    /** すべての記録 (古い順) */
    all() { return [...requests.values()].sort((a, b) => a.t - b.t); },
    /** chatgpt.com 宛て (ブラウザの外へ出ようとしたもの) */
    toHost(host = "chatgpt.com") {
      return this.all().filter((r) => { try { return new URL(r.url).host === host; } catch (_) { return false; } });
    },
    wsFrames,
    /** 記録を空にする (テストの区切り) */
    clear() { requests.clear(); wsFrames.length = 0; },
    /** 遅れて届く getRequestPostData の結果を待つ */
    async settle(ms = 300) { await sleep(ms); },
    async close() { try { ws.close(); } catch (_) {} },
  };
}
