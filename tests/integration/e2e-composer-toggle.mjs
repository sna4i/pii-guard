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
//   T-09 クリックジャッキング: 偽の見た目に覆われた「追加」やスイッチは効かない。ホストを透明にされると確認を取り消す
//   T-08 ページのスクリプトが送った set-enabled では設定が変わらず、add-allowlist は確認なしには保存されない
//        (保存の確定は isolated world の閉じた UI で行う)
//   T-13 ログイン後の ChatGPT の下の段を再現したモックで、場所取りがマイクの直前に入り、アイコンが重なる
//   T-14 警告ではアイコンが黄色になり、場所取りは変わらない。黄色のアイコンを押すと内訳が出る
//   T-15 アイコンが動いた直後のクリックは受け付けない
//   T-16 オンのとき、チャットの背景に選んだ色を混ぜる。オフと暗い表示にも追従する
//   T-17 設定画面のパレットで選んだ色が保存され、開いているタブにすぐ反映する
//   T-20 チャットした後の画面で、アイコンが入力欄の上の注意書きに重ならない
//
// 使い方: node tests/integration/e2e-composer-toggle.mjs <unpacked 拡張機能ディレクトリ>
// 環境変数 PII_E2E_SHOTS=<ディレクトリ> を付けると、下の段に置いたときの見た目を保存する
// モックサーバとブラウザはこのスクリプト自身が起動し、finally で必ず閉じる。
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import { chromium } from "playwright";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TINT = require("../../browser-extension/tint.js");

const EXT_ARG = process.argv[2];
if (!EXT_ARG) { console.error("usage: node tests/integration/e2e-composer-toggle.mjs <unpacked-dir>"); process.exit(2); }
const EXT = path.resolve(EXT_ARG);

const PII = "田中様 (090-1234-5678, tanaka@example.co.jp) に見積もりを送ります";
const CLEAN = "明日の天気を教えてください";
const HOST = 'div[data-pii-guard="composer-toggle"]';
const ED = '#prompt-textarea, div.ProseMirror[contenteditable="true"]';

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
// ログイン後の ChatGPT の入力欄 (利用者が貼った HTML の構造と data 属性を残し、クラス名は必要なものだけにしたもの)
const COMPOSER_CSS = `
html,body{margin:0;height:100%;background:#fcfcfc;color:#0d0d0d}
body{display:flex;flex-direction:column}
main{flex:1;background:#fcfcfc;display:flex;flex-direction:column;justify-content:flex-end;padding:0 24px 24px}
.surface{background:#ffffff;border:1px solid #e5e5e5;border-radius:28px;padding:8px 10px;max-width:760px;margin:0 auto;width:100%;box-sizing:border-box}
[data-composer-footer-responsive]{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:4px}
.flex{display:flex}.items-center{align-items:center}.gap5{gap:5px}.contents{display:contents}.min-w-0{min-width:0}
.btn{width:36px;height:36px;border-radius:50%;border:0;background:transparent;font-size:18px;cursor:pointer;color:inherit}
.ProseMirror{min-height:24px;outline:none;padding:6px 4px}.ProseMirror p{margin:0}
.msgs{flex:1;max-width:760px;margin:0 auto;width:100%;padding-top:24px}
.bubble{background:#1f4380;color:#fff;border-radius:18px;padding:10px 14px;margin-left:auto;max-width:70%}
.disclaimer{text-align:center;font-size:12px;color:#666;margin:6px 0}
@media (prefers-color-scheme: dark){html,body,main{background:#000;color:#ececec}.surface{background:#303030;border-color:#444}}
`;
const MIC = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><use href="/cdn/assets/icons-9453d99f50597150.svg#microphone-light-16" fill="currentColor"></use></svg>🎤';
const dockableComposer = () => `<div class="surface"><div class="ComposerLayoutFooter-_8IVRO" data-composer-footer-responsive="" data-composer-layout="single-line">
<div class="min-w-0"><div class="flex min-w-0 items-center gap5"><div class="flex items-center"><span data-state="closed" class="contents"><button type="button" class="btn" aria-label="ファイルなどを追加" data-composer-navigation-target="add-context">+</button></span></div></div></div>
<div class="min-w-0"><div data-composer-input=""><div contenteditable="true" role="textbox" class="ProseMirror" aria-label="ChatGPT に聞く"><p><br></p></div></div></div>
<div class="min-w-0"><div class="contents"><div class="flex min-w-0 items-center"><div class="flex min-w-0 justify-end"><div class="flex items-center"><span data-state="closed" class="contents"><button type="button" aria-label="ChatGPT モデルを選択" data-composer-navigation-target="reasoning" style="height:36px;border:0;background:transparent;color:inherit">思考量 中程度</button></span></div></div>
<div class="flex items-center"><div class="flex items-center"><span data-state="closed" class="contents"><button type="button" class="btn" aria-label="音声入力">${MIC}</button></span></div><div class="flex items-center" style="margin-left:8px"><button type="button" class="btn" aria-label="音声会話を開始">◉</button></div></div></div></div></div>
</div></div>`;
// 目印の無い入力欄 (下の段に置けないとき)
const plainComposer = () => `<div class="surface"><div contenteditable="true" role="textbox" class="ProseMirror" aria-label="ChatGPT に聞く"><p><br></p></div></div>`;
const footerPage = () => `<!doctype html><title>mock</title><style>${COMPOSER_CSS}</style>
<main><h1 style="font-size:16px">mock chatgpt.com (logged-in composer)</h1>${dockableComposer()}</main>`;
// 一回チャットした後の画面: 会話の下に注意書き、その下に入力欄 (利用者のスクリーンショットの並び)
const chatPage = (composer) => `<!doctype html><title>mock</title><style>${COMPOSER_CSS}</style>
<main><div class="msgs"><div class="bubble">この記事を要約して、価格がわかるサイトがあったら教えて</div><p>記事の仕様を確認し、公式情報と価格情報を照合します。</p></div>
<div class="disclaimer" id="disclaimer">ChatGPT は間違えることがあります。重要な情報は確認するようにしてください。</div>${composer}</main>`;

// ピルは閉じた Shadow DOM なので、ホストの data 属性 (状態と部品の位置) を読み、本物のマウスで押す
const pillState = (p) => p.evaluate((sel) => {
  const h = document.querySelector(sel);
  if (!h) return null;
  return { on: h.dataset.enabled, warn: h.dataset.warn != null && h.dataset.warn !== "0", count: h.dataset.warn };
}, HOST);
const clickInPill = async (p, part) => {
  const box = await p.evaluate(([sel, k]) => {
    const h = document.querySelector(sel);
    const layout = h && h.dataset.layout ? JSON.parse(h.dataset.layout) : null;
    const r = layout && layout[k];
    return r ? { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 } : null;
  }, [HOST, part]);
  if (!box) return false;
  await p.mouse.click(box.x, box.y);
  return true;
};
// 保存の確認バブル (別の閉じた Shadow DOM ホスト)。状態と位置は data 属性で読む
const CONFIRM = 'div[data-pii-guard="persist-confirm"]';
const confirmState = (p) => p.evaluate((sel) => {
  const h = document.querySelector(sel);
  return h ? { pending: h.dataset.pending || "", layout: h.dataset.layout || "" } : null;
}, CONFIRM);
const clickConfirm = async (p, part) => {
  const box = await p.evaluate(([sel, k]) => {
    const h = document.querySelector(sel);
    const layout = h && h.dataset.layout ? JSON.parse(h.dataset.layout) : null;
    const r = layout && layout[k];
    return r ? { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 } : null;
  }, [CONFIRM, part]);
  if (!box) return false;
  await p.mouse.click(box.x, box.y);
  return true;
};
const sidebarHost = (p) => p.evaluateHandle(() => [...document.querySelectorAll("body *")].find((e) => e.shadowRoot && e.shadowRoot.querySelector("button")));
const sidebarOpen = async (p) => {
  const h = await sidebarHost(p);
  return h.evaluate((e) => !!(e && e.shadowRoot && [...e.shadowRoot.querySelectorAll("button")].some((b) => /マスク/.test(b.textContent))));
};
const confirmSidebar = async (p) => {
  const h = await sidebarHost(p);
  return h.evaluate((e) => { const b = [...e.shadowRoot.querySelectorAll("button")].find((x) => /選択したものをマスク/.test(x.textContent)); if (b) b.click(); return b ? b.textContent.trim() : null; });
};
const composerText = (p) => p.evaluate((sel) => { const el = document.querySelector(sel); return el ? (el.tagName === "TEXTAREA" ? el.value : el.innerText).replace(/\n+$/, "") : null; }, ED);
const typeInto = async (p, text) => {
  await p.click(ED);
  await p.evaluate((sel) => { const el = document.querySelector(sel); if (el.tagName === "TEXTAREA") { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else el.textContent = ""; }, ED);
  await p.keyboard.type(text);
  await p.waitForTimeout(900); // debounce 400ms + 検出
};
const layoutOf = (p) => p.evaluate((sel) => { const h = document.querySelector(sel); return h && h.dataset.layout ? JSON.parse(h.dataset.layout) : null; }, HOST);
const dockState = (p) => p.evaluate((sel) => {
  const mic = document.querySelector('button:has(svg use[href*="#microphone"])');
  const sp = document.querySelector('span[data-pii-guard="dock"]');
  const h = document.querySelector(sel);
  const lay = h && h.dataset.layout ? JSON.parse(h.dataset.layout) : null;
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const slot = mic && mic.closest("span.contents");
  return { docked: h ? h.dataset.docked : null, tone: h ? h.dataset.tone : null, spacer: r(sp), mic: r(mic), toggle: lay && lay.toggle, beforeMic: !!(sp && slot && slot.previousElementSibling === sp) };
}, HOST);
const overlaps = (a, b) => !!(a && b && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]);
const rectOf = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }, sel);
const SHOTS = process.env.PII_E2E_SHOTS ? path.resolve(process.env.PII_E2E_SHOTS) : null;
const shotFooter = async (p, name) => {
  if (!SHOTS) return;
  const box = await p.evaluate(() => { const b = document.querySelector(".surface").getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), clip: { x: box[0] - 16, y: Math.max(0, box[1] - 220), width: box[2] + 32, height: box[3] + 236 } });
};
const bgOf = (p, sel) => p.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url.startsWith("/footer")) { res.end(footerPage()); return; }
    if (req.url.startsWith("/chat-plain")) { res.end(chatPage(plainComposer())); return; }
    if (req.url.startsWith("/chat")) { res.end(chatPage(dockableComposer())); return; }
    const kind = req.url.startsWith("/ce") ? "ce" : req.url.startsWith("/none") ? "none" : "ta";
    res.end(page(kind));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ctx = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    headless: false, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}`, "--ignore-certificate-errors", "--no-sandbox"],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  await sw.evaluate(async () => { for (let i = 0; i < 100; i++) { const s = await chrome.storage.local.get(["enabled"]); if (typeof s.enabled === "boolean") return; await new Promise((r) => setTimeout(r, 100)); } });
  // 閉じた Shadow DOM の中の位置と状態は、このフラグがあるときだけホストの data 属性に出る (ページには出さない)
  await sw.evaluate(() => chrome.storage.local.set({ __pii_guard_e2e: true }));
  const errs = [];
  const logs = [];
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errs.push(String(e)));
  p.on("console", (m) => { const s = m.text(); if (s.includes("[pii-guard]")) logs.push(s); });

  console.log("T-02 ピルの表示:");
  await p.goto("https://chatgpt.com/none"); await p.waitForTimeout(3500);
  check((await pillState(p)) === null, "入力欄が無いページではピルが出ない");
  await p.goto("https://chatgpt.com/ta"); await p.waitForTimeout(3500);
  let st = await pillState(p);
  check(st && st.on === "true", `入力欄があるページではアイコンが出て、オン (${JSON.stringify(st)})`);
  const lay0 = await layoutOf(p);
  check(lay0 && lay0.toggle && lay0.toggle[2] <= 40 && lay0.toggle[3] <= 40, `表示はアイコンだけ (${lay0 && lay0.toggle && lay0.toggle.slice(2).join("x")})`);

  console.log("T-07 ピルでオフ:");
  await clickInPill(p, "toggle");
  await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === false, "保存された enabled が false になる");
  st = await pillState(p);
  check(st && st.on === "false", "ピルがオフ表示になる");

  console.log("T-08 ページのスクリプトからの偽の設定変更:");
  await p.waitForTimeout(1500); // 直前の本物のクリックの受け付け窓 (0.5 秒) を過ぎてから送る
  await p.evaluate(() => window.postMessage({ source: "mask-mcp-inpage", type: "set-enabled", value: true }, "*"));
  await p.evaluate(() => window.postMessage({ source: "mask-mcp-inpage", type: "add-allowlist", value: "forged@example.com" }, "*"));
  await p.waitForTimeout(1200);
  check((await stored(sw, "enabled")) === false, "ページからの set-enabled では設定が変わらない");
  check(!((await stored(sw, "maskAllowlist")) || []).includes("forged@example.com"), "ページからの add-allowlist は確認なしには保存されない");
  let cs = await confirmState(p);
  check(cs && cs.pending === "add-allowlist", `保存の確認が利用者に見える形で出る (${cs && cs.pending})`);
  await clickConfirm(p, "cancel");
  await p.waitForTimeout(600);
  check(!((await stored(sw, "maskAllowlist")) || []).includes("forged@example.com"), "キャンセルすれば保存されない");
  st = await pillState(p);
  check(st && st.on === "false", "ピルもオフのまま");

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
  await clickInPill(p, "toggle");
  await p.waitForTimeout(500);
  await clickInPill(p, "maskOnce");
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
  await clickInPill(p, "toggle");
  await p.waitForTimeout(500);
  await clickInPill(p, "turnOn");
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
  await clickInPill(p, "toggle");
  await p.waitForTimeout(500);
  await clickInPill(p, "maskOnce");
  await p.waitForTimeout(3000);
  // サイドバーの「除外」を本物のクリックで押す。利用者の操作を伴う設定変更は通ること (T-08 の裏側)。
  // カテゴリは折りたたまれているので、先に見出しを本物のクリックで開く
  const header = await (await sidebarHost(p)).evaluate((e) => {
    const row = [...e.shadowRoot.querySelectorAll(".row")].find((r) => (r.querySelector(".row-value") || {}).textContent === "tanaka@example.co.jp");
    const cat = row && row.closest(".category");
    const h = cat && cat.querySelector(".category-header");
    if (!h) return null;
    const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, collapsed: cat.classList.contains("is-collapsed") };
  });
  if (header && header.collapsed) { await p.mouse.click(header.x, header.y); await p.waitForTimeout(600); }
  const exclude = await (await sidebarHost(p)).evaluate((e) => {
    const row = [...e.shadowRoot.querySelectorAll(".row")].find((r) => (r.querySelector(".row-value") || {}).textContent === "tanaka@example.co.jp");
    const btn = row && [...row.querySelectorAll("button")].find((b) => /除外/.test(b.textContent));
    if (!btn) return null;
    btn.scrollIntoView({ block: "center" });
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  check(!!exclude, "サイドバーに除外ボタンがある");
  if (exclude) { await p.mouse.click(exclude.x, exclude.y); await p.waitForTimeout(1200); }
  check(!((await stored(sw, "maskAllowlist")) || []).includes("tanaka@example.co.jp"), "「除外」を押しただけでは、まだ保存されない");
  cs = await confirmState(p);
  check(cs && cs.pending === "add-allowlist", `保存の確認が出る (${cs && cs.pending})`);
  await clickConfirm(p, "confirm");
  await p.waitForTimeout(800);
  const excludedOk = ((await stored(sw, "maskAllowlist")) || []).includes("tanaka@example.co.jp");
  check(excludedOk, "確認の「追加」を本物のクリックで押すと保存される");
  if (!excludedOk) {
    const btnText = await (await sidebarHost(p)).evaluate((e) => {
      const row = [...e.shadowRoot.querySelectorAll(".row")].find((r) => (r.querySelector(".row-value") || {}).textContent === "tanaka@example.co.jp");
      const btn = row && [...row.querySelectorAll("button")].find((b) => /除外/.test(b.textContent));
      return btn ? btn.textContent : null;
    });
    console.log(`    診断: ボタンの文言=${JSON.stringify(btnText)} 座標=${JSON.stringify(exclude)}`);
    const hit = await (await sidebarHost(p)).evaluate((e, pt) => {
      const top = document.elementFromPoint(pt.x, pt.y);
      const inner = e.shadowRoot.elementFromPoint(pt.x, pt.y);
      const d = (n) => (n ? `${n.tagName.toLowerCase()}.${String(n.className).replace(/\s+/g, ".")}` : null);
      return { top: d(top), inner: d(inner), viewport: `${innerWidth}x${innerHeight}` };
    }, exclude);
    console.log(`    診断: その座標にある要素=${JSON.stringify(hit)}`);
    for (const l of logs.filter((l) => /ignored|allowlist|除外/.test(l)).slice(-5)) console.log(`    診断: ${l.slice(0, 160)}`);
  }
  await confirmSidebar(p);
  await p.waitForTimeout(2500);
  const after3 = await composerText(p);
  check(after3 && !after3.includes("090-1234-5678") && after3.includes("tanaka@example.co.jp") && /<[A-Z_]+_\d+>/.test(after3), `contenteditable でも伏せ字に置き換わり、除外した値は残る (${after3})`);

  console.log("T-09 クリックジャッキングへの耐性:");
  await p.goto("https://chatgpt.com/ta"); await p.waitForTimeout(3500);
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await p.waitForTimeout(800);
  // (a) サイトが pointer-events: none の偽の見た目をかぶせ、その下の「追加」を押させる
  await p.evaluate(() => window.postMessage({ source: "mask-mcp-inpage", type: "add-allowlist", value: "jacked@example.com" }, "*"));
  await p.waitForTimeout(1200);
  const decoy = await p.evaluate((sel) => {
    const h = document.querySelector(sel);
    const r = JSON.parse(h.dataset.layout).confirm;
    const d = document.createElement("div");
    d.id = "decoy";
    d.style.cssText = `position:fixed;left:${r[0] - 10}px;top:${r[1] - 10}px;width:${r[2] + 20}px;height:${r[3] + 20}px;z-index:2147483647;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;pointer-events:none;`;
    d.textContent = "送信";
    document.documentElement.appendChild(d);
    return { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 };
  }, CONFIRM);
  await p.waitForTimeout(800);
  await p.mouse.click(decoy.x, decoy.y);
  await p.waitForTimeout(800);
  check(!((await stored(sw, "maskAllowlist")) || []).includes("jacked@example.com"), "偽の見た目に覆われた「追加」のクリックは受け付けない");
  await p.evaluate(() => document.getElementById("decoy").remove());
  await p.waitForTimeout(800);
  // (b) サイトがホストを透明にする → 保留中の確認は取り消され、スタイルは元に戻る
  await p.evaluate((sel) => { document.querySelector(sel).style.opacity = "0"; }, CONFIRM);
  await p.waitForTimeout(800);
  const tampered = await p.evaluate((sel) => { const h = document.querySelector(sel); return { opacity: getComputedStyle(h).opacity, pending: h.dataset.pending || "" }; }, CONFIRM);
  check(tampered.opacity === "1" && tampered.pending === "", `ホストを透明にされると、スタイルを戻して確認を取り消す (opacity=${tampered.opacity}, pending=${JSON.stringify(tampered.pending)})`);
  check(!((await stored(sw, "maskAllowlist")) || []).includes("jacked@example.com"), "取り消された確認は保存されない");
  // (c) ピルのスイッチに偽の見た目をかぶせて押させても、設定は変わらない
  const sw2 = await p.evaluate((sel) => {
    const h = document.querySelector(sel);
    const r = JSON.parse(h.dataset.layout).toggle;
    const d = document.createElement("div");
    d.id = "decoy2";
    d.style.cssText = `position:fixed;left:${r[0] - 6}px;top:${r[1] - 6}px;width:${r[2] + 12}px;height:${r[3] + 12}px;z-index:2147483647;background:#16a34a;pointer-events:none;`;
    document.documentElement.appendChild(d);
    return { x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 };
  }, HOST);
  await p.waitForTimeout(800);
  await p.mouse.click(sw2.x, sw2.y);
  await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === false, "偽の見た目に覆われたスイッチのクリックは受け付けない");
  await p.evaluate(() => document.getElementById("decoy2").remove());
  await p.waitForTimeout(800);
  await clickInPill(p, "toggle");
  await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === true, "覆いを外せば、本物のクリックでスイッチが効く");

  console.log("T-13 下の段への配置 (ログイン後の ChatGPT を再現したモック):");
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true, chatTint: null }));
  await p.goto("https://chatgpt.com/footer"); await p.waitForTimeout(3500);
  let d = await dockState(p);
  check(d.spacer && d.beforeMic, `場所取りの要素がマイクの直前に入る (${JSON.stringify(d.spacer)})`);
  check(d.docked === "true" && d.toggle && d.spacer && Math.abs(d.toggle[0] - d.spacer[0]) <= 2 && Math.abs((d.toggle[1] + d.toggle[3] / 2) - (d.spacer[1] + d.spacer[3] / 2)) <= 2,
    `アイコンが場所取りの位置に重なる (toggle=${JSON.stringify(d.toggle)})`);
  check(d.toggle && d.mic && d.toggle[2] === d.mic[2] && d.toggle[3] === d.mic[3], `アイコンの大きさがマイクと同じ (${d.toggle && d.toggle.slice(2).join("x")})`);
  check(d.toggle && d.mic && d.toggle[0] + d.toggle[2] <= d.mic[0] + 1, "アイコンはマイクの左にある");
  await shotFooter(p, "footer-on");
  await clickInPill(p, "toggle"); await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === false, "アイコンを本物のクリックで押すとオフになる");
  await clickInPill(p, "toggle"); await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === true, "もう一度押すとオンに戻る");
  await p.evaluate(() => document.querySelector('span[data-pii-guard="dock"]').remove());
  await p.waitForTimeout(1800);
  d = await dockState(p);
  check(d.spacer && d.beforeMic, "場所取りの要素を消されても入れ直す");

  console.log("T-14 警告はアイコンを黄色にする:");
  await clickInPill(p, "toggle"); await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === false, "オフにする");
  d = await dockState(p);
  const w0 = d.spacer[2];
  const x0 = d.toggle[0];
  check(d.tone === "off", `オフの表示 (${d.tone})`);
  await typeInto(p, PII);
  st = await pillState(p);
  d = await dockState(p);
  check(st && st.warn && d.tone === "warning", `オフで個人情報を入力すると、アイコンが黄色になる (tone=${d.tone}, 件数=${st && st.count})`);
  check(d.spacer && d.spacer[2] === w0, `場所取りの幅は変わらない (${w0}px → ${d.spacer && d.spacer[2]}px)`);
  check(d.toggle && Math.abs(d.toggle[0] - x0) <= 1, "アイコンの位置も変わらない");
  await shotFooter(p, "footer-off-warning");
  await clickInPill(p, "toggle"); await p.waitForTimeout(500);
  let lay = await layoutOf(p);
  check(lay && lay.turnOn && lay.maskOnce && lay.close, "黄色のアイコンを押すと内訳と「オンにする」「マスキングする」が出る");
  check((await stored(sw, "enabled")) === false, "黄色のアイコンを押してもオン/オフは変わらない");
  await shotFooter(p, "footer-off-warning-open");
  await clickInPill(p, "close"); await p.waitForTimeout(400);
  await typeInto(p, CLEAN);
  d = await dockState(p);
  check(d.tone === "off", "個人情報を消すと黄色が消える");

  console.log("T-15 動いた直後のクリック:");
  const before = (await dockState(p)).toggle;
  // アイコンはマイクの左 (右端の列) にあるので、右の余白で下の段の右端を左へずらす
  await p.evaluate(() => { document.querySelector("[data-composer-footer-responsive]").style.paddingRight = "120px"; });
  let moved = null;
  for (let i = 0; i < 40 && !moved; i++) {
    await p.waitForTimeout(50);
    const tg = (await dockState(p)).toggle;
    if (tg && Math.abs(tg[0] - before[0]) > 50) moved = tg;
  }
  check(!!moved, "下の段が動くと、アイコンもついていく");
  if (moved) {
    await p.mouse.click(moved[0] + moved[2] / 2, moved[1] + moved[3] / 2);
    await p.waitForTimeout(300);
    check((await stored(sw, "enabled")) === false, "動いた直後のクリックは受け付けない");
    await p.waitForTimeout(700);
    await clickInPill(p, "toggle"); await p.waitForTimeout(800);
    check((await stored(sw, "enabled")) === true, "止まって 0.5 秒たてば受け付ける");
  }
  await p.evaluate(() => { document.querySelector("[data-composer-footer-responsive]").style.paddingRight = ""; });
  await p.waitForTimeout(1200);

  console.log("T-16 オンのときの背景色:");
  check(await bgOf(p, "main") === "rgb(252, 252, 252)", "色を選んでいなければ背景は元のまま");
  await sw.evaluate(() => chrome.storage.local.set({ chatTint: "#3b82f6" }));
  await p.waitForTimeout(1200);
  const lightTint = TINT.tintedBackground("#3b82f6", "rgb(252, 252, 252)");
  check(await bgOf(p, "main") === lightTint, `オンで、チャットの背景が選んだ色を混ぜた色になる (${await bgOf(p, "main")})`);
  check(await bgOf(p, "body") === lightTint, "body も同じ色になる");
  check(await bgOf(p, ".surface") === "rgb(255, 255, 255)", "入力欄の箱の色は変わらない");
  await shotFooter(p, "footer-tinted-light");
  await clickInPill(p, "toggle"); await p.waitForTimeout(1000);
  check((await stored(sw, "enabled")) === false && await bgOf(p, "main") === "rgb(252, 252, 252)", "オフにすると元の色に戻る");
  await clickInPill(p, "toggle"); await p.waitForTimeout(1000);
  check(await bgOf(p, "main") === lightTint, "オンに戻すとまた色が付く");
  await p.emulateMedia({ colorScheme: "dark" }); await p.waitForTimeout(1500);
  const darkTint = TINT.tintedBackground("#3b82f6", "rgb(0, 0, 0)");
  check(await bgOf(p, "main") === darkTint, `暗い表示では、暗い背景に混ぜた色になる (${await bgOf(p, "main")})`);
  check(await bgOf(p, ".surface") === "rgb(48, 48, 48)", "暗い表示でも入力欄の箱の色は変わらない");
  await shotFooter(p, "footer-tinted-dark");
  await p.emulateMedia({ colorScheme: "light" }); await p.waitForTimeout(1500);
  check(await bgOf(p, "main") === lightTint, "明るい表示に戻すと明るい側の色に戻る");

  console.log("T-17 設定画面のパレット:");
  const extId = new URL(sw.url()).host;
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`); await opt.waitForTimeout(1200);
  const swatchAt = (value) => opt.evaluate((v) => {
    const input = [...document.querySelectorAll('input[name="chat-tint"]')].find((i) => i.value === v);
    const label = input && input.closest("label");
    if (!label) return null;
    label.scrollIntoView({ block: "center" });
    const r = label.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, value);
  const green = await swatchAt("#22c55e");
  check(!!green, "設定画面に色見本がある");
  if (green) { await opt.mouse.click(green.x, green.y); await opt.waitForTimeout(600); }
  check((await stored(sw, "chatTint")) === "#22c55e", "色見本を押すと保存される");
  check(await opt.evaluate(() => (document.querySelector('input[name="chat-tint"]:checked') || {}).value) === "#22c55e", "押した色見本が選ばれた表示になる");
  await p.bringToFront(); await p.waitForTimeout(800);
  check(await bgOf(p, "main") === TINT.tintedBackground("#22c55e", "rgb(252, 252, 252)"), "開いているタブにすぐ反映する");
  await opt.bringToFront();
  const none = await swatchAt("");
  if (none) { await opt.mouse.click(none.x, none.y); await opt.waitForTimeout(600); }
  check((await stored(sw, "chatTint")) == null, "「なし」を押すと色の設定が消える");
  await opt.evaluate(() => { const c = document.getElementById("chat-tint-custom"); c.value = "#123456"; c.dispatchEvent(new Event("input", { bubbles: true })); c.dispatchEvent(new Event("change", { bubbles: true })); });
  await opt.waitForTimeout(600);
  check((await stored(sw, "chatTint")) === "#123456", "任意の色も保存される");
  await opt.close();
  await p.bringToFront(); await p.waitForTimeout(800);
  check(await bgOf(p, "main") === TINT.tintedBackground("#123456", "rgb(252, 252, 252)"), "任意の色も開いているタブに反映する");
  await sw.evaluate(() => chrome.storage.local.set({ chatTint: null }));
  await p.waitForTimeout(800);
  check(await bgOf(p, "main") === "rgb(252, 252, 252)", "色の設定を消すと元の色に戻る");

  console.log("T-20 チャットした後の画面:");
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true, chatTint: null }));
  await p.goto("https://chatgpt.com/chat"); await p.waitForTimeout(3500);
  d = await dockState(p);
  let disc = await rectOf(p, "#disclaimer");
  check(d.docked === "true" && d.beforeMic, `会話の後でも、マイクの左に置く (docked=${d.docked})`);
  check(!overlaps(d.toggle, disc), `アイコンが注意書きに重ならない (toggle=${JSON.stringify(d.toggle)} 注意書き=${JSON.stringify(disc)})`);
  await shotFooter(p, "chat-docked");
  await p.goto("https://chatgpt.com/chat-plain"); await p.waitForTimeout(3500);
  lay = await layoutOf(p);
  disc = await rectOf(p, "#disclaimer");
  const box = await rectOf(p, ".surface");
  const fl = lay && lay.toggle;
  check((await p.evaluate((s) => { const h = document.querySelector(s); return h && h.dataset.docked; }, HOST)) === "false", "目印が無ければ浮かせる");
  check(fl && box && fl[0] >= box[0] + box[2], `浮かせたアイコンは入力欄の箱の右の外側に出る (toggle=${JSON.stringify(fl)} 箱=${JSON.stringify(box)})`);
  check(fl && box && Math.abs((fl[1] + fl[3] / 2) - (box[1] + box[3] / 2)) <= 2, "縦は箱の中央にそろう");
  check(!overlaps(fl, disc), "浮かせたアイコンも注意書きに重ならない");
  await shotFooter(p, "chat-plain");

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
