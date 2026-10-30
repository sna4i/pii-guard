// tests/fixtures/mock-chatgpt/server.mjs — chatgpt.com を名乗るローカルの HTTPS サーバ (受信側の記録係)。
//
// ブラウザは --host-resolver-rules で chatgpt.com をこのサーバに向ける。拡張機能の
// content script は実物と同じ URL (https://chatgpt.com/*) に注入され、DNR の規則も
// 実物の URL に対して働く。このサーバが記録するのは「実際に届いた」通信だけなので、
// CDP で見えた発行の試み・ブラウザでの遮断と区別できる (spec 12.3 / 12.6)。
//
// 使い方 (テストと同じプロセスで):
//   const srv = await startMockChatGPT();
//   srv.port / srv.requests / srv.wsFrames / srv.mode.conversation = "error500" / await srv.close()
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ChatGPT</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{color-scheme:light dark}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;background:#fcfcfc;color:#0d0d0d}
@media (prefers-color-scheme: dark){body{background:#212121;color:#ececec}.surface{background:#303030!important}}
nav{display:flex;gap:12px;padding:8px 16px}
main{max-width:760px;margin:0 auto;padding:16px;display:flex;flex-direction:column;min-height:85vh}
#thread{flex:1}
.msg{padding:8px 12px;margin:6px 0;border-radius:12px;white-space:pre-wrap}
.msg.user{background:#e8e8e8;margin-left:20%}.msg.error{color:#b00}
.surface{background:#fff;border:1px solid #ddd;border-radius:28px;padding:10px 12px}
[data-composer-footer-responsive]{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:4px}
.ProseMirror{min-height:24px;outline:none;padding:6px 4px;line-height:24px}.ProseMirror p{margin:0}
.btn{height:36px;min-width:36px;border:0;background:transparent;color:inherit;border-radius:18px}
.btn.round.dark{background:#0d0d0d;color:#fff}
.pill{height:36px;border:0;background:transparent;color:inherit}
textarea#mobile-composer-prompt{width:100%;font:inherit;border:1px solid #ddd;border-radius:20px;padding:8px 12px;resize:none}
/* thread2026 (app.js の buildThread2026): 暗い表示、下に寄せた縦の並び。入力欄が伸びると箱ごと上に伸びる */
html.chatgpt-theme{background:#000}
/* 画面の高さちょうどに収める (上の nav のぶんも含めて、入力欄の下の段が画面の外に出ないように) */
body.v2026{background:#000;color:#ececec;height:100vh;display:flex;flex-direction:column;overflow:hidden}
body.v2026 main{flex:1;min-height:0;width:100%;box-sizing:border-box}
body.v2026 #thread{flex:1;min-height:0;overflow:auto}
body.v2026 .pill2026{background:rgb(48,48,48);border-radius:28px;padding:10px 12px}
body.v2026 .pill2026.translucent{background:rgba(255,255,255,0.05)}
body.v2026 .pill2026.oklch{background:oklch(1 0 0 / 0.05)}
body.v2026 [data-composer-footer-responsive][data-composer-rows=stacked]{display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto auto;align-items:center}
body.v2026 .AdaptiveFooterInput-zji599{grid-column:1 / -1;grid-row:1}
body.v2026 .footer-left{grid-column:1;grid-row:2}
body.v2026 .footer-right{grid-column:3;grid-row:2;display:flex;align-items:center;gap:4px}
body.v2026 .ProseMirror{color:#ececec}
/* 入力欄の親は、高さの上限を超えると入力欄を切り取ってスクロールする (2025 年の実物は親に max-h-52 と overflow-auto。
   2026 年の実物でどの段かは未確認) */
body.v2026 [data-composer-input-layout]{max-height:13rem;overflow-y:auto}
/* single2026 (app.js の buildSingle2026): 1 行の並び。入力欄の親は 1 行分 (36px) で切り取り、入力欄に min-height を
   付けても見えている範囲は増えない (2026-10-30 の利用者のスクショの症状から。実物の作りは未確認) */
body.v2026 [data-composer-footer-responsive][data-composer-rows=inline]{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:4px}
body.v2026 [data-composer-rows=inline] .footer-left{grid-column:1;grid-row:1}
body.v2026 [data-composer-rows=inline] .AdaptiveFooterInput-zji599{grid-column:2;grid-row:1}
body.v2026 [data-composer-rows=inline] .footer-right{grid-column:3;grid-row:1;display:flex;align-items:center;gap:4px}
body.v2026 [data-composer-input-layout=single-line]{max-height:36px;overflow:hidden}
</style></head>
<body><nav><a href="/" data-nav="new">新しいチャット</a><a href="/c/abc123" data-nav="c">会話A</a></nav>
<!-- 実物 (2026-10-18 ログイン後) と同じく、スレッド側の入れ物のクラス名にも "composer" を含む -->
<main><div class="relative flex group-has-[[data-expanded-composer]]/home-composer-layout:hidden" style="display:contents"><div id="thread"></div></div><div id="composer-root"></div></main>
<script src="/mock/app.js"></script></body></html>`;

const WORKER = `self.onmessage = (e) => { try { fetch("/ces/v1/w", { method: "POST", body: String(e.data) }); } catch (_) {} };`;

function makeCert(dir) {
  const crt = path.join(dir, "server.crt");
  const key = path.join(dir, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", crt,
    "-days", "1", "-nodes", "-subj", "/CN=chatgpt.com",
    "-addext", "subjectAltName=DNS:chatgpt.com,DNS:chat.openai.com"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

// 最小の WebSocket サーバ (クライアントのフレームを読んで記録するだけ)
function acceptWebSocket(req, socket, onText) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(need);
      if (op === 0x8) { socket.end(); return; }
      if (op === 0x1 || op === 0x2) onText(payload.toString("utf8"));
    }
  });
  socket.on("error", () => {});
}

/**
 * @param {{port?:number}} [opts]
 */
export async function startMockChatGPT(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-mock-"));
  const tls = makeCert(tmp);
  const requests = [];
  const wsFrames = [];
  const sockets = new Set();
  let seq = 0;
  const mode = { conversation: "ok", prepare: "ok", conversationDelayMs: 0 };
  let conduitSeq = 0;

  const server = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const rec = {
        seq: ++seq, t: Date.now(), method: req.method, url: req.url,
        headers: { ...req.headers }, body: raw.toString("utf8"), bodyBytes: raw.length,
      };
      requests.push(rec);
      const p = req.url.split("?")[0];
      const send = (status, type, body, extra) => {
        res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...(extra || {}) });
        res.end(body);
      };
      if (req.method === "GET" && (p === "/" || p.startsWith("/c/"))) return send(200, "text/html; charset=utf-8", PAGE);
      if (req.method === "GET" && p === "/mock/app.js") return send(200, "text/javascript", fs.readFileSync(path.join(HERE, "app.js")));
      if (req.method === "GET" && p === "/mock/worker.js") return send(200, "text/javascript", WORKER);
      if (/^\/backend-(api|anon)\/(f\/)?conversation\/prepare$/.test(p)) {
        rec.kind = "prepare";
        if (mode.prepare === "error500") return send(500, "application/json", '{"detail":"mock prepare error"}');
        return send(200, "application/json", JSON.stringify({ status: "ok", conduit_token: `mock-conduit-${++conduitSeq}` }));
      }
      if (/^\/backend-(api|anon)\/(f\/)?conversation$/.test(p) && req.method === "POST") {
        rec.kind = "conversation";
        const finish = () => {
          if (mode.conversation === "error500") return send(500, "application/json", '{"detail":"mock conversation error"}');
          if (mode.conversation === "drop") { req.socket.destroy(); return; }
          let parts = [];
          try { parts = JSON.parse(rec.body).messages[0].content.parts; } catch (_) {}
          const len = parts.map(String).join("").length;
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          res.write(`data: ${JSON.stringify({ message: { author: { role: "assistant" }, content: { parts: [`モックの応答 (受信 ${len} 文字)`] } } })}\n\n`);
          res.end("data: [DONE]\n\n");
        };
        if (mode.conversationDelayMs > 0) setTimeout(finish, mode.conversationDelayMs); else finish();
        return;
      }
      if (p === "/backend-api/files/content") { rec.kind = "files-content"; return send(200, "application/json", '{"ok":true}'); }
      if (p.startsWith("/ces/") || p.startsWith("/backend-api/events")) { rec.kind = "telemetry"; return send(204, "text/plain", ""); }
      if (p.startsWith("/cdn/")) return send(200, "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>");
      return send(404, "text/plain", "not found");
    });
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (!req.url.startsWith("/backend-api/ws")) { socket.destroy(); return; }
    acceptWebSocket(req, socket, (text) => wsFrames.push({ t: Date.now(), url: req.url, data: text }));
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => server.listen(opts.port || 0, "127.0.0.1", r));

  return {
    port: server.address().port,
    requests,
    wsFrames,
    mode,
    clear() { requests.length = 0; wsFrames.length = 0; mode.conversation = "ok"; mode.prepare = "ok"; mode.conversationDelayMs = 0; },
    byKind(kind) { return requests.filter((r) => r.kind === kind); },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** ローカル LLM (Ollama) を名乗る HTTP サーバ。届いた要求をすべて記録する。 */
export async function startMockLlm() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ t: Date.now(), method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ message: { role: "assistant", content: '{"entities":[]}' } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); },
  };
}
