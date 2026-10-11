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
  check(st && st.on === "true", `入力欄があるページではピルが出て、オン (${JSON.stringify(st)})`);

  console.log("T-07 ピルでオフ:");
  await clickInPill(p, "switch");
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
  await clickInPill(p, "warn");
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
  await clickInPill(p, "warn");
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
  await clickInPill(p, "warn");
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
    const r = JSON.parse(h.dataset.layout).switch;
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
  await clickInPill(p, "switch");
  await p.waitForTimeout(800);
  check((await stored(sw, "enabled")) === true, "覆いを外せば、本物のクリックでスイッチが効く");

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
