// tests/fixtures/sites-harness.mjs — 拡張機能を読み込んだ Chromium (既定はヘッドレス、browser-mode.mjs) と、モックのサイト
// (mock-sites/server.mjs) と、CDP の記録係。拡張機能のディレクトリは PII_GUARD_EXT で切り替えられる (既定はこのリポジトリの
// browser-extension)。スクリーンショットは PII_E2E_SHOTS にディレクトリを指定したときだけ残す。
// close() はブラウザ・サーバ・一時ディレクトリを片付け、プロセスが残っていないことまで確かめる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startMockSites, HOSTS } from "./mock-sites/server.mjs";
import { browserMode } from "./browser-mode.mjs";
import { startCdpRecorder } from "./cdp-recorder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(REPO, "tests", "integration", "package.json"));
export const { chromium } = require("playwright");
export const leak = require(path.join(REPO, "browser-extension", "security", "leak-detector.js"));
export const EG = require(path.join(REPO, "browser-extension", "security", "egress-guard.js"));

export const EXT_DIR = path.resolve(process.env.PII_GUARD_EXT || path.join(REPO, "browser-extension"));
export const SHOTS = process.env.PII_E2E_SHOTS ? path.resolve(process.env.PII_E2E_SHOTS) : null;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 架空の値だけ (spec 12.2 と同じ)
export const FAKE = { phone: "090-1234-5678", email: "taro.yamada@example.test", address: "東京都渋谷区テスト町3丁目12番8号", card: "4111-1111-1111-1111" };
export const RAW = [FAKE.phone, FAKE.email, FAKE.address, "09012345678"];

function pidsFor(dir) {
  try { return execFileSync("pgrep", ["-f", dir], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch (_) { return []; }
}

export async function launchSites(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-qa-"));
  const userDataDir = path.join(tmp, "profile");
  const server = await startMockSites();
  let ctx = null;
  let recorder = null;
  const closeAll = async () => {
    if (recorder) await recorder.close().catch(() => {});
    if (ctx) await ctx.close().catch(() => {});
    await server.close().catch(() => {});
    for (let i = 0; i < 30 && pidsFor(userDataDir).length; i++) await sleep(100);
    for (const pid of pidsFor(userDataDir)) { try { process.kill(Number(pid), "SIGKILL"); } catch (_) {} }
    for (let i = 0; i < 20 && pidsFor(userDataDir).length; i++) await sleep(100);
    const left = pidsFor(userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (left.length) throw new Error(`browser processes still alive after close: ${left.join(",")}`);
  };
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      ...browserMode(),
      viewport: opts.viewport || { width: 1280, height: 800 },
      colorScheme: opts.colorScheme || "light",
      args: [
        `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
        `--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${server.port}`).join(",")}`,
        "--ignore-certificate-errors", "--disable-quic", "--no-sandbox", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
      ],
    });
    recorder = await startCdpRecorder(userDataDir);
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${extId}/options.html`);
    await ext.evaluate(async () => { for (let i = 0; i < 100; i++) { const s = await chrome.storage.local.get(["enabled"]); if (typeof s.enabled === "boolean") return; await new Promise((r) => setTimeout(r, 100)); } });
    await ext.evaluate(async (s) => { await chrome.storage.local.set({ __pii_guard_e2e: true, ...s }); }, opts.storage || {});
    const h = {
      ctx, server, recorder, extId, ext, sw, userDataDir,
      async setStorage(obj) { await ext.evaluate(async (o) => { await chrome.storage.local.set(o); }, obj); },
      async getStorage(keys) { return ext.evaluate(async (k) => chrome.storage.local.get(k), keys); },
      async open(url) {
        const page = await ctx.newPage();
        page.__errors = [];
        page.__console = [];
        page.on("pageerror", (e) => page.__errors.push(String(e && e.stack || e)));
        page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") page.__console.push({ type: m.type(), text: m.text(), url: (m.location() || {}).url || "" }); });
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.QA !== undefined || document.title === "example", null, { timeout: 10000 }).catch(() => {});
        return page;
      },
      /** values のどれかを含む、ブラウザから出ようとした通信 (CDP) と、実際に届いた通信 (サーバ) */
      leaksOf(values, since = 0) {
        const cdp = [];
        for (const r of recorder.all()) {
          if (r.t < since || !r.url || r.url.startsWith("chrome-extension://")) continue;
          const hits = leak.scanRequest(r, values);
          if (hits.length) cdp.push({ url: r.url.slice(0, 120), method: r.method, failed: r.failed || null, hits: hits.map((x) => `${x.index}:${x.kind}@${x.field}`) });
        }
        const srv = server.requests.filter((r) => r.t >= since && leak.findLeaks(r.body + JSON.stringify(r.headers), values).length).map((r) => ({ host: r.host, url: r.url.slice(0, 100), kind: r.kind }));
        const ws = server.wsFrames.filter((f) => f.t >= since && leak.findLeaks(f.data, values).length).map((f) => ({ url: f.url }));
        return { cdp, srv, ws, total: cdp.filter((x) => !x.failed).length + srv.length + ws.length };
      },
      async close() { await closeAll(); },
    };
    return h;
  } catch (e) {
    await closeAll().catch(() => {});
    throw e;
  }
}

// ---- ページの中の拡張機能の表示を読む ----------------------------------------------------------
export const PILL = 'div[data-pii-guard="composer-toggle"]';
export function pillState(page) {
  return page.evaluate((sel) => {
    const h = document.querySelector(sel);
    if (!h) return null;
    const lay = h.dataset.layout ? JSON.parse(h.dataset.layout) : null;
    return { enabled: h.dataset.enabled, warn: h.dataset.warn || "", tone: h.dataset.tone || "", docked: h.dataset.docked || "", layout: lay };
  }, PILL);
}
export async function waitPill(page, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await pillState(page); if (s && s.layout && s.layout.toggle) return s; await sleep(150); }
  return pillState(page);
}
export function sidebarState(page) {
  return page.evaluate(() => {
    const h = document.querySelector('div[data-pii-guard="sidebar"]');
    if (!h || !h.shadowRoot) return null;
    const sr = h.shadowRoot;
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    const rows = [...sr.querySelectorAll(".row")].map((w) => ({ label: w.getAttribute("aria-label"), checked: w.getAttribute("aria-checked"), sev: w.dataset.severity, rect: r(w) }));
    const panel = sr.querySelector(".panel");
    const footer = [...sr.querySelectorAll("footer button")].map((b) => ({ text: b.textContent.trim(), cls: b.className, rect: r(b) }));
    const preview = sr.querySelector(".preview");
    return { rows, panel: r(panel), footer, preview: preview ? preview.textContent : null, host: r(h), title: (sr.querySelector("#mcp-sb-title") || {}).textContent || null };
  });
}
export async function waitSidebar(page, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await sidebarState(page); if (s && s.footer.length) return s; await sleep(100); }
  return null;
}
export function modalState(page) {
  return page.evaluate(() => {
    const h = [...document.querySelectorAll("body *")].find((e) => e.shadowRoot && e.getAttribute("data-pii-guard") !== "sidebar" && e.shadowRoot.querySelector("footer button, button.primary"));
    if (!h) return null;
    const btns = [...h.shadowRoot.querySelectorAll("button")].map((b) => b.textContent.trim());
    return { tag: h.tagName.toLowerCase(), attrs: [...h.attributes].map((a) => a.name + "=" + a.value).join(" "), buttons: btns };
  });
}
export async function clickInShadow(page, hostSel, btnTextRe) {
  return page.evaluate(([sel, re]) => {
    const h = document.querySelector(sel);
    const sr = h && h.shadowRoot;
    if (!sr) return null;
    const b = [...sr.querySelectorAll("button")].find((x) => new RegExp(re).test(x.textContent));
    if (!b) return null;
    b.click();
    return b.textContent.trim();
  }, [hostSel, btnTextRe.source]);
}
export const rectsOverlap = (a, b) => !!(a && b && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]);
export const inViewport = (r, vw, vh) => !!r && r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= vw + 1 && r[1] + r[3] <= vh + 1;
export function rectOf(page, sel) {
  return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }, sel);
}
