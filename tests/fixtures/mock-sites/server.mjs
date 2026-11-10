// tests/fixtures/mock-sites/server.mjs — Claude / Gemini / Manus / 解析ツール / 対象外サイトを名乗るローカルの HTTPS サーバ。
//
// ブラウザは --host-resolver-rules で各ホスト名をこのサーバに向ける。content script は本物の URL に注入される。
// 送信の形は docs/security/other-providers-status.md と tests/engine/egress-guard.test.mjs の実測の構造をまねる:
//   Claude  POST /claudeai-rpc/<pkg>.ConversationService/PerformAction (application/proto) 本文 root.2.3、添付 root.2.15
//           POST /api/organizations/<org>/chat_conversations/<id>/completion (JSON の prompt、以前の形)
//   Gemini  POST /_/BardChatUi/data/processSession (WebChannel のフォーム、Base64 の protobuf、本文 root.2.9.1)
//   Manus   WebSocket /socket.io/ の 42["message",{type:"user_message",content}]。解析ツール (api2.amplitude.com) が
//           入力欄のクリックで要素の文字を送る (LK-03 の再現)
// 受け取った通信はすべて記録する (実際に届いたもの)。
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const HOSTS = ["claude.ai", "gemini.google.com", "manus.im", "api.manus.im", "api2.amplitude.com", "example.org"];

function makeCert(dir) {
  const crt = path.join(dir, "server.crt");
  const key = path.join(dir, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", crt, "-days", "1", "-nodes",
    "-subj", "/CN=claude.ai", "-addext", `subjectAltName=${HOSTS.map((h) => "DNS:" + h).join(",")}`], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

function acceptWebSocket(req, socket, onText) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  // Engine.IO の open と Socket.IO の connect (中身は使わない)
  const frame = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([0x81, b.length]), b]); };
  socket.write(frame('0{"sid":"qa","upgrades":[],"pingInterval":25000,"pingTimeout":20000}'));
  socket.write(frame("40"));
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

// ---- ページ ------------------------------------------------------------------------------------
const COMMON_JS = `
window.QA = { events: [], log(type, data) { this.events.push({ t: Date.now(), type, ...(data || {}) }); } };
window.addEventListener("error", (e) => QA.log("page-error", { message: String(e.message) }));
window.PB = (() => {
  const te = new TextEncoder();
  const cat = (...p) => { const n = p.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return Uint8Array.from(out); };
  const str = (num, s) => { const v = typeof s === "string" ? te.encode(s) : s; return cat(varint(num * 8 + 2), varint(v.length), v); };
  const msg = (num, ...f) => str(num, cat(...f));
  const vint = (num, n) => cat(varint(num * 8), varint(n));
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  return { cat, varint, str, msg, vint, b64 };
})();
window.addThread = (text, who) => {
  const t = document.getElementById("thread");
  const d = document.createElement("div"); d.className = "msg " + (who || "user"); d.textContent = text; t.appendChild(d);
  t.scrollTop = t.scrollHeight;
};
// スクロールできるだけの会話を置く (サイドバーの開け閉めでスクロール位置が保たれるかを見る)
window.seedThread = () => { for (let i = 1; i <= 24; i++) addThread("これまでの会話 " + i + " 行目。架空の内容です。", i % 2 ? "user" : "bot"); };
`;

const BASE_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;font-size:16px}
.app{display:flex;flex-direction:column;height:100vh}
header{height:48px;flex:none;display:flex;align-items:center;gap:8px;padding:0 16px}
#thread{flex:1;min-height:0;overflow-y:auto;padding:16px;width:100%;max-width:768px;margin:0 auto}
.msg{padding:8px 12px;margin:6px 0;border-radius:12px;white-space:pre-wrap}
.msg.user{margin-left:20%}
`;

const claudePage = () => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Claude</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${BASE_CSS}
body{background:#faf9f5;color:#141413}
header{border-bottom:1px solid #e8e6dc}
.msg.user{background:#f0eee6}
.composer{width:calc(100% - 32px);max-width:768px;margin:0 auto 16px;flex:none}
.box{background:#fff;border:1px solid #dedcd1;border-radius:16px;padding:12px 14px;box-shadow:0 2px 8px rgba(0,0,0,.04);margin:0;min-width:0}
.ProseMirror{min-height:24px;max-height:240px;overflow-y:auto;outline:none;line-height:24px;word-break:break-word}
.ProseMirror p{margin:0}
.bar{display:flex;align-items:center;gap:8px;margin-top:10px}
.ib{width:32px;height:32px;border-radius:8px;border:1px solid #dedcd1;background:transparent;color:inherit;flex:none}
.model{margin-left:auto;height:32px;border:0;background:transparent;color:inherit}
.send{width:32px;height:32px;border-radius:8px;background:#c6613f;color:#fff;border:0;flex:none}
@media (prefers-color-scheme:dark){body{background:#262624;color:#faf9f5}header{border-color:#3d3d3a}.msg.user{background:#141413}.box{background:#30302e;border-color:#4a4945}.ib{border-color:#4a4945}}
</style></head><body><div class="app"><header><strong>Claude</strong><span>(QA mock)</span></header>
<div id="thread"></div>
<div class="composer"><fieldset class="box">
<div contenteditable="true" class="ProseMirror" role="textbox" aria-label="Claude にプロンプトを入力" translate="no"><p><br></p></div>
<div class="bar"><button type="button" class="ib" id="cl-plus" aria-label="ファイルを追加">+</button><input type="file" id="cl-file" multiple hidden>
<button type="button" class="model" id="cl-model">Claude (mock) ⌄</button>
<button type="button" class="send" id="cl-send" aria-label="メッセージを送信">↑</button></div>
</fieldset></div></div>
<script src="/qa/common.js"></script><script src="/qa/claude.js"></script></body></html>`;

const CLAUDE_JS = `
seedThread();
const ed = document.querySelector(".ProseMirror");
const files = [];
const mode = new URLSearchParams(location.search).get("send") || "rpc";
document.getElementById("cl-plus").onclick = () => document.getElementById("cl-file").click();
document.getElementById("cl-file").addEventListener("change", async (e) => {
  for (const f of e.target.files) files.push({ name: f.name, size: f.size, type: f.type || "text/plain", text: await f.text().catch(() => "") });
  QA.log("attached", { names: files.map((f) => f.name), texts: files.map((f) => f.text) });
  e.target.value = "";
});
const draft = () => ed.innerText.replace(/\\n+$/, "");
ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
document.getElementById("cl-send").onclick = () => send();
async function send() {
  const text = draft();
  if (!text.trim()) return;
  QA.log("send-start", { mode });
  try {
    let r;
    if (mode === "json") {
      r = await fetch("/api/organizations/00000000-0000-4000-8000-000000000000/chat_conversations/11111111-1111-4111-8111-111111111111/completion",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: text, timezone: "Asia/Tokyo", attachments: [], files: [] }) });
    } else {
      const att = files.map((f) => PB.msg(15, PB.str(1, f.name), PB.vint(2, f.size), PB.str(3, f.type), PB.str(4, f.text)));
      const body = PB.cat(
        PB.msg(1, PB.str(1, "sess_00000000-0000-0000-0000-000000000000")),
        PB.msg(2, PB.str(1, "00000000-0000-0000-0000-000000000001"), PB.str(2, "00000000-0000-0000-0000-000000000002"),
          PB.str(3, text), PB.msg(7, PB.str(2, "claude-qa-model")), ...att, PB.str(12, "Asia/Tokyo"), PB.str(13, "ja"), PB.vint(18, 1)));
      r = await fetch("/claudeai-rpc/anthropic.claudeai.v1.ConversationService/PerformAction", { method: "POST", headers: { "content-type": "application/proto" }, body });
    }
    QA.log("sent", { status: r.status });
    addThread(text, "user"); addThread("(mock) 受け取りました", "bot");
    ed.innerHTML = "<p><br></p>"; files.length = 0;
  } catch (err) { QA.log("send-failed", { message: String((err && err.message) || err) }); }
}
`;

// Gemini: 白い箱 (角の丸み 32px、影) は入力欄の 9 段上の祖先 (2026-10-28 にログインなしの実サイトで調べた作り。
// tests/integration/e2e-composer-toggle.mjs の geminiLikePage と同じ)
const geminiPage = () => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Gemini</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${BASE_CSS}
body{background:#fff;color:#1f1f1f}
.msg.user{background:#e9eef6;border-radius:24px}
.wrap{width:calc(100% - 48px);max-width:760px;margin:0 auto 24px;flex:none}
.pill{background:#f0f4f9;border-radius:32px;padding:12px 16px}
.row{display:flex;align-items:center;gap:8px}
.ib{width:40px;height:40px;border:0;border-radius:50%;background:transparent;color:inherit;font-size:18px;flex:none}
#gm-mode{height:40px;border:0;background:transparent;color:inherit;font-size:14px;padding:0 12px;flex:none}
rich-textarea{display:block;flex:1;min-width:0}
.ql-editor{min-height:24px;max-height:200px;overflow-y:auto;outline:none;line-height:24px;word-break:break-word}
.ql-editor p{margin:0}
.send-button{width:40px;height:40px;border-radius:50%;border:0;background:#0b57d0;color:#fff;flex:none}
@media (prefers-color-scheme:dark){body{background:#131314;color:#e3e3e3}.msg.user{background:#333537}.pill{background:#1e1f20}}
@media (max-width:480px){#gm-mode{display:none}.wrap{width:calc(100% - 16px)}}
</style></head><body><div class="app"><header><strong>Gemini</strong><span>(QA mock)</span></header>
<div id="thread"></div>
<div class="wrap"><div class="container"><div class="pill" id="gm-pill"><div><div><div class="row">
<button type="button" class="ib" id="gm-plus" aria-label="ファイルをアップロード">+</button><input type="file" id="gm-file" hidden>
<div style="flex:1;min-width:0"><div><div><div><rich-textarea><div class="ql-editor textarea" contenteditable="true" role="textbox" aria-label="Gemini にプロンプトを入力" data-placeholder="Gemini に相談"><p><br></p></div></rich-textarea></div></div></div></div>
<button type="button" id="gm-mode">高速モード ⌄</button><button type="button" class="ib" id="gm-mic" aria-label="マイク">🎤</button>
<button type="button" class="send-button" id="gm-send" aria-label="プロンプトを送信">➤</button>
</div></div></div></div></div></div></div>
<script src="/qa/common.js"></script><script src="/qa/gemini.js"></script></body></html>`;

const GEMINI_JS = `
seedThread();
const ed = document.querySelector("rich-textarea .ql-editor");
const draft = () => ed.innerText.replace(/\\n+$/, "");
document.getElementById("gm-plus").onclick = () => document.getElementById("gm-file").click();
// 実物はファイルを選んだ瞬間に名前と中身をアップロードする (LK-05)
document.getElementById("gm-file").addEventListener("change", async (e) => {
  for (const f of e.target.files) {
    const text = await f.text().catch(() => "");
    QA.log("attached", { names: [f.name], texts: [text] });
    try { const r = await fetch("/_/upload?upload_id=qa", { method: "POST", headers: { "x-goog-upload-file-name": encodeURIComponent(f.name), "content-type": f.type || "application/octet-stream" }, body: f }); QA.log("uploaded", { status: r.status }); }
    catch (err) { QA.log("upload-failed", { message: String(err && err.message || err) }); }
  }
  e.target.value = "";
});
ed.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
document.getElementById("gm-send").onclick = () => send();
async function send() {
  const text = draft();
  if (!text.trim()) return;
  QA.log("send-start", {});
  try {
    const proto = PB.msg(2, PB.vint(1, 1), PB.msg(9, PB.str(1, text)));
    const body = "count=1&ofs=1&req0___data__=" + encodeURIComponent(PB.b64(proto));
    const r = await fetch("/_/BardChatUi/data/processSession?rt=c", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" }, body });
    QA.log("sent", { status: r.status });
    addThread(text, "user"); addThread("(mock) 受け取りました", "bot");
    ed.innerHTML = "<p><br></p>";
  } catch (err) { QA.log("send-failed", { message: String((err && err.message) || err) }); }
}
`;

const manusPage = () => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Manus</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${BASE_CSS}
body{background:#f8f8f7;color:#34322d}
.msg.user{background:#ebebea}
.composer{width:calc(100% - 32px);max-width:768px;margin:0 auto 16px;flex:none;background:#fff;border:1px solid #e2e2df;border-radius:22px;padding:12px}
#mn-input{width:100%;min-height:46px;max-height:216px;border:0;outline:none;resize:none;font:inherit;line-height:22px;background:transparent;color:inherit}
.bar{display:flex;align-items:center;gap:8px;margin-top:6px}
.ib{width:32px;height:32px;border-radius:50%;border:1px solid #e2e2df;background:transparent;color:inherit;flex:none}
.send{margin-left:auto;width:32px;height:32px;border-radius:50%;background:#1a1a19;color:#fff;border:0}
@media (prefers-color-scheme:dark){body{background:#272728;color:#dadada}.msg.user{background:#363537}.composer{background:#363537;border-color:#4a4a4a}.ib{border-color:#4a4a4a}}
</style></head><body><div class="app"><header><strong>Manus</strong><span>(QA mock)</span></header>
<div id="thread"></div>
<div class="composer"><textarea id="mn-input" placeholder="Manus にタスクを依頼" aria-label="Manus にタスクを依頼"></textarea>
<div class="bar"><button type="button" class="ib" id="mn-plus" aria-label="ファイルを追加">+</button><input type="file" id="mn-file" hidden>
<button type="button" class="ib" id="mn-mic" aria-label="音声入力">🎤</button>
<button type="button" class="send" id="mn-send" aria-label="送信">↑</button></div></div></div>
<script src="/qa/common.js"></script><script src="/qa/manus.js"></script></body></html>`;

const MANUS_JS = `
seedThread();
const ta = document.getElementById("mn-input");
const ws = new WebSocket("wss://" + location.host + "/socket.io/?EIO=4&transport=websocket");
ws.onopen = () => QA.log("ws-open", {}); ws.onerror = () => QA.log("ws-error", {});
// 自動計測 (Amplitude の Autocapture): クリックした要素の文字を送る (LK-03)
const amp = (ev) => {
  const payload = JSON.stringify({ api_key: "qa", events: [{ event_type: "[Amplitude] Element Clicked", event_properties: { "[Amplitude] Element Tag": ev.target.tagName.toLowerCase(), "[Amplitude] Element Text": (ev.target.value || ev.target.textContent || "").slice(0, 300) } }] });
  fetch("https://api2.amplitude.com/2/httpapi", { method: "POST", headers: { "content-type": "application/json" }, body: payload }).then((r) => QA.log("amp-fetch", { status: r.status })).catch((e) => QA.log("amp-fetch-failed", { message: String(e && e.message || e) }));
  try { QA.log("amp-beacon", { queued: navigator.sendBeacon("https://api2.amplitude.com/2/httpapi?beacon=1", payload) }); } catch (e) { QA.log("amp-beacon-failed", {}); }
};
ta.addEventListener("click", amp);
document.getElementById("mn-plus").onclick = () => document.getElementById("mn-file").click();
// 実物はファイルを選んだ瞬間に中身を GenerateDocumentSuggestion へ送る (LK-06)
document.getElementById("mn-file").addEventListener("change", async (e) => {
  for (const f of e.target.files) {
    const text = await f.text().catch(() => "");
    QA.log("attached", { names: [f.name], texts: [text] });
    try { const r = await fetch("https://api.manus.im/api.v1.DocumentService/GenerateDocumentSuggestion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: f.name, content: text }) }); QA.log("uploaded", { status: r.status }); }
    catch (err) { QA.log("upload-failed", { message: String(err && err.message || err) }); }
  }
  e.target.value = "";
});
ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
document.getElementById("mn-send").onclick = () => send();
function send() {
  const text = ta.value;
  if (!text.trim()) return;
  QA.log("send-start", {});
  try {
    ws.send("42" + JSON.stringify(["message", { id: "qa-" + Date.now(), timestamp: Date.now(), type: "user_message", content: text, messageType: "text" }]));
    QA.log("sent", {});
    addThread(text, "user"); addThread("(mock) 受け取りました", "bot");
    ta.value = "";
  } catch (err) { QA.log("send-failed", { message: String((err && err.message) || err) }); }
}
`;

const outOfScopePage = () => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>example</title></head><body>
<main style="max-width:640px;margin:40px auto"><h1>対象外のサイト</h1><textarea id="ta" rows="4" style="width:100%" aria-label="メモ"></textarea>
<button id="post" type="button">送る</button></main>
<script>document.getElementById("post").onclick = () => fetch("/post", { method: "POST", body: document.getElementById("ta").value });</script></body></html>`;

export async function startMockSites() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-qa-sites-"));
  const tls = makeCert(tmp);
  const requests = [];
  const wsFrames = [];
  const sockets = new Set();
  let seq = 0;
  const server = https.createServer(tls, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const host = String(req.headers.host || "").replace(/:\d+$/, "");
      const rec = { seq: ++seq, t: Date.now(), host, method: req.method, url: req.url, headers: { ...req.headers }, bytes: raw, body: raw.toString("utf8") };
      requests.push(rec);
      const p = req.url.split("?")[0];
      const send = (status, type, body, extra) => { res.writeHead(status, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*", ...(extra || {}) }); res.end(body); };
      if (req.method === "OPTIONS") return send(204, "text/plain", "", { "access-control-allow-headers": "*", "access-control-allow-methods": "POST, GET" });
      if (p === "/qa/common.js") return send(200, "text/javascript", COMMON_JS);
      if (host === "claude.ai") {
        if (p === "/qa/claude.js") return send(200, "text/javascript", CLAUDE_JS);
        if (req.method === "GET" && (p === "/" || p === "/new" || p.startsWith("/chat"))) return send(200, "text/html; charset=utf-8", claudePage());
        if (/ConversationService\/PerformAction$/.test(p)) { rec.kind = "claude-rpc"; return send(200, "application/proto", Buffer.alloc(0)); }
        if (/\/completion$/.test(p)) { rec.kind = "claude-json"; return send(200, "text/event-stream", 'event: completion\ndata: {"completion":"ok"}\n\n'); }
      }
      if (host === "gemini.google.com") {
        if (p === "/qa/gemini.js") return send(200, "text/javascript", GEMINI_JS);
        if (req.method === "GET" && (p === "/" || p.startsWith("/app"))) return send(200, "text/html; charset=utf-8", geminiPage());
        if (/\/processSession$/.test(p)) { rec.kind = "gemini-session"; return send(200, "text/plain", ")]}'\n[]"); }
        if (p === "/_/upload") { rec.kind = "gemini-upload"; return send(200, "application/json", '{"ok":true}'); }
      }
      if (host === "manus.im") {
        if (p === "/qa/manus.js") return send(200, "text/javascript", MANUS_JS);
        if (req.method === "GET" && (p === "/" || p.startsWith("/app"))) return send(200, "text/html; charset=utf-8", manusPage());
      }
      if (host === "api.manus.im" && /GenerateDocumentSuggestion$/.test(p)) { rec.kind = "manus-doc"; return send(200, "application/json", '{"ok":true}'); }
      if (host === "api2.amplitude.com") { rec.kind = "amplitude"; return send(200, "application/json", '{"code":200}'); }
      if (host === "example.org") {
        if (req.method === "GET" && p === "/") return send(200, "text/html; charset=utf-8", outOfScopePage());
        if (p === "/post") { rec.kind = "oos-post"; return send(200, "text/plain", "ok"); }
      }
      return send(404, "text/plain", "not found");
    });
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    if (host !== "manus.im" || !req.url.startsWith("/socket.io/")) { socket.destroy(); return; }
    acceptWebSocket(req, socket, (text) => wsFrames.push({ t: Date.now(), host, url: req.url, data: text }));
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    requests, wsFrames,
    byKind(kind, since = 0) { return requests.filter((r) => r.kind === kind && r.t >= since); },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
