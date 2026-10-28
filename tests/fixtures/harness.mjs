// tests/fixtures/harness.mjs — 拡張機能を読み込んだ Chromium + モックの ChatGPT + CDP の記録係。
//
// - ブラウザは persistent context (拡張機能はこれでしか読めない)。ヘッドレスが既定で、
//   窓を出して調べるときは PII_E2E_HEADED=1 (browser-mode.mjs)
// - chatgpt.com はモックサーバへ向ける (--host-resolver-rules)。証明書は自己署名
// - CDP の記録係は --remote-debugging-port で別につなぐ (cdp-recorder.mjs)
// - close() はブラウザ・サーバ・一時ディレクトリをすべて片付け、ブラウザのプロセスが
//   残っていないことまで確かめる (memory: テスト用プロセスは毎回閉じる)
//
// 拡張機能のディレクトリは PII_GUARD_EXT で切り替えられる (既定はこのリポジトリの
// browser-extension)。改修前のコードで同じテストを走らせ、脆弱性の再現を記録するため。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startMockChatGPT } from "./mock-chatgpt/server.mjs";
import { browserMode } from "./browser-mode.mjs";
import { startCdpRecorder } from "./cdp-recorder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(REPO, "tests", "integration", "package.json"));
const { chromium } = require("playwright");
export const leak = require(path.join(REPO, "browser-extension", "security", "leak-detector.js"));

export const EXT_DIR = path.resolve(process.env.PII_GUARD_EXT || path.join(REPO, "browser-extension"));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** テストごとに一意なカナリアと、架空の個人情報 (spec 12.2)。 */
export function makeCanary(label = "T") {
  return `PII_GUARD_CANARY_${label}_${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
export const FAKE_PII = {
  phone: "090-1234-5678",
  email: "taro.yamada@example.test",
  address: "東京都渋谷区テスト町3丁目12番8号",
  surname: "山田",
};
/** 既存のエンジン (正規表現・辞書) が検出して伏せるはずの値 */
export const MASKED_BY_ENGINE = [FAKE_PII.phone, FAKE_PII.email, FAKE_PII.address];
// 単一行。keyboard.type の "\n" はチャット入力欄では Enter = 送信になってしまうので、
// 下書き (送信前) を作るテストでは改行を入れない。複数行の下書きが要るテストは
// Shift+Enter を明示的に送ること。
export function piiText(canary) {
  return [
    canary,
    `氏名 ${FAKE_PII.surname} 太郎`,
    `電話番号 ${FAKE_PII.phone}`,
    `メール ${FAKE_PII.email}`,
    `住所 ${FAKE_PII.address}`,
  ].join(" / ");
}

function pidsFor(userDataDir) {
  try {
    return execFileSync("pgrep", ["-f", userDataDir], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch (_) { return []; }
}

/**
 * @param {{ query?: string, storage?: object, viewport?: object }} [opts]
 */
export async function launch(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-sc-e2e-"));
  const userDataDir = path.join(tmp, "profile");
  const server = await startMockChatGPT();
  let ctx = null;
  let recorder = null;
  const closeAll = async () => {
    if (recorder) await recorder.close().catch(() => {});
    if (ctx) await ctx.close().catch(() => {});
    await server.close().catch(() => {});
    for (let i = 0; i < 30 && pidsFor(userDataDir).length; i++) await sleep(100);
    // プロファイルのパスで残ったプロセスを強制終了する (ctx.close が取りこぼしても
    // ユーザー自身のブラウザは巻き込まない — userDataDir はこのテスト専用の一時ディレクトリ)
    let left = pidsFor(userDataDir);
    for (const pid of left) { try { process.kill(Number(pid), "SIGKILL"); } catch (_) {} }
    for (let i = 0; i < 20 && pidsFor(userDataDir).length; i++) await sleep(100);
    left = pidsFor(userDataDir);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (left.length) throw new Error(`browser processes still alive after close: ${left.join(",")}`);
  };
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      ...browserMode(),
      viewport: opts.viewport || { width: 1200, height: 860 },
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.port},MAP chat.openai.com 127.0.0.1:${server.port}`,
        "--ignore-certificate-errors",
        "--disable-quic",
        "--no-sandbox",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    recorder = await startCdpRecorder(userDataDir);
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${extId}/options.html`);
    // 既存の e2e と同じく、テスト用の状態の公開フラグを立てる (ページからは書けない chrome.storage)
    await ext.evaluate(async (s) => { await chrome.storage.local.set({ __pii_guard_e2e: true, ...s }); }, opts.storage || {});

    const h = {
      ctx, server, recorder, extId, ext, userDataDir,
      sw,
      async setStorage(obj) { await ext.evaluate(async (o) => { await chrome.storage.local.set(o); }, obj); },
      async getStorage(keys) { return ext.evaluate(async (k) => chrome.storage.local.get(k), keys); },
      async sessionRules() { return ext.evaluate(async () => chrome.declarativeNetRequest ? chrome.declarativeNetRequest.getSessionRules() : null); },
      async enabledRulesets() { return ext.evaluate(async () => chrome.declarativeNetRequest ? chrome.declarativeNetRequest.getEnabledRulesets() : null); },
      /** chatgpt.com のページを開く。query 例: "?telemetry=1&ws=1" */
      async openChat(pathAndQuery = "/") {
        const page = await ctx.newPage();
        await page.goto(`https://chatgpt.com${pathAndQuery}`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__mock && document.querySelector("#composer-root form"));
        return page;
      },
      /** Secure Composer の iframe (拡張機能のページ) を探す */
      async secureFrame(page, timeoutMs = 8000) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const f = page.frames().find((fr) => fr.url().startsWith(`chrome-extension://${extId}/secure-composer/secure-composer.html`));
          if (f) {
            try { await f.waitForSelector("textarea", { timeout: 1000 }); return f; } catch (_) { /* loading */ }
          }
          await sleep(100);
        }
        return null;
      },
      /** Secure Composer が「保護中」になるまで待つ (iframe 内の data-state) */
      async waitSecureReady(page, timeoutMs = 10000) {
        const f = await h.secureFrame(page, timeoutMs);
        if (!f) return null;
        await f.waitForFunction(() => document.documentElement.dataset.state === "SECURE_READY" || document.documentElement.dataset.state === "EDITING", null, { timeout: timeoutMs });
        return f;
      },
      // iframe があれば iframe の textarea に、無ければ (baseline) ネイティブ入力欄に直接打つ。
      // page.keyboard は ambient focus 依存で揺れるので、要素を狙って打つ。
      async type(page, frame, text) {
        if (frame) {
          const ed = frame.locator("textarea");
          await ed.click();
          await ed.pressSequentially(text, { delay: 3 });
        } else {
          const ed = page.locator('#prompt-textarea, textarea#mobile-composer-prompt').first();
          await ed.click();
          await ed.pressSequentially(text, { delay: 3 });
        }
      },
      // Enter で送信。PII を検出すると iframe 内に送信前確認が出るので、既定フローとして
      // 「確認が出たら送信ボタンを押す」まで行う (PII 無し・警告 OFF なら確認は出ず素通り)。
      // 確認をキャンセルする挙動を試すテストは enterNoConfirm + 明示操作を使う。
      async enter(page, frame) {
        if (!frame) { await page.locator('#prompt-textarea, textarea#mobile-composer-prompt').first().press("Enter"); return; }
        await frame.locator("textarea").press("Enter");
        try {
          await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 1500 });
          await frame.locator('#confirm-send').click();
        } catch (_) { /* 確認は出なかった (PII 無し or 警告 OFF) */ }
      },
      async enterNoConfirm(page, frame) {
        if (frame) await frame.locator("textarea").press("Enter");
        else await page.locator('#prompt-textarea, textarea#mobile-composer-prompt').first().press("Enter");
      },
      // SC が「実際に overlay を担当している」(scOwnsComposer=true) まで待つ。fail-open 修正後、
      // 機密の非配布と injected.js の素通しはこれが true の間だけ有効 (overlay が live な定常状態)。
      async waitScActive(page, timeoutMs = 10000) {
        try {
          await page.waitForFunction(
            () => { const s = window.__localMaskMCP && window.__localMaskMCP.settings; return !!(s && s.scOwnsComposer === true); },
            null, { timeout: timeoutMs }
          );
          return true;
        } catch (_) { return false; }
      },
      // MAIN world の scOwnsComposer を読む (fail-open 判定の観測用)。
      async scOwns(page) {
        return page.evaluate(() => { const s = window.__localMaskMCP && window.__localMaskMCP.settings; return !!(s && s.scOwnsComposer === true); });
      },
      async nativeText(page) {
        return page.evaluate(() => {
          const el = document.querySelector("#prompt-textarea, textarea#mobile-composer-prompt");
          if (!el) return null;
          return el.tagName === "TEXTAREA" ? el.value : el.innerText.replace(/\n+$/, "");
        });
      },
      /** CDP と受信側の両方で、values のどれかが含まれる通信を探す */
      leaksOf(values, { since = 0 } = {}) {
        const cdp = [];
        for (const r of recorder.all()) {
          if (r.t < since) continue;
          if (r.url && r.url.startsWith("chrome-extension://")) continue;
          const hits = leak.scanRequest(r, values);
          if (hits.length) cdp.push({ url: r.url, method: r.method, failed: r.failed, target: r.target && r.target.type, hits });
        }
        const ws = recorder.wsFrames.filter((f) => f.t >= since && leak.findLeaks(f.data, values).length);
        const srv = server.requests.filter((r) => r.t >= since && leak.scanRequest(r, values).length)
          .map((r) => ({ url: r.url, method: r.method, kind: r.kind, hits: leak.scanRequest(r, values) }));
        const srvWs = server.wsFrames.filter((f) => f.t >= since && leak.findLeaks(f.data, values).length);
        return { cdp, ws, server: srv, serverWs: srvWs, total: cdp.length + ws.length + srv.length + srvWs.length };
      },
      /**
       * CDP の観測と受信側の記録が矛盾しないか (P0-15)。
       * chatgpt.com 宛てで CDP に出た POST は、(a) サーバに届いた (b) ブラウザで遮断/失敗した、のどちらか。
       * サーバに届いた POST は、すべて CDP に出ている。
       */
      consistency({ since = 0 } = {}) {
        const norm = (u) => { try { const x = new URL(u, "https://chatgpt.com"); return x.pathname + x.search; } catch (_) { return u; } };
        const cdpPosts = recorder.toHost("chatgpt.com").filter((r) => r.t >= since && r.method === "POST");
        const srvPosts = server.requests.filter((r) => r.t >= since && r.method === "POST");
        const srvCount = new Map();
        for (const r of srvPosts) srvCount.set(norm(r.url), (srvCount.get(norm(r.url)) || 0) + 1);
        const cdpOk = new Map();
        const blocked = [];
        const unexplained = [];
        for (const r of cdpPosts) {
          const k = norm(r.url);
          if (r.failed) { blocked.push({ path: k, ...r.failed }); continue; }
          cdpOk.set(k, (cdpOk.get(k) || 0) + 1);
        }
        for (const [k, n] of cdpOk) if ((srvCount.get(k) || 0) < n) unexplained.push({ path: k, cdp: n, server: srvCount.get(k) || 0, why: "CDP では成功、サーバに未着" });
        for (const [k, n] of srvCount) if ((cdpOk.get(k) || 0) < n) unexplained.push({ path: k, cdp: cdpOk.get(k) || 0, server: n, why: "サーバに着いたが CDP に成功記録なし" });
        for (const b of blocked) if (srvCount.get(b.path)) {
          // 遮断された経路と同じ経路が別の要求でサーバに届いているのは許す (許可の窓での送信)
        }
        return { cdpPosts: cdpPosts.length, serverPosts: srvPosts.length, blocked, unexplained };
      },
      async close() { await closeAll(); },
    };
    return h;
  } catch (e) {
    await closeAll().catch(() => {});
    throw e;
  }
}

/** 記録を JSON で残す (原文は残さない: 値は伏せ、ヒットは番号と形だけ) */
export function writeEvidence(name, data) {
  const dir = process.env.PII_E2E_EVIDENCE;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
}
