// tests/integration/verify-other-sites.mjs — Claude / Gemini / Manus の実サイト確認 (手動実行)。
//
// 使い方: 拡張を読み込んだ Chrome を --remote-debugging-port=<port> で起動し、
//   node tests/integration/verify-other-sites.mjs [claude|gemini|manus] [--port=9333] [--wait-login=<秒>] [--shots=<dir>]
// - 開いたタブは閉じない (ログインが要るなら、そのタブで利用者がログインできる)。
// - --wait-login を付けると、ログイン画面のあいだは指定秒数までログインを待ってから確認する
//   (待つあいだは画面に触らない)。
// - 送信はしない。入力欄に架空の個人情報を 1 行打ち、打ち終わり・フォーカスを外したあと・
//   下書きの入った入力欄をクリックしたあと (クリックした要素の文字を拾う自動計測がある。
//   2026-10-18 に Manus の Amplitude で実測) の数秒間に、ブラウザから出ようとした通信を調べる。対象は全タブ・iframe・Worker・Service Worker の
//   リクエスト (URL/ヘッダー/本文) と WebSocket の送信フレーム (tests/fixtures/cdp-recorder.mjs)。
//   打った値とその変換形 (全角・URL エンコード・JSON エスケープ・Base64) を
//   browser-extension/security/leak-detector.js で探す。最後に下書きを消す。
// - 拡張の読み込み (ピル、MAIN world の送信フック、Secure Composer が ChatGPT 以外で動いて
//   いないこと) と、添付の入口 (file input) の有無も見る。ピルの中身は閉じた shadow root なので
//   ページからは読めない。見た目は --shots で入力後の画面を撮って確かめる (架空の値だけが写る)。
import { chromium } from "playwright";
import path from "node:path";
import { createRequire } from "node:module";
import { startCdpRecorder } from "../fixtures/cdp-recorder.mjs";

const require = createRequire(import.meta.url);
const leak = require("../../browser-extension/security/leak-detector.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANARY = "PIIGUARDOTHERSITE" + Date.now().toString(36).toUpperCase();
const PHONE = "090-1234-5678";
const EMAIL = "taro.yamada@example.test";
const NEEDLES = [CANARY, PHONE, EMAIL, "09012345678"];
const DRAFT = `${CANARY} 電話 ${PHONE} メール ${EMAIL}`;

const SITES = {
  claude: {
    url: "https://claude.ai/new",
    host: /(^|\.)claude\.(ai|com)$/,
    login: /\/(login|signup|sign-up|auth|magic-link|onboarding)(\/|$|\?)/,
    editor: 'div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
  },
  gemini: {
    url: "https://gemini.google.com/app",
    host: /^(gemini|accounts)\.google\.com$/, // ログインは accounts.google.com で行う
    login: /^https:\/\/accounts\.google\.com\//,
    editor: 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]',
  },
  manus: {
    url: "https://manus.im/app",
    host: /(^|\.)manus\.im$/,
    login: /\/(login|signup|sign-up|register|auth)(\/|$|\?)/,
    editor: 'textarea, [contenteditable="true"]',
  },
};

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const opt = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const port = opt("port", "9333");
const waitLoginSec = Number(opt("wait-login", "0")) || 0;
const shotsDir = opt("shots", "");
const names = only.length ? only : Object.keys(SITES);

const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return ""; } };
const isLocal = (u) => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostOf(u));

async function visibleEditor(page, site) {
  try {
    return await page.evaluate((sel) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 40 && r.height > 10 && cs.visibility !== "hidden" && cs.display !== "none"; };
      const ed = [...document.querySelectorAll(sel)].find(vis);
      return ed ? `${ed.tagName.toLowerCase()}${ed.id ? "#" + ed.id : ""}${typeof ed.className === "string" && ed.className ? "." + ed.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}` : null;
    }, site.editor);
  } catch (_) { return null; } // 画面遷移中
}

// そのサイトのタブを探す (無ければブラウザ側で開く: Playwright の newPage は切断時に閉じるので使わない)。
// ホスト名だけで選ぶ (ログイン画面の URL の形は他サイトと同じことがあるので、それでは選ばない)。
async function findOrOpen(browser, ctx, site) {
  const mine = () => ctx.pages().filter((p) => site.host.test(hostOf(p.url())));
  if (!mine().length) {
    const bs = await browser.newBrowserCDPSession();
    await bs.send("Target.createTarget", { url: site.url });
    await bs.detach().catch(() => {});
    for (let i = 0; i < 100 && !mine().length; i++) await sleep(200);
  }
  return mine;
}

// ログイン済み = ログイン画面でなく、入力欄が見えている。どのタブでログインしてもよい。
async function waitLoggedIn(mine, site) {
  const start = Date.now();
  let navigated = false;
  let notLoginSince = 0;
  for (;;) {
    for (const p of mine()) {
      if (site.login.test(p.url())) continue;
      const editor = await visibleEditor(p, site);
      if (editor) return { page: p, editor, waitedSec: Math.round((Date.now() - start) / 1000) };
    }
    // ログイン画面ではないのに入力欄が無い (トップページ等) が続いたら、一度だけ入力欄のページへ移る
    const off = mine().find((p) => !site.login.test(p.url()));
    if (off && !navigated) {
      notLoginSince = notLoginSince || Date.now();
      if (Date.now() - notLoginSince > 10000) { navigated = true; await off.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); }
    } else if (!off) notLoginSince = 0;
    if ((Date.now() - start) / 1000 >= waitLoginSec) {
      const p = mine()[0];
      return { page: null, url: p ? p.url() : null, waitedSec: Math.round((Date.now() - start) / 1000) };
    }
    await sleep(3000);
  }
}

async function extensionState(page) {
  return page.evaluate(() => ({
    pill: !!document.querySelector('div[data-pii-guard="composer-toggle"]'),
    secureComposer: !!document.querySelector("[data-pii-guard-secure]"),
    mainWorldNs: typeof window.__localMaskMCP === "object" && window.__localMaskMCP !== null,
    fetchHooked: !/\[native code\]/.test(Function.prototype.toString.call(window.fetch)),
    fileInputs: [...document.querySelectorAll('input[type="file"]')].map((i) => i.accept || "*"),
  })).catch((e) => ({ error: String(e.message || e).split("\n")[0] }));
}

function analyze(recorder, t0) {
  const external = [];
  const local = [];
  let unreadBodies = 0;
  const writes = new Set();
  for (const r of recorder.all()) {
    if (r.t < t0 || !r.url || /^(chrome-extension|data|blob):/.test(r.url)) continue;
    if (r.method !== "GET") writes.add(`${r.method} ${hostOf(r.url)}${(() => { try { return new URL(r.url).pathname.slice(0, 60); } catch (_) { return ""; } })()}`);
    if (r.hasPostData && r.body == null) unreadBodies++;
    const hits = leak.scanRequest(r, NEEDLES);
    if (!hits.length) continue;
    const row = { method: r.method, url: r.url.replace(/\?.*$/, "").slice(0, 120), from: r.target ? r.target.type : null, kinds: [...new Set(hits.map((h) => `${["canary", "phone", "email", "phone-digits"][h.index]}:${h.kind}@${h.field}`))] };
    (isLocal(r.url) ? local : external).push(row);
  }
  const ws = recorder.wsFrames.filter((f) => f.t >= t0 && leak.findLeaks(f.data, NEEDLES).length).map((f) => ({ url: (f.url || "").replace(/\?.*$/, "").slice(0, 100) }));
  return { external, local, ws, writes: [...writes].slice(0, 20), unreadBodies };
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const out = { canary: CANARY, result: {} };
try {
  const ctx = browser.contexts()[0];
  const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  for (const name of names) {
    const site = SITES[name];
    if (!site) { out.result[name] = { error: "unknown site" }; continue; }
    const mine = await findOrOpen(browser, ctx, site);
    const w = await waitLoggedIn(mine, site);
    if (!w.page) { out.result[name] = { composerReady: false, url: w.url, waitedSec: w.waitedSec }; continue; }
    const page = w.page;
    await sleep(3000); // ログイン直後の読み込みと拡張の初期化を待つ
    const r = { composerReady: true, waitedSec: w.waitedSec, url: page.url().replace(/\?.*$/, ""), editor: w.editor, extension: await extensionState(page) };

    const recorder = await startCdpRecorder(webSocketDebuggerUrl);
    try {
      await sleep(1500); // 全ターゲットへの attach を待つ
      const t0 = Date.now();
      const ed = page.locator(site.editor).filter({ visible: true }).first();
      await ed.click({ timeout: 5000 });
      await ed.pressSequentially(DRAFT, { delay: 25 });
      await sleep(10000);                                     // 入力中の送信 (下書き保存・予測・計測) を待つ
      await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }).catch(() => {});
      await sleep(4000);                                      // フォーカスを外したときの保存も見る
      if (shotsDir) { r.shot = path.join(shotsDir, `${name}-typed.png`); await page.screenshot({ path: r.shot }).catch(() => { r.shot = null; }); }
      // 下書きの入った入力欄をクリックする (編集で普通に起きる操作)。クリック計測の送信を待つ
      await ed.click({ timeout: 5000 }).catch(() => {});
      await sleep(4000);
      // 下書きを消す (送らない)
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await sleep(3000);
      r.draftCleared = await page.evaluate((sel) => [...document.querySelectorAll(sel)].every((el) => ((el.value ?? el.innerText) || "").replace(/\s+/g, "").length === 0 || !el.getBoundingClientRect().width), site.editor).catch(() => null);
      await recorder.settle(1500);
      r.network = analyze(recorder, t0);
      r.preSubmitLeak = r.network.external.length + r.network.ws.length;
    } catch (e) {
      r.error = String(e.message || e).split("\n")[0];
    } finally {
      await recorder.close();
    }
    out.result[name] = r;
  }
} finally {
  await browser.close(); // connectOverCDP の close は切断だけ (ブラウザもタブも閉じない)
}
console.log(JSON.stringify(out, null, 2));
