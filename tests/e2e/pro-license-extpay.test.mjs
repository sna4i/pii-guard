// tests/e2e/pro-license-extpay.test.mjs — 同梱した本物の ExtPay を、extensionpay.com を名乗る模擬のサーバにつないで動かす
// (docs/pro-license.md の T-PRO-12)
//
// 拡張機能の写しを作り、license/config.js の ID だけをテスト用に替える。extensionpay.com は
// --host-resolver-rules でこのファイルの模擬のサーバに向ける。確かめること:
//   - 購入のページを開くまで、extensionpay.com と通信しない (入れた直後はお試しの Pro)
//   - 「Pro にアップグレード」で、ExtPay が API キーを作り、購入のページを開く
//   - 「購入状態を更新」で購入済みが届き、「Pro (プラン名)」になる。ページの世界のエンジンにも Pro が届く
//   - 通信に失敗しても、7 日以内なら Pro のまま注記が出る
//   - お試しはインストールから 7 日で終わる
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SRC = path.resolve(process.env.PII_GUARD_EXT || path.join(REPO, "browser-extension"));
const TEST_ID = "pii-guard-e2e";
const API_KEY = "e2e-api-key-0001";

// 写しを作って ID だけを替え、ハーネスがそれを読むようにしてから読み込む (EXT_DIR は読み込んだ時点で決まる)
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pii-pro-e2e-"));
const EXT = path.join(work, "ext");
fs.cpSync(SRC, EXT, { recursive: true });
fs.writeFileSync(path.join(EXT, "license", "config.js"), `export const EXTPAY_ID = "${TEST_ID}";\n`);
process.env.PII_GUARD_EXT = EXT;
const { launch, sleep } = await import("../fixtures/harness.mjs");

// ---- extensionpay.com を名乗る模擬のサーバ ------------------------------------------------
function startMockExtensionPay() {
  const crt = path.join(work, "pay.crt");
  const key = path.join(work, "pay.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", crt, "-days", "1", "-nodes",
    "-subj", "/CN=extensionpay.com", "-addext", "subjectAltName=DNS:extensionpay.com"], { stdio: "ignore" });
  const state = { mode: "unpaid", requests: [] };
  const base = `/extension/${TEST_ID}`;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, accept", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => {
    const url = new URL(req.url, "https://extensionpay.com");
    if (req.method !== "OPTIONS") state.requests.push({ method: req.method, path: url.pathname, apiKey: url.searchParams.get("api_key") });
    const json = (status, body) => { res.writeHead(status, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.method === "POST" && url.pathname === `${base}/api/new-key`) return json(200, API_KEY);
    if (req.method === "GET" && url.pathname === `${base}/api/v2/user`) {
      if (state.mode === "error") { res.writeHead(500, cors); res.end("mock error"); return; }
      const paid = state.mode === "paid";
      return json(200, {
        paid, paidAt: paid ? "2026-11-01T00:00:00.000Z" : null, email: paid ? "buyer@example.test" : null, trialStartedAt: null,
        plan: paid ? { unitAmountCents: 500, currency: "jpy", nickname: "Pro 月額", interval: "month", intervalCount: 1 } : null,
        subscriptionStatus: paid ? "active" : null,
      });
    }
    if (url.pathname.startsWith(`${base}/choose-plan`) || url.pathname.startsWith(`${base}/reactivate`)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>mock ExtensionPay</title><p>mock</p>");
      return;
    }
    res.writeHead(404, cors); res.end("not found");
  });
  const sockets = new Set();
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port, state,
    async close() { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(() => r())); },
  })));
}

let h;
let pay;
before(async () => {
  pay = await startMockExtensionPay();
  h = await launch({ storage: { enabled: true }, hostRules: [`MAP extensionpay.com 127.0.0.1:${pay.port}`] });
});
after(async () => {
  try { if (h) await h.close(); } finally {
    if (pay) await pay.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

const ask = (msg) => h.ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
async function openPage(file) {
  const p = await h.ctx.newPage();
  await p.goto(`chrome-extension://${h.extId}/${file}`);
  return p;
}
async function statusAfterRefresh(p) {
  const before = await p.textContent("#pro-status");
  await p.click("#pro-refresh");
  await p.waitForFunction((b) => document.querySelector("#pro-status").dataset.tone && document.querySelector("#pro-status").textContent !== "確認中…", before, { timeout: 5000 });
  await sleep(300);
  return { status: await p.textContent("#pro-status"), note: (await p.isVisible("#pro-note")) ? await p.textContent("#pro-note") : "" };
}

test("T-PRO-12 入れた直後はお試しの Pro で、購入のページを開くまで extensionpay.com と通信しない", async () => {
  const s = await ask({ type: "license:get", refresh: true });
  assert.equal(s.configured, true);
  assert.equal(s.paid, false);
  assert.equal(s.trial, true);
  assert.equal(s.pro, true);
  assert.ok(s.trialEndsAt > Date.now() + 6 * 24 * 3600 * 1000, "お試しは 7 日");
  assert.deepEqual(pay.state.requests, [], "通信しない");
  const alarms = await h.ext.evaluate(() => chrome.alarms.getAll());
  assert.deepEqual(alarms.filter((a) => a.name === "license-revalidate").map((a) => a.periodInMinutes), [60]);
});

test("T-PRO-12b 「Pro にアップグレード」で、ExtPay が API キーを作って購入のページを開く", async () => {
  const p = await openPage("popup.html");
  try {
    await p.waitForSelector("#license-upgrade:not([hidden])", { timeout: 5000 });
    assert.match(await p.textContent("#license-status"), /^Pro \(お試し中、あと 7 日\)$/);
    const [tab] = await Promise.all([h.ctx.waitForEvent("page", { timeout: 8000 }), p.click("#license-upgrade")]);
    await tab.waitForLoadState("domcontentloaded");
    assert.equal(new URL(tab.url()).pathname, `/extension/${TEST_ID}/choose-plan`);
    assert.equal(new URL(tab.url()).searchParams.get("api_key"), API_KEY);
    await tab.close();
    assert.deepEqual(pay.state.requests.map((r) => `${r.method} ${r.path}`).slice(0, 1), [`POST /extension/${TEST_ID}/api/new-key`]);
    const sync = await h.ext.evaluate(() => chrome.storage.sync.get("extensionpay_api_key"));
    assert.equal(sync.extensionpay_api_key, API_KEY);
  } finally { await p.close(); }
});

test("T-PRO-12c 購入のあと「購入状態を更新」で「Pro (プラン名)」になり、ページの世界のエンジンにも Pro が届く", async () => {
  pay.state.mode = "paid";
  const p = await openPage("options.html");
  try {
    const v = await statusAfterRefresh(p);
    assert.equal(v.status, "Pro (Pro 月額)");
    assert.equal(v.note, "");
    assert.equal(await p.isVisible("#pro-upgrade"), false);
    const cached = (await h.getStorage(["licenseState"])).licenseState;
    assert.equal(cached.paid, true);
    assert.equal(cached.email, "buyer@example.test");
    assert.ok(pay.state.requests.some((r) => r.path === `/extension/${TEST_ID}/api/v2/user` && r.apiKey === API_KEY));
  } finally { await p.close(); }
  const chat = await h.openChat("/");
  try {
    await chat.waitForFunction(() => window.__localMaskMCP && window.__localMaskMCP.settings && window.__localMaskMCP.settings.pro === true, null, { timeout: 8000 });
    assert.equal(await chat.evaluate(() => window.__localMaskMCP.engine.isProEnabled()), true);
  } finally { await chat.close(); }
});

test("T-PRO-12d 通信に失敗しても、最後に確かめてから 7 日以内なら Pro のままで、注記が出る", async () => {
  pay.state.mode = "error";
  const p = await openPage("options.html");
  try {
    const v = await statusAfterRefresh(p);
    assert.equal(v.status, "Pro (Pro 月額)");
    assert.match(v.note, /^購入状態を確認できませんでした \(最後に確認: .+\)$/);
  } finally { await p.close(); }
});

test("T-PRO-12e お試しはインストールから 7 日で終わり、未購入なら無料版に戻る", async () => {
  pay.state.mode = "unpaid";
  await h.ext.evaluate(() => chrome.storage.sync.set({ extensionpay_installed_at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() }));
  const s = await ask({ type: "license:get", refresh: true });
  assert.equal(s.paid, false);
  assert.equal(s.trial, false);
  assert.equal(s.pro, false);
  const p = await openPage("popup.html");
  try {
    await p.waitForFunction(() => document.querySelector("#license-status").textContent !== "確認中…", null, { timeout: 5000 });
    assert.equal(await p.textContent("#license-status"), "無料版");
  } finally { await p.close(); }
});
