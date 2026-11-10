// tests/fixtures/ext-browser.mjs — E2E のハーネス (harness.mjs、sites-harness.mjs) で共通の、拡張機能を読み込んだ
// Chromium と CDP の記録係の立ち上げと片付け。
//
// - ブラウザは persistent context (拡張機能はこれでしか読めない)。ヘッドレスが既定で、
//   窓を出して調べるときは PII_E2E_HEADED=1 (browser-mode.mjs)
// - サイトのホスト名は --host-resolver-rules でモックのサーバへ向ける (どのホストを向けるかは各ハーネスが決める)。
//   証明書は自己署名
// - CDP の記録係は --remote-debugging-port で別につなぐ (cdp-recorder.mjs)
// - close() は、記録係 → ブラウザ → モックのサーバ → 一時ディレクトリの順に片付け、ブラウザのプロセスが
//   残っていないことまで確かめる (memory: テスト用プロセスは毎回閉じる)
//
// 拡張機能のディレクトリは PII_GUARD_EXT で切り替えられる (既定はこのリポジトリの
// browser-extension)。改修前のコードで同じテストを走らせ、脆弱性の再現を記録するため。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { browserMode } from "./browser-mode.mjs";
import { startCdpRecorder } from "./cdp-recorder.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(REPO, "tests", "integration", "package.json"));
const { chromium } = require("playwright");

export const EXT_DIR = path.resolve(process.env.PII_GUARD_EXT || path.join(REPO, "browser-extension"));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidsFor(userDataDir) {
  try {
    return execFileSync("pgrep", ["-f", userDataDir], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch (_) { return []; }
}

/**
 * 拡張機能を読み込んだブラウザと CDP の記録係を立ち上げる。モックのサーバは呼ぶ側が先に立ち上げ、
 * その片付け (closeServer) を渡す。立ち上げに失敗したときも、サーバを含めて片付けてから投げる。
 * @param {{ tmpPrefix: string, hostRules: string[], closeServer: () => Promise<void>,
 *   viewport: {width:number, height:number}, colorScheme?: string, storage?: object }} opts
 *   tmpPrefix: 一時ディレクトリ (プロファイルの置き場所) の名前の頭。残ったプロセスを探すときの目印にもなる
 *   hostRules: --host-resolver-rules の行 (例: `MAP chatgpt.com 127.0.0.1:<port>`)
 *   storage: 立ち上げの直後に chrome.storage.local に書く値 (テスト用の公開フラグ __pii_guard_e2e に足す)
 */
export async function launchExtensionBrowser(opts) {
  // 一時ディレクトリを作れなかったときも、呼ぶ側が先に立ち上げたモックのサーバを閉じてから投げる
  // (ブラウザはまだ無いので、片付けるのはサーバだけ)
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix));
  } catch (e) {
    await opts.closeServer().catch(() => {});
    throw e;
  }
  const userDataDir = path.join(tmp, "profile");
  let ctx = null;
  let recorder = null;
  const close = async () => {
    if (recorder) await recorder.close().catch(() => {});
    if (ctx) await ctx.close().catch(() => {});
    await opts.closeServer().catch(() => {});
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
      viewport: opts.viewport,
      ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        `--host-resolver-rules=${opts.hostRules.join(",")}`,
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
    // 拡張機能が入ったときに既定の設定 (enabled など) を書き終えるのを待ってから、テストの値を書く
    // (既定の書き込みが、あとからテストの値を上書きしないように)
    await ext.evaluate(async () => { for (let i = 0; i < 100; i++) { const s = await chrome.storage.local.get(["enabled"]); if (typeof s.enabled === "boolean") return; await new Promise((r) => setTimeout(r, 100)); } });
    // 既存の e2e と同じく、テスト用の状態の公開フラグを立てる (ページからは書けない chrome.storage)
    await ext.evaluate(async (s) => { await chrome.storage.local.set({ __pii_guard_e2e: true, ...s }); }, opts.storage || {});
    return {
      ctx, recorder, sw, extId, ext, userDataDir,
      async setStorage(obj) { await ext.evaluate(async (o) => { await chrome.storage.local.set(o); }, obj); },
      async getStorage(keys) { return ext.evaluate(async (k) => chrome.storage.local.get(k), keys); },
      close,
    };
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
}
