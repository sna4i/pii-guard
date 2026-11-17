// tests/integration/e2e-diag-log.mjs — 動作ログ (docs/diagnostic-log.md)
//
// chatgpt.com を名乗るモックページで、拡張機能を読み込んだ実際のブラウザで確かめる:
//   T-LG-06 個人情報を入れて送っても、コンソールに拡張機能の出力が無い。ログに send.masked が入り、
//           どの記録にも入力した氏名・電話番号・メールアドレスが含まれない。
//           アイコンへのクリックを受け付けなかったときは toggle.click_ignored が残る (composer-toggle の T-26)
//   T-LG-07 設定画面の「ログ」タブに記録が出る。種類と期間で絞れる。「コピー」と「すべて消す」が動く
//   T-LG-08 ページのスクリプトが偽った記録は、一覧に無い種類なら捨てられ、一覧にあるものは
//           「ページ側から報告」として、検めを通った項目だけが残る
//   T-LG-09 15 日前の日付のログは、新しい記録を書いたときに消える
//
// 使い方: node tests/integration/e2e-diag-log.mjs <unpacked 拡張機能ディレクトリ>
// モックサーバとブラウザはこのスクリプト自身が起動し、finally で必ず閉じる。
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import { chromium } from "playwright";
import { browserMode } from "../fixtures/browser-mode.mjs";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const EXT_ARG = process.argv[2];
if (!EXT_ARG) { console.error("usage: node tests/integration/e2e-diag-log.mjs <unpacked-dir>"); process.exit(2); }
const EXT = path.resolve(EXT_ARG);

const PII_PARTS = ["田中", "090-1234-5678", "tanaka@example.co.jp"];
const TEXT = "田中様 (090-1234-5678, tanaka@example.co.jp) に見積もりを送ります";
const HOST = 'div[data-pii-guard="composer-toggle"]';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-diaglog-"));
let server, ctx;
const received = [];
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };

const PAGE = `<!doctype html><title>mock</title><style>body{margin:0;height:100vh;display:flex;flex-direction:column}main{flex:1}footer{padding:16px}</style>
<h1>mock chatgpt.com</h1><main></main><footer><textarea id="prompt-textarea" rows="4" style="width:80%"></textarea></footer>`;

const logEntries = (sw) => sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith("diagLog:")).flatMap(([, v]) => v);
});
const logKeys = (sw) => sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("diagLog")));

try {
  const crt = path.join(tmp, "server.crt"), k = path.join(tmp, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", k, "-out", crt, "-days", "1", "-nodes", "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
  server = https.createServer({ key: fs.readFileSync(k), cert: fs.readFileSync(crt) }, (req, res) => {
    if (req.method === "POST" && req.url.startsWith("/backend-api/conversation")) {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { received.push(JSON.parse(b).messages[0].content.parts[0]); } catch (_) { received.push(b); } res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    ...browserMode(), ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors", "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async () => { for (let i = 0; i < 100; i++) { const s = await chrome.storage.local.get(["enabled"]); if (typeof s.enabled === "boolean") return; await new Promise((r) => setTimeout(r, 100)); } });
  // 確認画面なしで送信を伏せ字にする経路 (injected.js) を使う。Secure Composer は別の E2E で確かめる
  await sw.evaluate(() => chrome.storage.local.set({ __pii_guard_e2e: true, secureComposerEnabled: false, interactive: false, enabled: true }));

  const extConsole = [];
  const errs = [];
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(String(e)));
  p.on("console", (m) => {
    const t = m.text();
    const url = (m.location() && m.location().url) || "";
    if (t.includes("[pii-guard]") || url.startsWith(`chrome-extension://${extId}/`)) extConsole.push(`${m.type()}: ${t.slice(0, 120)} @ ${url}`);
  });

  console.log("T-LG-06 送信と、受け付けなかったクリック:");
  await p.goto("https://chatgpt.com/"); await p.waitForTimeout(3500);
  await p.evaluate((t) => {
    fetch("/backend-api/conversation", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "next", model: "gpt-4", messages: [{ id: "1", author: { role: "user" }, content: { content_type: "text", parts: [t] } }] }) }).catch(() => {});
  }, TEXT);
  await p.waitForTimeout(3000);
  check(received.length === 1 && !PII_PARTS.some((s) => received[0].includes(s)), `送信は伏せ字になって届く (${received[0] || "なし"})`);
  // アイコンに重なるトップレイヤーの要素を出して押す (クリックは受け付けられない)
  const tg = await p.evaluate((sel) => { const h = document.querySelector(sel); return h && h.dataset.layout ? JSON.parse(h.dataset.layout).toggle : null; }, HOST);
  check(!!tg, "入力欄のアイコンがある");
  if (tg) {
    await p.evaluate((r) => {
      const d = document.createElement("div");
      d.setAttribute("popover", "manual");
      d.style.cssText = `position:fixed;inset:auto;left:${r[0] - 4}px;top:${r[1] - 4}px;width:${r[2] + 8}px;height:${r[3] + 8}px;margin:0;padding:0;border:0;background:#16a34a;pointer-events:none`;
      document.body.appendChild(d);
      d.showPopover();
    }, tg);
    await p.waitForTimeout(1500);
    await p.mouse.click(tg[0] + tg[2] / 2, tg[1] + tg[3] / 2);
  }

  console.log("T-LG-08 ページのスクリプトが偽った記録:");
  await p.evaluate(() => {
    const post = (entry) => window.postMessage({ source: "mask-mcp-inpage", type: "diag-log", entry }, "*");
    post({ code: "evil.code", d: { text: "田中" } });
    post({ code: "egress.blocked", d: { dest: "forged.example", via: "fetch", note: "090-1234-5678" } });
    post({ code: "send.blocked", d: { reason: "unmaskable", via: "fetch", body: "tanaka@example.co.jp" } });
  });
  await p.waitForTimeout(2000);

  const entries = await logEntries(sw);
  const codes = entries.map((e) => e.code);
  const masked = entries.find((e) => e.code === "send.masked");
  check(!!masked && masked.site === "chatgpt.com", `送信を伏せ字にした記録が、サイトのホスト名つきで残る (${JSON.stringify(masked)})`);
  const ignored = entries.find((e) => e.code === "toggle.click_ignored");
  check(!!ignored && ignored.d.reason === "occluded", `受け付けなかったクリックの記録が残る (${JSON.stringify(ignored && ignored.d)})`);
  check(!!ignored && Array.isArray(ignored.d.layers) && ignored.d.layers.some((l) => l.tag === "div" && l.popover === "manual" && l.overlap === true),
    "その時トップレイヤーにあった要素の説明 (タグ、popover、重なり) が残る");
  const flat = JSON.stringify(entries);
  check(!PII_PARTS.some((s) => flat.includes(s)), "どの記録にも、入力した氏名・電話番号・メールアドレスが含まれない");
  check(extConsole.length === 0, `ページのコンソールに拡張機能の出力が無い${extConsole.length ? ": " + extConsole.slice(0, 3).join(" | ") : ""}`);
  check(!codes.includes("evil.code"), "一覧に無い種類の偽の記録は捨てられる");
  const forged = entries.find((e) => e.code === "egress.blocked" && e.d.dest === "forged.example");
  check(!!forged && forged.src === "page" && !("note" in forged.d), `一覧にある偽の記録は「ページ側から報告」として、決まった項目だけが残る (${JSON.stringify(forged)})`);
  const forged2 = entries.find((e) => e.code === "send.blocked" && e.src === "page");
  check(!!forged2 && !("body" in forged2.d), "一覧に無い項目 (本文) は残らない");

  console.log("T-LG-09 古いログの削除:");
  await sw.evaluate(async () => {
    const old = new Date(); old.setDate(old.getDate() - 15);
    const pad = (n) => String(n).padStart(2, "0");
    const day = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`;
    const { diagLogDays = [] } = await chrome.storage.local.get("diagLogDays");
    await chrome.storage.local.set({
      ["diagLog:" + day]: [{ t: old.getTime(), lv: "info", src: "content", site: "chatgpt.com", code: "send.masked", d: {}, n: 1 }],
      diagLogDays: [day, ...diagLogDays],
    });
    self.__oldDay = day;
  });
  const oldDay = await sw.evaluate(() => self.__oldDay);
  check((await logKeys(sw)).includes("diagLog:" + oldDay), `15 日前のログを入れた (${oldDay})`);
  await sw.evaluate(() => chrome.storage.local.set({ chatTint: "#22c55e" })); // 設定の変更が記録され、そのときに古い日が消える
  await p.waitForTimeout(1500);
  const keysAfter = await logKeys(sw);
  check(!keysAfter.includes("diagLog:" + oldDay), "新しい記録を書くと、15 日前のログは消える");
  const days = await sw.evaluate(() => chrome.storage.local.get("diagLogDays").then((s) => s.diagLogDays));
  check(Array.isArray(days) && !days.includes(oldDay), "日付の一覧からも外れる");
  check((await logEntries(sw)).some((e) => e.code === "settings.changed" && e.d.what === "tint"), "設定の変更 (背景色) が、値なしで記録される");

  console.log("T-LG-07 設定画面の「ログ」タブ:");
  const opt = await ctx.newPage();
  opt.on("console", (m) => extConsole.push(`options ${m.type()}: ${m.text().slice(0, 120)}`));
  await opt.goto(`chrome-extension://${extId}/options.html`); await opt.waitForTimeout(800);
  check(await opt.evaluate(() => !document.getElementById("tab-settings").hidden && document.getElementById("tab-log").hidden), "最初は「設定」のタブが開く");
  await opt.click("#tabbtn-log"); await opt.waitForTimeout(800);
  const rows = () => opt.evaluate(() => [...document.querySelectorAll("#log-rows tr")].map((tr) => [...tr.children].map((td) => td.textContent)));
  let r = await rows();
  check(await opt.evaluate(() => document.getElementById("tab-settings").hidden && !document.getElementById("tab-log").hidden), "「ログ」を押すとログのタブに切り替わる");
  check(r.some((c) => /送信を伏せ字にしました/.test(c[3]) && c[2] === "chatgpt.com"), "送信を伏せ字にした記録が、場所つきで出る");
  check(r.some((c) => /入力欄のアイコンへのクリックを受け付けませんでした/.test(c[3]) && c[1] === "注意"), "受け付けなかったクリックが「注意」として出る");
  check(r.some((c) => /ページ側から報告/.test(c[3])), "ページの世界からの記録には「ページ側から報告」と添える");
  check(r.every((c) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c[0])), "日時は「年-月-日 時:分:秒」");
  await opt.selectOption("#log-level", "warn"); await opt.waitForTimeout(400);
  r = await rows();
  check(r.length > 0 && r.every((c) => c[1] === "注意" || c[1] === "エラー"), `「注意とエラー」で絞れる (${r.length} 件)`);
  await opt.selectOption("#log-level", "all");
  await opt.selectOption("#log-days", "1"); await opt.waitForTimeout(400);
  check((await rows()).length > 0, "「今日」でも今日の記録は出る");
  await opt.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await opt.click("#log-copy"); await opt.waitForTimeout(300);
  const copied = await opt.evaluate(() => window.__copied);
  check(typeof copied === "string" && /^PII Guard \d+\.\d+\.\d+ の動作ログ/.test(copied) && copied.split("\n").length >= 3, "「コピー」で、見出しと記録の行がコピーされる");
  check(typeof copied === "string" && !PII_PARTS.some((s) => copied.includes(s)), "コピーした文にも入力した値は無い");
  opt.once("dialog", (d) => d.accept());
  await opt.click("#log-clear"); await opt.waitForTimeout(800);
  check((await rows()).length === 0 && await opt.evaluate(() => !document.getElementById("log-empty").hidden), "「すべて消す」で一覧が空になる");
  check((await logKeys(sw)).length === 0, "保存されたログも消える");
  await opt.goto(`chrome-extension://${extId}/options.html#log`); await opt.waitForTimeout(800);
  check(await opt.evaluate(() => !document.getElementById("tab-log").hidden), "options.html#log でログのタブが直接開く");
  await opt.close();

  check(extConsole.length === 0, `最後まで、拡張機能のコンソール出力が無い${extConsole.length ? ": " + extConsole.slice(0, 3).join(" | ") : ""}`);
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
