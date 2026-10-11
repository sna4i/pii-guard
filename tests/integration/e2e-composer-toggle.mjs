// tests/integration/e2e-composer-toggle.mjs — チャット入力欄のオン/オフトグルと、オフ時の警告 (docs/composer-toggle.md)
//
// chatgpt.com を名乗るモックページに入力欄 (textarea、または contenteditable) を置き、
// 拡張機能を読み込んだ実際のブラウザで確かめる:
//   T-02 入力欄があればピルが出る。無いページでは出ない
//   T-03 オフで個人情報を入力すると警告に件数が出る。そのまま送るとサイドバーは出ず本文はそのまま届く
//   T-04 「マスキングする」でサイドバーが開き、確定で入力欄が伏せ字になる。設定はオフのまま
//   T-05 「オンにする」で設定がオンになり、サイドバーが開き、確定で入力欄が伏せ字になる
//   T-06 contenteditable の入力欄でも警告と書き戻しが動く
//   T-07 ピルでオフにすると設定が false になり、送信は素通しになる
//
// 使い方: node tests/integration/e2e-composer-toggle.mjs <unpacked 拡張機能ディレクトリ>
// モックサーバとブラウザはこのスクリプト自身が起動し、finally で必ず閉じる。
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import { chromium } from "playwright";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const EXT_ARG = process.argv[2];
if (!EXT_ARG) { console.error("usage: node tests/integration/e2e-composer-toggle.mjs <unpacked-dir>"); process.exit(2); }
const EXT = path.resolve(EXT_ARG);

const PII = "田中様 (090-1234-5678, tanaka@example.co.jp) に見積もりを送ります";
const CLEAN = "明日の天気を教えてください";
const HOST = 'div[data-pii-guard="composer-toggle"]';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-composer-"));
let server, ctx;
const received = [];
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };

const page = (kind) => {
  const editor = kind === "ce"
    ? '<div id="prompt-textarea" contenteditable="true" style="min-height:60px;border:1px solid #999"></div>'
    : kind === "ta" ? '<textarea id="prompt-textarea" rows="4" style="width:80%"></textarea>' : "";
  return `<!doctype html><title>mock</title><style>body{margin:0;height:100vh;display:flex;flex-direction:column}main{flex:1}footer{padding:16px}</style>
<h1>mock chatgpt.com</h1><main></main><footer>${editor}</footer>`;
};

// 拡張機能の Shadow DOM の中を読む補助 (ピルの状態を読む / 要素を押す)
const pillState = (p) => p.evaluate((sel) => {
  const host = document.querySelector(sel);
  const root = host && host.shadowRoot;
  if (!root) return null;
  const sw = root.querySelector(".switch");
  const warn = root.querySelector(".warn");
  return { on: sw ? sw.getAttribute("aria-checked") : null, warn: !!(warn && warn.offsetParent !== null), count: warn ? (warn.querySelector(".count") || {}).textContent : null };
}, HOST);
const clickInPill = (p, inner) => p.evaluate(([sel, q]) => {
  const host = document.querySelector(sel);
  const el = host && host.shadowRoot && host.shadowRoot.querySelector(q);
  if (el) el.click();
  return !!el;
}, [HOST, inner]);
const sidebarHost = (p) => p.evaluateHandle(() => [...document.querySelectorAll("body *")].find((e) => e.shadowRoot && e.shadowRoot.querySelector("button")));
const sidebarOpen = async (p) => {
  const h = await sidebarHost(p);
  return h.evaluate((e) => !!(e && e.shadowRoot && [...e.shadowRoot.querySelectorAll("button")].some((b) => /マスク/.test(b.textContent))));
};
const confirmSidebar = async (p) => {
  const h = await sidebarHost(p);
  return h.evaluate((e) => { const b = [...e.shadowRoot.querySelectorAll("button")].find((x) => /選択したものをマスク/.test(x.textContent)); if (b) b.click(); return b ? b.textContent.trim() : null; });
};
const composerText = (p) => p.evaluate(() => { const el = document.querySelector("#prompt-textarea"); return el ? (el.tagName === "TEXTAREA" ? el.value : el.innerText) : null; });
const typeInto = async (p, text) => {
  await p.click("#prompt-textarea");
  await p.evaluate(() => { const el = document.querySelector("#prompt-textarea"); if (el.tagName === "TEXTAREA") { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else el.textContent = ""; });
  await p.keyboard.type(text);
  await p.waitForTimeout(900); // debounce 400ms + 検出
};
const send = async (p) => {
  await p.evaluate((t) => {
    fetch("/backend-api/conversation", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "next", model: "gpt-4", messages: [{ id: "1", author: { role: "user" }, content: { content_type: "text", parts: [t] } }] }) }).catch(() => {});
  }, await composerText(p));
  await p.waitForTimeout(2500);
};
const stored = (sw, key) => sw.evaluate((k) => chrome.storage.local.get(k).then((s) => s[k]), key);

try {
  const crt = path.join(tmp, "server.crt"), k = path.join(tmp, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", k, "-out", crt, "-days", "1", "-nodes", "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
  server = https.createServer({ key: fs.readFileSync(k), cert: fs.readFileSync(crt) }, (req, res) => {
    if (req.method === "POST" && req.url.startsWith("/backend-api/conversation")) {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(JSON.parse(b).messages[0].content.parts[0]); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      return;
    }
    const kind = req.url.startsWith("/ce") ? "ce" : req.url.startsWith("/none") ? "none" : "ta";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page(kind));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors", "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  await sw.evaluate(async () => { for (let i = 0; i < 100; i++) { const s = await chrome.storage.local.get(["enabled"]); if (typeof s.enabled === "boolean") return; await new Promise((r) => setTimeout(r, 100)); } });
  const errs = [];
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(String(e)));

  console.log("T-02 ピルの表示:");
  await p.goto("https://chatgpt.com/none"); await p.waitForTimeout(3500);
  check((await pillState(p)) === null, "入力欄が無いページではピルが出ない");
  await p.goto("https://chatgpt.com/ta"); await p.waitForTimeout(3500);
  let st = await pillState(p);
  check(st && st.on === "true", `入力欄があるページではピルが出て、オン (${JSON.stringify(st)})`);

  console.log("T-07 ピルでオフ:");
  await clickInPill(p, ".switch");
  await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === false, "保存された enabled が false になる");
  st = await pillState(p);
  check(st && st.on === "false", "ピルがオフ表示になる");

  console.log("T-03 オフで個人情報を入力:");
  await typeInto(p, CLEAN);
  st = await pillState(p);
  check(st && !st.warn, "個人情報が無ければ警告は出ない");
  await typeInto(p, PII);
  st = await pillState(p);
  check(st && st.warn && Number(st.count) >= 3, `個人情報があれば警告に件数が出る (${st && st.count})`);
  await send(p);
  check(!(await sidebarOpen(p)), "オフのまま送るとサイドバーは出ない");
  check(received.length === 1 && received[0] === PII, "本文はそのまま届く");

  console.log("T-04 「マスキングする」:");
  await clickInPill(p, ".warn");
  await p.waitForTimeout(500);
  await clickInPill(p, '[data-action="mask-once"]');
  await p.waitForTimeout(3000);
  check(await sidebarOpen(p), "サイドバーが開く");
  const label = await confirmSidebar(p);
  await p.waitForTimeout(2500);
  check(label && !/送信/.test(label), `確定ボタンが送信を示さない (${label})`);
  const after = await composerText(p);
  check(after && !after.includes("090-1234-5678") && !after.includes("tanaka@example.co.jp") && /<[A-Z_]+_\d+>/.test(after), `入力欄が伏せ字に置き換わる (${after})`);
  check((await stored(sw, "enabled")) === false, "設定はオフのまま");
  st = await pillState(p);
  check(st && !st.warn, "置き換え後は警告が消える");
  await send(p);
  check(received.length === 2 && received[1] === after, "伏せた文章がそのまま届く");

  console.log("T-05 「オンにする」:");
  await typeInto(p, PII);
  await clickInPill(p, ".warn");
  await p.waitForTimeout(500);
  await clickInPill(p, '[data-action="turn-on"]');
  await p.waitForTimeout(3000);
  check((await stored(sw, "enabled")) === true, "保存された enabled が true になる");
  check(await sidebarOpen(p), "サイドバーが開く");
  await confirmSidebar(p);
  await p.waitForTimeout(2500);
  const after2 = await composerText(p);
  check(after2 && !after2.includes("090-1234-5678") && /<[A-Z_]+_\d+>/.test(after2), `入力欄が伏せ字に置き換わる (${after2})`);
  st = await pillState(p);
  check(st && st.on === "true" && !st.warn, "ピルはオン表示で警告なし");

  console.log("T-06 contenteditable の入力欄:");
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await p.goto("https://chatgpt.com/ce"); await p.waitForTimeout(3500);
  st = await pillState(p);
  check(st && st.on === "false", "ピルが出てオフ表示");
  await typeInto(p, PII);
  st = await pillState(p);
  check(st && st.warn, `警告が出る (${st && st.count})`);
  await clickInPill(p, ".warn");
  await p.waitForTimeout(500);
  await clickInPill(p, '[data-action="mask-once"]');
  await p.waitForTimeout(3000);
  await confirmSidebar(p);
  await p.waitForTimeout(2500);
  const after3 = await composerText(p);
  check(after3 && !after3.includes("090-1234-5678") && /<[A-Z_]+_\d+>/.test(after3), `contenteditable でも伏せ字に置き換わる (${after3})`);

  check(errs.length === 0, `ページの JS エラーなし${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
} catch (e) {
  console.error("テスト実行エラー:", e?.message || e); failed = true;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? "\n✗ FAILED" : "\n✓ PASSED");
process.exit(failed ? 1 : 0);
