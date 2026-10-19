// tests/integration/dryrun-send.mjs — 実サイトの「送信」を、ブラウザの外に出さずに試す (手動実行)。
//
// 使い方: 拡張を読み込んだ Chrome を --remote-debugging-port=<port> で起動し、対象サイトにログインしてから
//   node tests/integration/dryrun-send.mjs <claude|gemini|manus> [--port=9333] [--attach=<file>] [--drop=<file>] [--paste=<file>] [--extra=<語>] [--no-send] [--save-bodies=<dir>]
//
// 何をするか:
//   入力欄に架空の個人情報とカナリアを打ち、Enter で送る。サイトが出そうとした通信を全部その場で止め、
//   止めた本文に「生の個人情報」が残っていたか (= 拡張がマスクできていない) を調べる。
//   --attach を付けると、送る前にそのファイルを添付する (添付の中身・ファイル名がどう出るかを見る)。
//
// 何も外に出さないための仕組み (3 段):
//   1. ページ (MAIN world) の fetch / XHR / sendBeacon / WebSocket.send を、拡張のフックより「下」で包む
//      (Page.addScriptToEvaluateOnNewDocument は拡張の document_start より先に走る。起動時に順番を検査し、
//      違えば中止)。拡張がマスクした後の本文を受け取り、止める。
//        needle モード (既定): カナリア・架空の値を含む通信だけ止める (サイトは普通に動く)
//        strict モード (送信の瞬間だけ): GET 以外の通信と WebSocket の送信を全部止める
//          (圧縮やバイナリで中身を検査できない本文でも、外に出さない)
//   2. CDP の Fetch ドメインで、タブと子ターゲット (iframe・Worker) と同じサイトの Service Worker の
//      通信を、ネットワークに出る直前で同じ規則で止める (1 をすり抜けた経路の受け止め)。
//   3. 送った後は needle モードに戻してページを読み直し、しばらく見張る (未送信の再送を止める)。
//   拡張の設定は「確認画面なし (自動マスク)」に一時的に切り替え、終わったら元に戻す。
//
// 出力: 止めた通信ごとに、経路・宛先 (パスまで)・本文の形・カナリア/生の値/伏せ字の有無と、JSON なら
//   値が入っていたキーの場所。値そのものは出さない。
import { chromium } from "playwright";
import { createRequire } from "node:module";
import zlib from "node:zlib";
import path from "node:path";
import fs from "node:fs";
import { startCdpRecorder } from "../fixtures/cdp-recorder.mjs";

const require = createRequire(import.meta.url);
const leak = require("../../browser-extension/security/leak-detector.js");
const EG = require("../../browser-extension/security/egress-guard.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const site = args.find((a) => !a.startsWith("--"));
const opt = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const flag = (name) => args.includes(`--${name}`);
const port = opt("port", "9333");
const attach = opt("attach", "");
const dropFile = opt("drop", ""); // 入力欄の上に実ファイルを落とす (CDP の Input.dispatchDragEvent)
const pasteFile = opt("paste", "");
const extra = opt("extra", ""); // 下書きに足す語 (例: テスト用の「常に伏せる語」)。これも外に出さない目印にする
// --interactive: 利用者の既定どおり確認画面 (サイドバー / ChatGPT は入力欄の確認バー) を出し、
// 「マスクして送信」を押して進める。付けなければ確認画面を一時的に切る (自動マスク)。
const interactive = flag("interactive"); // 入力欄にファイルを貼り付ける (ページで ClipboardEvent を作る。拡張は本物と同じに扱う)
const noSend = flag("no-send");
const saveDir = opt("save-bodies", ""); // 止めた本文のうちカナリアを含むものを生のまま保存する (手元の解析用。架空の値だけ)

// probe: 拡張のアダプタが拾う形の送信を 1 回だけ (strict モードで止めた状態で) 流し、止め具に届いた本文が
// マスク済みなら「拡張のフックが上、止め具が下」と確定する (サイト自身が fetch を包んでいても判定できる)。
const PROBE_MARK = "__pii_guard_dryrun_probe=1";
const SITES = {
  claude: { home: "https://claude.ai/new", host: /(^|\.)claude\.(ai|com)$/, editor: 'div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
    probe: { url: `/api/organizations/00000000-0000-0000-0000-000000000000/chat_conversations/00000000-0000-0000-0000-000000000000/completion?${PROBE_MARK}`, body: (t) => ({ prompt: t }) } },
  gemini: { home: "https://gemini.google.com/app", host: /^gemini\.google\.com$/, editor: 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]',
    probe: { url: `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${PROBE_MARK}`, body: (t) => ({ contents: [{ role: "user", parts: [{ text: t }] }] }) } },
  manus: { home: "https://manus.im/app", host: /(^|\.)manus\.im$/, editor: 'div.ProseMirror[contenteditable="true"], textarea, [contenteditable="true"]',
    probe: { url: `/api/chat/message?${PROBE_MARK}`, body: (t) => ({ content: t }) } },
  // ChatGPT は Secure Composer (拡張オリジンの iframe) に打って送る。ページの JS のアダプタは使わない
  // ので、止め具の順番はテスト送信で確かめられない。送信の本文は CDP の段 (全フックを通った後の、
  // 実際に出ていく形) で受け取って調べる。
  chatgpt: { home: "https://chatgpt.com/", host: /(^|\.)chatgpt\.com$/, editor: '#prompt-textarea, div.ProseMirror[contenteditable="true"]', secureComposer: true },
};
const S = SITES[site];
if (!S) { console.error("usage: node tests/integration/dryrun-send.mjs <claude|gemini|manus|chatgpt> [--port=9333] [--interactive] [--attach=<file>] [--no-send]"); process.exit(2); }

const CANARY = "PIIGUARDDRYRUN" + Date.now().toString(36).toUpperCase();
const PHONE = "090-1234-5678";
const EMAIL = "taro.yamada@example.test";
// 添付のテスト用ファイルは名前と中身に PIIGUARDFILE を入れる (それを含む通信も外に出さない)
const FAKE_NAME = "山田太郎"; // 添付のファイル名・中身に入れる架空の氏名
const NEEDLES = [CANARY, PHONE, EMAIL, "09012345678", "PIIGUARDFILE", FAKE_NAME, ...(extra ? [extra] : [])];
const NAMES = ["canary", "phone", "email", "phone-digits", "file-canary", "name", "extra"];
const DRAFT = `${CANARY} 電話 ${PHONE} メール ${EMAIL}${extra ? ` 件名 ${extra}` : ""}`;

// ---- 1. ページ側の止め具 (拡張のフックより下に入る) -------------------------------------
const KILL_SWITCH = `(() => {
  const NEEDLES = ${JSON.stringify(NEEDLES)};
  const LOG = [];
  let mode = "needle";
  try {
    Object.defineProperty(window, "__dryRun", { value: { log: LOG, setMode: (m) => { mode = m; }, mode: () => mode } });
  } catch (_) { return; }
  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const latin1 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
  const utf8 = (u8) => { try { return new TextDecoder().decode(u8); } catch (_) { return ""; } };
  const hasNeedle = (s) => !!s && NEEDLES.some((n) => s.includes(n) || s.includes(encodeURIComponent(n)));
  // 本文を同期で読める形にする (読めない形は null = 中身不明)
  function syncText(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer) { const u = new Uint8Array(body); return utf8(u) + latin1(u); }
    if (ArrayBuffer.isView(body)) { const u = new Uint8Array(body.buffer, body.byteOffset, body.byteLength); return utf8(u) + latin1(u); }
    if (typeof FormData !== "undefined" && body instanceof FormData) { let s = ""; for (const [k, v] of body.entries()) s += k + "=" + (typeof v === "string" ? v : "[file:" + v.name + "]") + "&"; return s; }
    return null; // Blob / ReadableStream など
  }
  async function snap(body) {
    try {
      if (body == null) return { type: "none" };
      if (typeof body === "string") return { type: "string", text: body };
      if (body instanceof URLSearchParams) return { type: "form", text: body.toString() };
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const parts = [];
        for (const [k, v] of body.entries()) parts.push(typeof v === "string" ? { name: k, text: v } : { name: k, file: v.name, mime: v.type, b64: toB64(new Uint8Array(await v.arrayBuffer())) });
        return { type: "formdata", parts };
      }
      if (body instanceof Blob) return { type: "blob", mime: body.type, b64: toB64(new Uint8Array(await body.arrayBuffer())) };
      if (body instanceof ArrayBuffer) return { type: "bytes", b64: toB64(new Uint8Array(body)) };
      if (ArrayBuffer.isView(body)) return { type: "bytes", b64: toB64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
      return { type: Object.prototype.toString.call(body) };
    } catch (e) { return { type: "unreadable", error: String(e) }; }
  }
  // strict: GET/HEAD 以外は全部止める。needle: 中身にカナリア等があるか、中身を読めない書き込みは止める
  function shouldBlock(method, url, text) {
    if (hasNeedle(url)) return true;
    const write = method !== "GET" && method !== "HEAD";
    if (mode === "strict") return write;
    if (!write) return false;
    return text === null ? false : hasNeedle(text);
  }
  const nativeFetch = window.fetch;
  window.fetch = function dryRunFetch(input, init) {
    let method = "GET", url = "", text = "", req = null;
    try {
      req = (typeof Request !== "undefined" && input instanceof Request) ? input : null;
      method = String((init && init.method) || (req && req.method) || "GET").toUpperCase();
      url = String(req ? req.url : input);
      text = init && "body" in init ? syncText(init.body) : req ? null : "";
    } catch (_) {}
    // Request の本文 (stream) は読まないと分からない → needle モードでも書き込みなら止めて記録する
    const block = shouldBlock(method, url, text) || (req && method !== "GET" && method !== "HEAD" && text === null && mode === "strict");
    if (!block) return nativeFetch.apply(this, arguments);
    const entry = { via: "fetch", t: Date.now(), mode, method, url };
    LOG.push(entry);
    const p = init && "body" in init ? snap(init.body) : req ? req.clone().arrayBuffer().then((b) => ({ type: "request", b64: toB64(new Uint8Array(b)) })).catch(() => ({ type: "unreadable" })) : Promise.resolve({ type: "none" });
    p.then((b) => { entry.body = b; });
    return Promise.reject(new TypeError("Failed to fetch"));
  };
  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function dryRunOpen(m, u) { this.__dr = { m: String(m).toUpperCase(), u: String(u) }; return xOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function dryRunSend(body) {
    const d = this.__dr || { m: "GET", u: "" };
    const text = syncText(body);
    if (!shouldBlock(d.m, d.u, text) && !(mode === "strict" && text === null && d.m !== "GET")) return xSend.apply(this, arguments);
    const entry = { via: "xhr", t: Date.now(), mode, method: d.m, url: d.u };
    LOG.push(entry);
    snap(body).then((b) => { entry.body = b; });
    const xhr = this;
    setTimeout(() => { try { xhr.dispatchEvent(new ProgressEvent("error")); xhr.dispatchEvent(new ProgressEvent("loadend")); } catch (_) {} }, 0);
  };
  if (navigator.sendBeacon) {
    const nb = navigator.sendBeacon;
    navigator.sendBeacon = function dryRunBeacon(url, data) {
      const text = syncText(data);
      if (!shouldBlock("POST", String(url), text) && !(mode === "strict") && !(text === null && hasNeedle(String(url)))) return nb.apply(navigator, arguments);
      const entry = { via: "beacon", t: Date.now(), mode, method: "POST", url: String(url) };
      LOG.push(entry);
      snap(data).then((b) => { entry.body = b; });
      return true;
    };
  }
  const wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function dryRunWsSend(data) {
    const text = syncText(data);
    if (mode !== "strict" && !(text !== null && hasNeedle(text))) return wsSend.apply(this, arguments);
    const entry = { via: "ws", t: Date.now(), mode, method: "WS", url: String(this.url) };
    LOG.push(entry);
    snap(data).then((b) => { entry.body = b; });
  };
})();`;

// ---- 解析 (値は出さない) ---------------------------------------------------------
function decodeBody(b) {
  if (!b) return [];
  const outs = [];
  const add = (buf) => { outs.push(buf.toString("utf8")); outs.push(buf.toString("latin1")); };
  if (typeof b.text === "string") outs.push(b.text);
  // WebChannel のフォーム (Gemini) は Base64 の protobuf をほどいて見る
  if (typeof b.text === "string") { const wc = EG.parseWebChannelForm(b.text); if (wc) for (const it of wc.items) { const u = Buffer.from(it.bytes); outs.push(u.toString("utf8")); } }
  if (b.type === "form" && typeof b.text === "string") { try { outs.push(decodeURIComponent(b.text.replace(/\+/g, " "))); } catch (_) {} }
  if (b.parts) for (const p of b.parts) { if (p.text) outs.push(`${p.name}=${p.text}`); if (p.file) outs.push(`[file name] ${p.file}`); if (p.b64) add(Buffer.from(p.b64, "base64")); }
  if (b.b64) {
    const buf = Buffer.from(b.b64, "base64");
    add(buf);
    for (const f of [zlib.gunzipSync, zlib.inflateSync, zlib.brotliDecompressSync]) { try { add(f(buf)); } catch (_) {} }
  }
  return outs;
}
function keyPathsOf(text, needleIdx) {
  let j; try { j = JSON.parse(text); } catch (_) { return []; }
  const paths = [];
  const walk = (x, p, d) => {
    if (d > 14 || x == null) return;
    if (typeof x === "string") {
      if (leak.findLeaks(x, [NEEDLES[needleIdx]]).length) paths.push(p || "(root)");
      // f.req のように JSON を文字列で入れ子にしている形もほどく
      if (x.length > 2 && (x[0] === "[" || x[0] === "{")) { try { walk(JSON.parse(x), `${p}<json>`, d + 1); } catch (_) {} }
      return;
    }
    if (typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) walk(v, p ? `${p}.${Array.isArray(x) ? "[]" : k}` : k, d + 1);
  };
  walk(j, "", 0);
  return [...new Set(paths)].slice(0, 6);
}
function analyzeEntry(e) {
  const texts = decodeBody(e.body);
  const found = {};
  for (const t of texts) for (const h of leak.findLeaks(t, NEEDLES)) found[NAMES[h.index]] = found[NAMES[h.index]] || h.kind;
  const placeholders = texts.some((t) => /<[A-Z_]+_\d+>|\[(?:PHONE|EMAIL|PERSON)[^\]]*\]/.test(t));
  const row = {
    via: e.via, mode: e.mode, method: e.method,
    to: (() => { try { const u = new URL(e.url, SITES[site].home); return u.host + u.pathname.slice(0, 90); } catch (_) { return String(e.url).slice(0, 100); } })(),
    body: e.body ? e.body.type : "pending", bytes: e.body && e.body.b64 ? Buffer.from(e.body.b64, "base64").length : e.body && e.body.text ? e.body.text.length : 0,
    canary: !!(found.canary || found["file-canary"]), rawPhone: !!(found.phone || found["phone-digits"]), rawEmail: !!found.email, rawName: !!found.name, rawExtra: !!found.extra, placeholders,
  };
  if (row.canary || row.rawPhone || row.rawEmail) {
    const j = texts.find((t) => /^[[{]/.test(t.trim()));
    if (j) row.where = NEEDLES.map((_, i) => ({ n: NAMES[i], p: keyPathsOf(j, i) })).filter((x) => x.p.length).map((x) => `${x.n}: ${x.p.join(" | ")}`);
    if (e.body && e.body.parts) row.fileNames = e.body.parts.filter((p) => p.file).map((p) => p.file);
  }
  row.verdict = row.canary || row.rawPhone || row.rawEmail || row.rawName || row.rawExtra
    ? (row.rawPhone || row.rawEmail || row.rawName || row.rawExtra ? "LEAK: 生の個人情報が残っている" : "masked: 個人情報は伏せ字")
    : "unrelated";
  return row;
}

// ---- 2. CDP の止め具 (ネットワークの直前) -----------------------------------------------
async function startNetGuard(wsUrl, pageTargetId, hostRe) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const blocked = [];
  let mode = "needle";
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const i = ++id; pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const hasNeedle = (s) => !!s && NEEDLES.some((n) => s.includes(n) || s.includes(encodeURIComponent(n)));
  async function arm(sessionId) {
    await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  }
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Target.attachedToTarget") { arm(m.params.sessionId).catch(() => {}); return; }
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const method = String(request.method || "GET").toUpperCase();
    const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    let body = request.postData || "";
    if (!body && Array.isArray(request.postDataEntries)) body = request.postDataEntries.map((e) => Buffer.from(e.bytes || "", "base64").toString("latin1")).join("");
    const block = hasNeedle(request.url) || (write && (mode === "strict" || hasNeedle(body)));
    if (block) {
      const rawPii = [PHONE, EMAIL, "09012345678", FAKE_NAME].some((n) => body.includes(n) || Buffer.from(body, "latin1").toString("utf8").includes(n) || request.url.includes(encodeURIComponent(n)));
      blocked.push({ t: Date.now(), mode, method, url: request.url, bytes: body.length, canary: hasNeedle(body) || hasNeedle(request.url), rawPii, placeholders: /<[A-Z_]+_\d+>/.test(body), body: body.slice(0, 1 << 20) });
      await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, m.sessionId);
    } else {
      await send("Fetch.continueRequest", { requestId }, m.sessionId);
    }
  };
  const att = await send("Target.attachToTarget", { targetId: pageTargetId, flatten: true });
  await arm(att.result.sessionId);
  // 同じサイトの Service Worker (ページの fetch を肩代わりしていることがある)
  const { result } = await send("Target.getTargets");
  for (const t of result.targetInfos) {
    let h = ""; try { h = new URL(t.url).hostname; } catch (_) {}
    if (t.type === "service_worker" && hostRe.test(h)) {
      const a = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      if (a.result) await arm(a.result.sessionId);
    }
  }
  return { blocked, setMode: (m) => { mode = m; }, close: () => { try { ws.close(); } catch (_) {} } };
}

// ---- 拡張の設定 (拡張のページ = Secure Composer の iframe 等から読み書き) ------------------
async function extEval(expr) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const t = targets.find((x) => x.type === "service_worker" && /^chrome-extension:\/\/.*background\.js$/.test(x.url))
    || targets.find((x) => /^chrome-extension:\/\/[a-z]{32}\//.test(x.url) && x.webSocketDebuggerUrl);
  if (!t) throw new Error("拡張のページが見つからない (ChatGPT のタブを開いておくこと)");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const r = await new Promise((res) => { ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m); }; ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
  ws.close();
  return r.result && r.result.result ? r.result.result.value : null;
}

// ---- 添付 ---------------------------------------------------------------------------
// サイトごとの入口 (2026-10-18 実測)。押すのは入力欄のまわりのボタンだけ。
//   Claude: ページに file input が常にある
//   Gemini: 「アップロードとツール」→ メニューの「ファイル」(押すと file input が現れる)
//   Manus : 入力欄の左下の「＋」(文字も aria-label も無いアイコン) → メニューの「ローカルファイル」
const ATTACH = {
  gemini: { button: (page) => page.locator('button[aria-label="アップロードとツール"]').first(), item: /^ファイル$/ },
  manus: {
    button: async (page) => (await page.evaluateHandle(() => {
      const ed = document.querySelector('div.ProseMirror[contenteditable="true"]');
      let box = ed;
      for (let i = 0; i < 6 && box && box.parentElement; i++) { box = box.parentElement; if (box.querySelectorAll("button").length >= 3) break; }
      const er = box.getBoundingClientRect();
      return [...box.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && b.querySelector("svg") && !(b.textContent || "").trim() && r.top > er.top + er.height / 2; })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null;
    })).asElement(),
    item: /^ローカルファイル$/,
  },
};
async function attachVia(page, ed, file) {
  const generalInput = async () => {
    const all = page.locator('input[type="file"]');
    const n = await all.count();
    for (let i = 0; i < n; i++) { const acc = (await all.nth(i).getAttribute("accept")) || ""; if (!/^image\/\*$/.test(acc)) return all.nth(i); }
    return n ? all.first() : null;
  };
  let inp = await generalInput();
  if (inp && site === "claude") { await inp.setInputFiles(file); return "file input"; }
  const a = ATTACH[site];
  if (!a) return null;
  const btn = await a.button(page);
  if (!btn) return null;
  const firstChooser = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
  await btn.click({ timeout: 5000 });
  let ch = await firstChooser;
  if (ch) { await ch.setFiles(file); return "button → file chooser"; }
  // メニューの項目を押してファイル選択を横取りする
  const item = page.locator("button, [role=menuitem], [role=option], div, span").filter({ hasText: a.item }).last();
  if (await item.count()) {
    const chP = page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
    await item.click({ timeout: 3000 }).catch(() => {});
    ch = await chP;
    if (ch) { await ch.setFiles(file); return "button → menu → file chooser"; }
  }
  inp = await generalInput();
  if (inp) { await inp.setInputFiles(file); await page.keyboard.press("Escape").catch(() => {}); return "button → file input"; }
  await page.keyboard.press("Escape").catch(() => {});
  return null;
}

// ---- 本体 ---------------------------------------------------------------------------
const out = { site, canary: CANARY, steps: [] };
const T0 = Date.now();
// 進み具合は標準エラーへ (止まった場所が分かるように)。標準出力は最後の JSON だけ
const step = (s) => { out.steps.push(s); console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`); };
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let saved = null;
let net = null;
let recorder = null;
try {
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => { try { return S.host.test(new URL(p.url()).hostname); } catch (_) { return false; } });
  if (!page) throw new Error(`${site} のタブが無い`);
  page.setDefaultTimeout(15000); // 既定の無制限待ちで止まらないように
  const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const pageTarget = targets.find((t) => t.type === "page" && t.url === page.url()) || targets.find((t) => t.type === "page" && S.host.test(new URL(t.url).hostname));

  // 設定: 確認画面を切る (自動マスク)。元の値を覚えて最後に戻す
  if (!interactive) {
    saved = await extEval(`chrome.storage.local.get(["interactive"]).then((s) => ({ had: "interactive" in s, v: s.interactive }))`);
    await extEval(`chrome.storage.local.set({ interactive: false }).then(() => true)`);
    step("設定: 確認画面を一時的に OFF");
  } else step("設定: 確認画面はそのまま (利用者の既定)");

  // 拡張自身の判定 (伏せた・止めた・差し替えた) のログも集める (値は含まない)
  out.extLog = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/egress guard:|substituted masked|masked an attachment|manus-ws: substituted|attachment-guard:/.test(t)) out.extLog.push(t.replace(/^\[pii-guard\]\s*/, "").slice(0, 160));
  });
  net = await startNetGuard(webSocketDebuggerUrl, pageTarget.id, S.host);
  recorder = await startCdpRecorder(webSocketDebuggerUrl);
  await page.addInitScript(KILL_SWITCH);
  await page.goto(S.home, { waitUntil: "domcontentloaded", timeout: 45000 });
  await sleep(6000);

  // 順番の検査: 拡張のアダプタが拾う形の送信を fetch と XHR で 1 回ずつ流す (strict で止める)。
  // 止め具に届いた本文がマスク済み = 拡張のフックが上、止め具が下。
  // 確認画面が有効だとテスト送信にもサイドバーが開いて待ち続けるので、テスト送信の間だけ切る。
  let probeSaved = null;
  if (interactive && !S.secureComposer) {
    probeSaved = await extEval(`chrome.storage.local.get(["interactive"]).then((s) => ({ had: "interactive" in s, v: s.interactive }))`);
    await extEval(`chrome.storage.local.set({ interactive: false }).then(() => true)`);
    await sleep(1500);
  }
  const order = await Promise.race([page.evaluate(async ({ probe, phone }) => {
    const names = { fetch: window.fetch.name, xhr: XMLHttpRequest.prototype.send.name, ws: WebSocket.prototype.send.name, beacon: navigator.sendBeacon && navigator.sendBeacon.name };
    if (!window.__dryRun) return { names, installed: false };
    window.__dryRun.setMode("strict");
    const body = JSON.stringify(probe.body);
    try { await window.fetch(probe.url, { method: "POST", headers: { "content-type": "application/json" }, body }); } catch (_) {}
    await new Promise((res) => { const x = new XMLHttpRequest(); x.open("POST", probe.url + "&via=xhr"); x.setRequestHeader("content-type", "application/json"); x.onloadend = res; x.onerror = res; x.send(body); setTimeout(res, 8000); });
    await new Promise((r) => setTimeout(r, 300));
    window.__dryRun.setMode("needle");
    const got = window.__dryRun.log.filter((e) => /__pii_guard_dryrun_probe=1/.test(e.url)).map((e) => ({ via: e.via, text: e.body && typeof e.body.text === "string" ? e.body.text : null }));
    return { names, installed: true, probes: got.map((g) => ({ via: g.via, reached: true, masked: g.text !== null && !g.text.includes(phone) && /<[A-Z_]+_\d+>/.test(g.text) })) };
  }, { probe: S.probe ? { url: S.probe.url, body: S.probe.body(`PIIGUARDPROBE 電話 ${PHONE}`) } : { url: "/__pii_guard_dryrun_probe?__pii_guard_dryrun_probe=1", body: { x: 1 } }, phone: PHONE }),
    sleep(20000).then(() => ({ installed: false, timeout: true }))]);
  if (probeSaved) {
    await extEval(probeSaved.had ? `chrome.storage.local.set({ interactive: ${JSON.stringify(probeSaved.v)} }).then(() => true)` : `chrome.storage.local.remove("interactive").then(() => true)`);
    await sleep(1500);
  }
  out.hookOrder = order;
  const viaOk = (v) => (order.probes || []).some((p) => p.via === v && p.reached && p.masked);
  if (S.secureComposer) {
    if (!order.installed) throw new Error("止め具が入っていない。中止");
    step("止め具: ページ側の止め具あり (ChatGPT は CDP の段の本文で判定)");
  } else {
    if (!order.installed || !viaOk("fetch") || !viaOk("xhr")) throw new Error("止め具が拡張のフックの下に入っていない (または拡張がマスクしない)。中止: " + JSON.stringify(order));
    step("止め具: 拡張のフックの下に入ったことを確認 (fetch / XHR のテスト送信がマスク済みで届いた)");
  }

  const ed = page.locator(S.editor).filter({ visible: true }).first();
  await ed.waitFor({ timeout: 15000 });
  if (dropFile) {
    const pt = await ed.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
    const cdp = await page.context().newCDPSession(page);
    const data = { items: [], files: [dropFile], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "dragOver", "drop"]) { await cdp.send("Input.dispatchDragEvent", { type, x: pt.x, y: pt.y, data }); await sleep(150); }
    await cdp.detach().catch(() => {});
    step(`ドロップ: ${path.basename(dropFile)} を入力欄に落とした`);
    await sleep(7000);
    out.chipsHint = await page.evaluate(() => document.body.innerText.includes("連絡先"));
  }
  if (pasteFile) {
    const content = fs.readFileSync(pasteFile, "utf8");
    await ed.evaluate((el, { name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: "text/plain" }));
      el.focus();
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    }, { name: path.basename(pasteFile), content });
    step(`貼り付け: ${path.basename(pasteFile)} を入力欄に貼った`);
    await sleep(7000);
    out.pasteHint = await page.evaluate(() => document.body.innerText.includes("連絡先"));
  }
  if (attach) {
    const how = await attachVia(page, ed, attach);
    step(how ? `添付: ${path.basename(attach)} (${how})` : "添付: 入口が見つからない (スキップ)");
    await sleep(7000);
  }
  const strict = async () => { await page.evaluate(() => window.__dryRun.setMode("strict")); net.setMode("strict"); };
  if (S.secureComposer) {
    // 保護入力欄 (iframe) に打つ。確認バーが出たら、strict にしてから「マスキングして送信」を押す
    let frame = null;
    for (let i = 0; i < 60 && !frame; i++) { frame = page.frames().find((f) => /\/secure-composer\/secure-composer\.html/.test(f.url())); if (!frame) await sleep(250); }
    if (!frame) throw new Error("保護入力欄 (Secure Composer) の iframe が無い");
    const ta = frame.locator("textarea");
    await ta.waitFor({ timeout: 10000 });
    out.scState = await frame.evaluate(() => document.documentElement.dataset.state);
    await ta.click();
    await ta.pressSequentially(DRAFT, { delay: 20 });
    await sleep(2500);
    if (!noSend) {
      await strict();
      step("送信: strict モードで保護入力欄から Enter");
      await ta.press("Enter");
      const shown = await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 6000 }).then(() => true).catch(() => false);
      out.confirmShown = shown;
      if (shown) { await frame.locator("#confirm-send").click(); step("確認バー: 「マスキングして送信」を押した"); }
      await sleep(9000);
    }
  } else {
    // 読み込み直後のアニメーション等でクリックできないことがあるので、だめなら直接フォーカスする
    await ed.click({ timeout: 15000 }).catch(async () => { await ed.evaluate((el) => el.focus()); });
    await ed.pressSequentially(DRAFT, { delay: 20 });
    await sleep(2500);
    if (!noSend) {
      await strict();
      step("送信: strict モードで Enter");
      await page.keyboard.press("Enter");
      if (interactive) {
        // 確認用のサイドバー (開いた shadow root) の「マスクして送信」を押す。
        // 普通のクリック → 強制クリック → ボタンにフォーカスして Enter の順に試す
        const btn = page.getByRole("button", { name: /選択したものをマスクして送信/ });
        const shown = await btn.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
        out.sidebarShown = shown;
        // 押せたかは「サイドバーが閉じたか」でなく「目印入りの送信が止め具に届いたか」で見る
        // (止め具で送信が失敗すると、サイトが送り直してサイドバーがまた開くため)
        const sent = () => page.evaluate((canary) => window.__dryRun.log.some((e) => {
          const b = e.body || {};
          if (typeof b.text === "string" && b.text.includes(canary)) return true;
          if (b.b64) { try { return atob(b.b64).includes(canary); } catch (_) { return false; } }
          return false;
        }), CANARY).catch(() => false);
        const open = async () => !(await sent());
        if (shown) {
          await sleep(800);
          const tries = [
            ["click", () => btn.click({ timeout: 5000 })],
            ["force-click", () => btn.click({ timeout: 5000, force: true })],
            ["focus+Enter", async () => { await btn.focus({ timeout: 5000 }); await page.keyboard.press("Enter"); }],
          ];
          for (const [name, fn] of tries) {
            await fn().catch((e) => step(`サイドバー: ${name} 失敗 (${String(e.message).split("\n")[0].slice(0, 80)})`));
            await sleep(1200);
            if (!(await open())) { step(`サイドバー: 「選択したものをマスクして送信」を押した (${name})`); out.sidebarAccepted = name; break; }
          }
          if (!out.sidebarAccepted) step("サイドバー: 押せなかった");
        }
      }
      await sleep(9000);
    }
  }
  // 記録を回収してから needle モードに戻し、読み直して再送を見張る
  const log = await page.evaluate(() => window.__dryRun.log.map((e) => ({ ...e })));
  await page.evaluate(() => window.__dryRun.setMode("needle")).catch(() => {});
  net.setMode("needle");
  const real = log.filter((e) => !String(e.url).includes(PROBE_MARK));
  out.rows = real.map(analyzeEntry).filter((r) => r.verdict !== "unrelated" || r.mode === "strict");
  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    real.forEach((e, i) => {
      const r = analyzeEntry(e);
      if (!r.canary) return;
      const f = path.join(saveDir, `${site}-${i}-${e.via}.${e.body && e.body.b64 ? "bin" : "txt"}`);
      if (e.body && e.body.b64) fs.writeFileSync(f, Buffer.from(e.body.b64, "base64"));
      else if (e.body && typeof e.body.text === "string") fs.writeFileSync(f, e.body.text);
      r.saved = f;
    });
  }
  out.netBlocked = net.blocked.map((b) => ({ mode: b.mode, method: b.method, to: (() => { try { const u = new URL(b.url); return u.host + u.pathname.slice(0, 80); } catch (_) { return ""; } })(), canary: b.canary, rawPii: b.rawPii, placeholders: b.placeholders, bytes: b.bytes }));
  // CDP の段で止めた本文も同じ方法で調べる (全フックを通った後の、実際に出ていく形)
  out.netRows = net.blocked.map((b) => analyzeEntry({ via: "net", mode: b.mode, method: b.method, url: b.url, body: { type: "bytes", b64: Buffer.from(b.body || "", "latin1").toString("base64") } }))
    .filter((r) => r.verdict !== "unrelated");
  step("後片付け: needle に戻して読み直す");
  await page.goto(S.home, { waitUntil: "commit", timeout: 20000 }).catch((e) => step("読み直し失敗: " + String(e.message).split("\n")[0].slice(0, 80)));
  await sleep(8000);
  // 下書きが復元されていたら消す (架空の値でも、残しておくと後で誤って送られうる)
  const restored = await page.evaluate(({ sel, canary }) => [...document.querySelectorAll(sel)].some((el) => ((el.value ?? el.innerText) || "").includes(canary)), { sel: S.editor, canary: CANARY }).catch(() => false);
  if (restored) {
    const ed2 = page.locator(S.editor).filter({ visible: true }).first();
    await ed2.click({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await sleep(2000);
  }
  out.draftRestoredAfterReload = restored;
  if (S.secureComposer) {
    // ChatGPT の元の入力欄 (保護入力欄の下) に、伏せ字にした本文が残っていれば消す
    const left = await page.evaluate((canary) => {
      const ed = document.querySelector("#prompt-textarea");
      if (!ed || !(ed.innerText || "").includes(canary)) return false;
      ed.focus(); document.execCommand("selectAll"); document.execCommand("delete");
      return true;
    }, CANARY).catch(() => false);
    out.nativeDraftCleared = left;
  }
  const late = await page.evaluate(() => (window.__dryRun ? window.__dryRun.log.map((e) => ({ via: e.via, url: e.url })) : [])).catch(() => []);
  out.afterReloadBlocked = late.length;
  // 外に出た通信にカナリア・生の値が 1 つでもあれば失敗 (止め具の穴)
  await recorder.settle(1500);
  const escaped = recorder.all().filter((r) => r.url && !/^(chrome-extension|data|blob):/.test(r.url) && !r.failed && leak.scanRequest(r, NEEDLES).length);
  const escapedWs = recorder.wsFrames.filter((f) => leak.findLeaks(f.data, NEEDLES).length);
  out.escaped = escaped.length + escapedWs.length;
  if (out.escaped) out.escapedTo = escaped.map((r) => r.url.replace(/\?.*$/, "").slice(0, 100)).concat(escapedWs.map((f) => "ws:" + (f.url || "")));
} catch (e) {
  out.error = String((e && e.message) || e).split("\n")[0];
} finally {
  if (net) net.close();
  if (recorder) await recorder.close();
  if (saved) {
    await extEval(saved.had ? `chrome.storage.local.set({ interactive: ${JSON.stringify(saved.v)} }).then(() => true)` : `chrome.storage.local.remove("interactive").then(() => true)`).catch(() => {});
    out.steps.push("設定: 確認画面を元に戻した");
  }
  await browser.close(); // 切断 (止め具の init script も外れる)
}
// 止め具の無い状態で読み直して、画面を普通の状態に戻す。
// ただし読み直し後に再送の試みがあったときは読み直さない (今のページには止め具が残っているので安全。
// 素の状態で読み直すと、サイトが保存した未送信分を本当に送ってしまうおそれがある)。
if (out.afterReloadBlocked > 0) {
  out.steps.push("読み直し後に再送の試みがあったので、素の読み直しはしない (タブには止め具が残っている)");
} else try {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const t = targets.find((x) => x.type === "page" && S.host.test(new URL(x.url).hostname));
  if (t) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: "Page.reload", params: { ignoreCache: false } }));
    await sleep(500);
    ws.close();
  }
} catch (_) {}
console.log(JSON.stringify(out, null, 1));
