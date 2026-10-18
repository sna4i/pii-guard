// tests/integration/verify-other-sites.mjs — Claude / Gemini / Manus の実サイト確認 (手動実行)。
//
// 使い方: 拡張を読み込んだ Chrome を --remote-debugging-port=<port> で起動し、必要ならログインしてから
//   node tests/integration/verify-other-sites.mjs [claude|gemini|manus] [--port=9333]
// - 開いたタブは閉じない (ログインが要るなら、そのタブで利用者がログインできる)。
// - 送信はしない。入力欄があれば架空の個人情報を 1 行打ち、送信前に通信 (全リクエストの URL/本文と
//   WebSocket の送信フレーム) へ出ないかを CDP で見てから、下書きを消す。
// - 拡張の読み込み (ピル、Secure Composer が ChatGPT 以外で動いていないこと) と拡張のログも見る。
import { chromium } from "playwright";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANARY = "PIIGUARDOTHERSITE" + Date.now().toString(36).toUpperCase();
const PHONE = "090-1234-5678", EMAIL = "taro.yamada@example.test";
const NEEDLES = [CANARY, PHONE, EMAIL, "09012345678", encodeURIComponent(EMAIL)];
const SITES = [
  { name: "claude", url: "https://claude.ai/new", editor: 'div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea' },
  { name: "gemini", url: "https://gemini.google.com/app", editor: 'rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea' },
  { name: "manus", url: "https://manus.im/app", editor: 'textarea, [contenteditable="true"]' },
];
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"));
const port = (args.find((a) => a.startsWith("--port=")) || "--port=9333").slice(7);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const result = {};
try {
  const ctx = browser.contexts()[0];
  for (const site of SITES) {
    if (only && site.name !== only) continue;
    const origin = new URL(site.url).origin;
    let page = ctx.pages().find((p) => p.url().startsWith(origin));
    if (!page) {
      // 切断しても残るよう、ブラウザ側でタブを作る (Playwright の newPage は使わない)
      const bs = await browser.newBrowserCDPSession();
      await bs.send("Target.createTarget", { url: site.url });
      await bs.detach().catch(() => {});
      for (let i = 0; i < 100 && !page; i++) { await sleep(200); page = ctx.pages().find((p) => p.url().startsWith(origin) || p.url().includes(new URL(site.url).hostname.split(".").slice(-2).join("."))); }
      if (!page) { result[site.name] = { error: "tab not found after createTarget" }; continue; }
    }
    const cdp = await ctx.newCDPSession(page);
    const reqs = [];
    const wsFrames = [];
    await cdp.send("Network.enable", { maxPostDataSize: 1 << 20 });
    cdp.on("Network.requestWillBeSent", (e) => reqs.push({ t: Date.now(), url: e.request.url, method: e.request.method, post: e.request.postData || "", hasPost: !!e.request.hasPostData, id: e.requestId }));
    cdp.on("Network.webSocketFrameSent", (e) => wsFrames.push({ t: Date.now(), data: String(e.response && e.response.payloadData || "") }));
    const errors = [];
    page.on("console", (m) => { if (/pii-guard|mask-mcp|localMask/i.test(m.text())) errors.push(m.type() + ": " + m.text().slice(0, 160)); });
    if (page.url() === "about:blank") {
      try { await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45000 }); } catch (e) { result[site.name] = { error: "goto: " + e.message.split("\n")[0] }; continue; }
    }
    await sleep(9000);
    const info = await page.evaluate((sel) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 40 && r.height > 10 && cs.visibility !== "hidden" && cs.display !== "none"; };
      const ed = [...document.querySelectorAll(sel)].find(vis) || null;
      const loginHint = /log ?in|sign ?in|ログイン|サインイン|続行|Continue with/i.test(document.body ? document.body.innerText.slice(0, 4000) : "");
      return {
        url: location.href, title: document.title,
        editor: ed ? `${ed.tagName.toLowerCase()}${ed.id ? "#" + ed.id : ""}.${(ed.className && typeof ed.className === "string" ? ed.className : "").split(/\s+/).slice(0, 2).join(".")}` : null,
        pill: !!document.querySelector('div[data-pii-guard="composer-toggle"]'),
        scOverlay: !!document.querySelector("[data-pii-guard-secure]"),
        tint: !!document.querySelector('[data-pii-guard-tint], [data-pii-guard="tint"]'),
        loginHint,
      };
    }, site.editor);
    const r = { ...info };
    if (info.editor) {
      const t0 = Date.now();
      const ed = page.locator(site.editor).filter({ visible: true }).first();
      await ed.click({ timeout: 5000 }).catch(() => {});
      await ed.pressSequentially(`${CANARY} 電話 ${PHONE} メール ${EMAIL}`, { delay: 25 }).catch((e) => { r.typeError = e.message.split("\n")[0]; });
      await sleep(8000);
      const hits = reqs.filter((q) => q.t >= t0 && NEEDLES.some((n) => q.url.includes(n) || q.post.includes(n))).map((q) => ({ url: q.url.slice(0, 120), method: q.method }));
      const wsHits = wsFrames.filter((f) => f.t >= t0 && NEEDLES.some((n) => f.data.includes(n))).length;
      const postsDuringTyping = reqs.filter((q) => q.t >= t0 && q.method !== "GET").map((q) => q.url.replace(/\?.*$/, "").slice(0, 100));
      r.typed = true;
      r.preSubmitLeaks = hits;
      r.wsLeakFrames = wsHits;
      r.postsWhileTyping = [...new Set(postsDuringTyping)].slice(0, 15);
      r.unseenPostBodies = reqs.filter((q) => q.t >= t0 && q.hasPost && !q.post).length; // 本文を CDP で取れなかった POST
      // 下書きを消す (送らない)
      await ed.click().catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await sleep(500);
      r.clearedDraft = await page.evaluate((sel) => { const el = [...document.querySelectorAll(sel)][0]; return el ? ((el.value ?? el.innerText) || "").trim().length === 0 : null; }, site.editor);
      r.pillAfter = await page.evaluate(() => { const t = document.querySelector('div[data-pii-guard="composer-toggle"] [data-state]'); return t ? t.getAttribute("data-state") : null; });
    }
    r.extConsole = errors.slice(0, 5);
    result[site.name] = r;
    await cdp.detach().catch(() => {});
  }
  console.log(JSON.stringify({ canary: CANARY, result }, null, 2));
} finally { await browser.close(); }
