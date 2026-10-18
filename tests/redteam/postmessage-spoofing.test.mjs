// tests/redteam/postmessage-spoofing.test.mjs — ページのスクリプトからの偽装 (P0-05 / P0-06)
//
// 攻撃者の位置: chatgpt.com のページの JavaScript (page.evaluate は MAIN world で動く)。
// RT-PM-01  機密の設定 (除外リスト・常に伏せる語) をページから読み出せない (P0-05)
// RT-PM-02  ローカル LLM の設定 (URL・モデル) をページから読み出せない (P0-05)
// RT-PM-03  ページが llm-call を偽装しても、設定外の経路・モデルで LLM を叩けない (P0-06 / spec 8.1)
// RT-PM-04  ページから設定 (オン/オフ・除外・常に伏せる語) を変更できない (P0-06)
// RT-PM-05  Secure Composer の iframe にページから postMessage を送っても、送信も設定変更も起きない
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, sleep, writeEvidence } from "../fixtures/harness.mjs";
import { startMockLlm } from "../fixtures/mock-chatgpt/server.mjs";

let h;
let llm;
const FORCE_SECRET = makeCanary("FORCE");
const ALLOW_SECRET = makeCanary("ALLOW");
before(async () => {
  llm = await startMockLlm();
  h = await launch({
    storage: {
      enabled: true,
      maskForceList: [{ value: FORCE_SECRET, category: "OTHER" }],
      maskAllowlist: [ALLOW_SECRET],
      localLlmEnabled: true, localLlmUrl: llm.url, localLlmModel: "qwen3:1.7b", localLlmKind: "ollama",
    },
  });
});
after(async () => { if (h) await h.close(); if (llm) await llm.close(); });

// ページの MAIN world に「届いたメッセージをすべて記録する」盗聴器を仕掛けて開く
async function openWithSniffer() {
  const page = await h.ctx.newPage();
  await page.addInitScript(() => {
    window.__sniffed = [];
    window.addEventListener("message", (e) => { try { window.__sniffed.push(JSON.stringify(e.data)); } catch (_) {} }, true);
  });
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mock && document.querySelector("#composer-root form"));
  await sleep(1500);
  return page;
}

// ページから見える場所 (メッセージ・グローバル・DOM・保存領域) をまとめて調べる
async function pageVisible(page, needles) {
  return page.evaluate((nd) => {
    const found = [];
    const sniffed = (window.__sniffed || []).join("\n");
    let globals = "";
    try { globals = JSON.stringify(window.__localMaskMCP || {}, (k, v) => (typeof v === "function" ? undefined : v)); } catch (_) {}
    const dom = document.documentElement.outerHTML;
    let storage = "";
    try { for (let i = 0; i < localStorage.length; i++) storage += localStorage.key(i) + "=" + localStorage.getItem(localStorage.key(i)); } catch (_) {}
    try { for (let i = 0; i < sessionStorage.length; i++) storage += sessionStorage.key(i) + "=" + sessionStorage.getItem(sessionStorage.key(i)); } catch (_) {}
    for (const [i, n] of nd.entries()) {
      if (sniffed.includes(n)) found.push({ i, where: "postMessage" });
      if (globals.includes(n)) found.push({ i, where: "window.__localMaskMCP" });
      if (dom.includes(n)) found.push({ i, where: "DOM" });
      if (storage.includes(n)) found.push({ i, where: "web storage" });
    }
    return found;
  }, needles);
}

test("RT-PM-01 除外リスト・常に伏せる語をページから読み出せない (P0-05)", async () => {
  const page = await openWithSniffer();
  // 改修前は、この要求で content script が設定一式を "*" 宛てに配り直す
  await page.evaluate(() => window.postMessage({ source: "mask-mcp-inpage", type: "request-settings" }, "*"));
  await sleep(800);
  const found = await pageVisible(page, [FORCE_SECRET, ALLOW_SECRET]);
  writeEvidence("rt-pm-01", { found });
  await page.close();
  assert.deepEqual(found, [], `ページから機密の設定が見えた: ${JSON.stringify(found)}`);
});

test("RT-PM-02 ローカル LLM の URL・モデルをページから読み出せない (P0-05)", async () => {
  const page = await openWithSniffer();
  const res = await page.evaluate(() => new Promise((resolve) => {
    const id = "spoof-llm-config";
    const on = (e) => { if (e.data && e.data.id === id && e.data.type === "llm-config-result") { window.removeEventListener("message", on); resolve(e.data); } };
    window.addEventListener("message", on);
    window.postMessage({ source: "mask-mcp-inpage", id, type: "llm-config" }, "*");
    setTimeout(() => resolve(null), 2000);
  }));
  const leakedUrl = JSON.stringify(res || {}).includes(String(llm.port));
  writeEvidence("rt-pm-02", { reply: res ? Object.keys(res.config || {}) : null, leakedUrl });
  await page.close();
  assert.equal(leakedUrl, false, "llm-config の返事に LLM の URL が入っていた");
});

test("RT-PM-03 偽装した llm-call で設定外の経路・モデルを叩けない (P0-06)", async () => {
  llm.requests.length = 0;
  const page = await openWithSniffer();
  const reply = await page.evaluate((base) => new Promise((resolve) => {
    const id = "spoof-llm-call";
    const on = (e) => { if (e.data && e.data.id === id && e.data.type === "llm-call-result") { window.removeEventListener("message", on); resolve(e.data.result); } };
    window.addEventListener("message", on);
    // 経路を差し替えて、モデルの取り込み (/api/pull) を叩かせようとする
    window.postMessage({ source: "mask-mcp-inpage", id, type: "llm-call", system: "s", user: "u",
      config: { url: base + "/api/pull?x=", model: "attacker/huge-model", kind: "ollama", timeoutMs: 3000 } }, "*");
    setTimeout(() => resolve("__timeout__"), 6000);
  }), llm.url);
  await sleep(500);
  const bad = llm.requests.filter((r) => !r.url.startsWith("/api/chat") || r.body.includes("attacker/huge-model"));
  writeEvidence("rt-pm-03", { requests: llm.requests.map((r) => ({ method: r.method, url: r.url, attackerModel: r.body.includes("attacker/huge-model") })), replyReadable: reply !== null && reply !== "__timeout__" });
  await page.close();
  assert.deepEqual(bad.map((r) => r.url), [], "ページが指定した経路・モデルで LLM に要求が届いた");
});

test("RT-PM-04 ページから設定を変更できない (P0-06)", async () => {
  const before = await h.getStorage(["enabled", "maskAllowlist", "maskForceList", "secureComposerEnabled"]);
  const page = await openWithSniffer();
  await page.evaluate((secret) => {
    const post = (m) => window.postMessage({ source: "mask-mcp-inpage", ...m }, "*");
    post({ type: "add-allowlist", value: "攻撃者が足した除外語" });
    post({ type: "remove-forcelist", value: secret });
    post({ type: "add-forcelist", value: "x", category: "OTHER" });
    post({ type: "set-enabled", value: false, id: "e1" });
    post({ type: "settings", settings: { enabled: false } });
    window.postMessage({ source: "mask-mcp-content", type: "settings", settings: { enabled: false, secureComposerEnabled: false } }, "*");
    window.postMessage({ source: "pii-guard-sc", type: "set-masking", enabled: false }, "*");
  }, FORCE_SECRET);
  await sleep(1500);
  const afterS = await h.getStorage(["enabled", "maskAllowlist", "maskForceList", "secureComposerEnabled"]);
  writeEvidence("rt-pm-04", { changed: JSON.stringify(before) !== JSON.stringify(afterS) });
  await page.close();
  assert.deepEqual(afterS, before, "ページのメッセージで設定が変わった");
});

test("RT-PM-05 Secure Composer の iframe への postMessage で送信も変更も起きない", async (t) => {
  const page = await openWithSniffer();
  const frame = await h.waitSecureReady(page, 6000);
  if (!frame) { await page.close(); t.skip("Secure Composer が無い拡張機能 (改修前)"); return; }
  h.server.clear();
  const canary = makeCanary("PMSC");
  await h.type(page, frame, canary);
  await page.evaluate(() => {
    for (const w of Array.from({ length: window.frames.length }, (_, i) => window.frames[i])) {
      for (const m of [{ type: "submit" }, { type: "commit", text: "x" }, { type: "set-masking", enabled: false }, { type: "read" }]) {
        try { w.postMessage(m, "*"); } catch (_) {}
        try { w.postMessage({ source: "pii-guard-sc", ...m }, "*"); } catch (_) {}
      }
    }
  });
  await sleep(1500);
  const conv = h.server.byKind("conversation").length;
  const stillThere = await frame.evaluate(() => document.querySelector("textarea").value);
  await page.close();
  assert.equal(conv, 0, "ページの postMessage で送信が始まった");
  assert.ok(stillThere.includes(canary), "ページの postMessage で下書きが消えた");
});
