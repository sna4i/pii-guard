// tests/integration/e2e-update-keeps-data.mjs — アップデートで利用者のデータが消えないことを確かめる。
//
// 古い版を読み込み、設定画面の「JSON からインポート」で除外リストを取り込む。
// 常に伏せる語と LLM の設定も保存する。そのあと同じ場所のファイルを新しい版に
// 差し替え、同じプロファイルでブラウザを起動し直す。拡張機能 ID は変わらず、
// Chrome の自動アップデートと同じく起動時の処理 (onInstalled) が走る。確かめること:
//   - 保存データ (chrome.storage.local) が 1 件も変わっていない
//   - 設定画面の除外リストの件数が同じ
//   - 送信経路で、除外リストの値は伏せられず、常に伏せる語は伏せられる
//
// 使い方:
//   node tests/integration/e2e-update-keeps-data.mjs <古い版のディレクトリ> <新しい版のディレクトリ>
//   例) 公開版の CRX を展開したもの (_metadata/ を除く) と、提出用 zip を展開したもの
//
// モックサーバとブラウザはこのスクリプト自身が起動し、finally で必ず閉じる。
// 終了コード: 0 = 全検査合格 / 1 = 失敗
import { chromium } from "playwright";
import { browserMode } from "../fixtures/browser-mode.mjs";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [OLD_ARG, NEW_ARG] = process.argv.slice(2);
if (!OLD_ARG || !NEW_ARG) {
  console.error("usage: node tests/integration/e2e-update-keeps-data.mjs <old-unpacked-dir> <new-unpacked-dir>");
  process.exit(2);
}
const OLD = path.resolve(OLD_ARG);
const NEW = path.resolve(NEW_ARG);

// 取り込む除外リスト。設定画面の「JSON でエクスポート」と同じ形
const IMPORTED = ["yamada@my-company.jp", "Acme Corp", "社外秘プロジェクトX"];
const FORCED = { value: "カササギ計画", category: "OTHER" };
const TEXT = "yamada@my-company.jp と sato@example.co.jp に、カササギ計画の件を連絡してください";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-update-"));
let server, ctx;
const received = [];
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed = true; };
const sorted = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));

async function waitDefaults(sw) {
  // 初回起動時の既定値 (onInstalled) が書かれるのを待つ
  await sw.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const s = await chrome.storage.local.get(["enabled", "localLlmEnabled"]);
      if (typeof s.enabled === "boolean" && typeof s.localLlmEnabled === "boolean") return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
}

try {
  const work = path.join(tmp, "extension");
  fs.cpSync(OLD, work, { recursive: true });
  const importFile = path.join(tmp, "allowlist.json");
  fs.writeFileSync(importFile, JSON.stringify({ maskAllowlist: IMPORTED, exported_at: "2026-10-01T00:00:00.000Z" }, null, 2));

  const crt = path.join(tmp, "server.crt"), k = path.join(tmp, "server.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", k, "-out", crt,
    "-days", "1", "-nodes", "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com"], { stdio: "ignore" });
  server = https.createServer({ key: fs.readFileSync(k), cert: fs.readFileSync(crt) }, (req, res) => {
    if (req.method === "POST" && req.url.startsWith("/backend-api/conversation")) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => { received.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>mock</title><h1>mock chatgpt.com</h1>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const profile = path.join(tmp, "profile");
  const launch = () => chromium.launchPersistentContext(profile, {
    ...browserMode(), ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${work}`, `--load-extension=${work}`,
           `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${server.address().port}`,
           "--ignore-certificate-errors", "--no-sandbox"],
  });

  // 1 回目の起動: 古い版に利用者のデータを入れて閉じる
  ctx = await launch();
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  const extId = (sw.url().match(/^chrome-extension:\/\/([^/]+)/) || [])[1];
  await waitDefaults(sw);
  const v1 = await sw.evaluate(() => chrome.runtime.getManifest().version);

  console.log(`古い版 ${v1} に、利用者のデータを入れる:`);
  const opt = await ctx.newPage();
  opt.on("dialog", (d) => d.accept());
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForTimeout(1500);
  await opt.setInputFiles("#import-file", importFile);
  await opt.waitForTimeout(2000);
  const countBefore = (await opt.textContent("#allowlist-count")) || "";
  check(countBefore.startsWith(`${IMPORTED.length}`), `設定画面のインポートで除外リストを取り込んだ (${countBefore})`);
  // uiMode を消しておく。更新時の起動処理が走れば既定値で補われるので、
  // 処理が走ったことと、ほかのデータに触れないことを同時に確かめられる
  await sw.evaluate(([forced]) => chrome.storage.local.set({
    maskForceList: [forced],
    localLlmUrl: "http://127.0.0.1:11434", localLlmModel: "qwen3:4b", localLlmEnabled: false,
  }).then(() => chrome.storage.local.remove("uiMode")), [FORCED]);
  const before = await sw.evaluate(() => chrome.storage.local.get(null));
  console.log(`    保存データのキー: ${Object.keys(before).sort().join(", ")}`);
  await ctx.close();
  ctx = null;

  // 2 回目の起動: 同じプロファイル・同じ場所のファイルを新しい版にして起動する
  fs.cpSync(NEW, work, { recursive: true, force: true });
  ctx = await launch();
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 25000 }));
  await waitDefaults(sw);
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      if ((await chrome.storage.local.get("uiMode")).uiMode) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  const v2 = await sw.evaluate(() => chrome.runtime.getManifest().version);
  const sameId = (sw.url().match(/^chrome-extension:\/\/([^/]+)/) || [])[1] === extId;
  const after = await sw.evaluate(() => chrome.storage.local.get(null));

  console.log(`\n新しい版 ${v2} に更新した後:`);
  check(v1 !== v2 && sameId, `同じ拡張機能のまま、版が ${v1} から ${v2} に変わった`);
  check(after.uiMode === "sidebar", "更新時の起動処理が走り、消しておいた設定を既定値で補った");
  const { uiMode: _u, ...afterRest } = after;
  check(sorted(before) === sorted(afterRest), "それ以外の保存データは 1 件も変わっていない");
  for (const key of new Set([...Object.keys(before), ...Object.keys(afterRest)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(afterRest[key])) {
      console.log(`    違い ${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(afterRest[key])}`);
    }
  }
  const opt2 = await ctx.newPage();
  await opt2.goto(`chrome-extension://${extId}/options.html`);
  await opt2.waitForTimeout(1500);
  const countAfter = (await opt2.textContent("#allowlist-count")) || "";
  check(countAfter === countBefore, `設定画面の除外リストの件数が同じ (${countAfter})`);

  // 送信経路で、取り込んだ除外リストと常に伏せる語が効いているか
  const page = await ctx.newPage();
  await page.goto("https://chatgpt.com/");
  await page.waitForTimeout(3500);
  // 2026-10-18 (V-02) から、除外リストと常に伏せる語の値はページ側 (MAIN world) に配らない。
  // ページのマスクは ISOLATED world のエンジンに頼み、リストは「ある」ことだけ知らせる。
  // 効いていることは、下の送信の結果 (除外は残る・常に伏せる語は伏せる) で確かめる。
  const pageSettings = await page.evaluate(() => {
    const s = (window.__localMaskMCP && window.__localMaskMCP.settings) || {};
    return { allow: (s.maskAllowlist || []).length, force: (s.maskForceList || []).length, has: s.hasSecretLists === true };
  });
  check(pageSettings.allow === 0 && pageSettings.force === 0 && pageSettings.has,
    `ページ側には除外リストと常に伏せる語の値が届かず、「ある」ことだけが届く (除外 ${pageSettings.allow} 件、常に伏せる ${pageSettings.force} 件、あり=${pageSettings.has})`);
  await page.evaluate((t) => {
    fetch("/backend-api/conversation", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "next", model: "gpt-4",
        messages: [{ id: "1", author: { role: "user" }, content: { content_type: "text", parts: [t] } }] }),
    }).catch(() => {});
  }, TEXT);
  await page.waitForTimeout(4000);
  const host = await page.evaluateHandle(() => [...document.querySelectorAll("*")].find((e) => e.shadowRoot));
  await host.evaluate((h) =>
    [...h.shadowRoot.querySelectorAll("button")].find((b) => /マスクして送信/.test(b.textContent))?.click());
  await page.waitForTimeout(3000);
  const sent = received.length ? JSON.parse(received[0]).messages[0].content.parts[0] : "";
  console.log(`    送信された本文: ${sent}`);
  check(sent.includes("yamada@my-company.jp"), "取り込んだ除外リストの値は伏せられずに残る");
  check(sent && !sent.includes("sato@example.co.jp"), "除外していないメールアドレスは伏せられる");
  check(sent && !sent.includes(FORCED.value), "常に伏せる語は伏せられる");
} catch (e) {
  console.error("テスト実行エラー:", e?.message || e);
  failed = true;
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? "\n✗ FAILED" : "\n✓ PASSED");
process.exit(failed ? 1 : 0);
