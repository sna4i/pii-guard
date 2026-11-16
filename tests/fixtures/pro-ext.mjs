// tests/fixtures/pro-ext.mjs — Pro の E2E の土台。拡張機能の写しを作って ExtensionPay の ID をテスト用に替え、
// extensionpay.com を名乗る模擬のサーバを立て、写しを読み込んだブラウザ (harness.mjs の launch) を立ち上げる。
//
//   const { h, pay, close } = await launchPro({ storage, mockSites });
//
// - 入れた直後はお試しの Pro (ExtPay は API キーを作るまで、インストールの日時だけで答え、extensionpay.com と通信しない)
// - Pro のルールパックにテスト用のルールを 1 つ入れる (Pro のときだけ、送る文の QA-PRO-nnnn が <PRO_TEST_n> になる)
// - storage: 立ち上げの直後に chrome.storage.local に書く値 (harness.mjs の launch と同じ)
// - mockSites: true なら、模擬の Claude・Gemini・Manus (mock-sites/server.mjs) にも向け、h.sites (届いた通信の記録) と
//   h.openSite(url) (そのサイトのページを開いて、ページのスクリプトの準備を待つ) を足す
// - pay: 模擬の ExtensionPay ({ port, state })。state.mode ("unpaid" / "paid" / "error")、state.requests、state.gate
// - close: ブラウザ、模擬のサーバ (ChatGPT・サイト・ExtensionPay)、写しの順に片付ける
//
// ハーネス (ext-browser.mjs) は、読み込んだ時点の PII_GUARD_EXT で拡張機能のディレクトリを決める。だから写しを作って
// PII_GUARD_EXT を向けてから、ハーネスを読み込む。テストのファイルは、ハーネス (harness.mjs・sites-harness.mjs) を
// 先に読み込まない。launchPro は 1 つのテストのファイル (node --test では 1 つのプロセス) で 1 回だけ呼ぶ。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
export const TEST_ID = "pii-guard-e2e";
export const API_KEY = "e2e-api-key-0001";

// ---- extensionpay.com を名乗る模擬のサーバ ------------------------------------------------
function startMockExtensionPay(work) {
  const crt = path.join(work, "pay.crt");
  const key = path.join(work, "pay.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", crt, "-days", "1", "-nodes",
    "-subj", "/CN=extensionpay.com", "-addext", "subjectAltName=DNS:extensionpay.com"], { stdio: "ignore" });
  // gate: Promise を入れると、購入状態の問い合わせへの答えを、それが解けるまで止める (裏の確かめ直しの途中を見るため)
  const state = { mode: "unpaid", requests: [], gate: null };
  const base = `/extension/${TEST_ID}`;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, accept", "access-control-allow-methods": "GET, POST, OPTIONS" };
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, async (req, res) => {
    const url = new URL(req.url, "https://extensionpay.com");
    if (req.method !== "OPTIONS") state.requests.push({ method: req.method, path: url.pathname, apiKey: url.searchParams.get("api_key") });
    const json = (status, body) => { res.writeHead(status, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (req.method === "POST" && url.pathname === `${base}/api/new-key`) return json(200, API_KEY);
    if (req.method === "GET" && url.pathname === `${base}/api/v2/user`) {
      if (state.gate) await state.gate;
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

let launched = false;

/**
 * @param {{ storage?: object, mockSites?: boolean }} [opts]
 * @returns {Promise<{ h: object, pay: { port: number, state: object }, close: () => Promise<void> }>}
 */
export async function launchPro({ storage, mockSites } = {}) {
  if (launched) throw new Error("launchPro: 1 つのテストのファイルで 1 回だけ呼ぶ (ハーネスは最初の写しを読み込んだまま)");
  launched = true;
  const src = path.resolve(process.env.PII_GUARD_EXT || path.join(REPO, "browser-extension"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pii-pro-e2e-"));
  let pay = null;
  let sites = null;
  let h = null;
  const close = async () => {
    try { if (h) await h.close(); } finally {
      if (sites) await sites.close().catch(() => {});
      if (pay) await pay.close().catch(() => {});
      fs.rmSync(work, { recursive: true, force: true });
    }
  };
  try {
    // 写しを作って ID だけを替え、ハーネスがそれを読むようにしてから読み込む
    const ext = path.join(work, "ext");
    fs.cpSync(src, ext, { recursive: true });
    fs.writeFileSync(path.join(ext, "license", "config.js"), `export const EXTPAY_ID = "${TEST_ID}";\n`);
    const proRules = path.join(ext, "engine", "pro-rules.js");
    const proSrc = fs.readFileSync(proRules, "utf8");
    if (!proSrc.includes("const PRO_RULE_PACK = [];")) throw new Error("pro-rules.js の形が変わった");
    fs.writeFileSync(proRules, proSrc.replace("const PRO_RULE_PACK = [];", 'const PRO_RULE_PACK = [{ category: "PRO_TEST", entity_type: "PRO_TEST", pattern: /QA-PRO-\\d{4}/g }];'));
    process.env.PII_GUARD_EXT = ext;

    pay = await startMockExtensionPay(work);
    const hostRules = [`MAP extensionpay.com 127.0.0.1:${pay.port}`];
    if (mockSites) {
      const { startMockSites, HOSTS } = await import("./mock-sites/server.mjs");
      sites = await startMockSites();
      hostRules.push(...HOSTS.map((host) => `MAP ${host} 127.0.0.1:${sites.port}`));
    }
    const { launch } = await import("./harness.mjs");
    h = await launch({ storage, hostRules });
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
  if (sites) {
    h.sites = sites;
    h.openSite = async (url) => {
      const page = await h.ctx.newPage();
      page.__errors = [];
      page.on("pageerror", (e) => page.__errors.push(String((e && e.stack) || e)));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.QA !== undefined, null, { timeout: 10000 });
      return page;
    };
  }
  return { h, pay, close };
}
