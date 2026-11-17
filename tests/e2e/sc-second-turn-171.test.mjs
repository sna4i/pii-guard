// tests/e2e/sc-second-turn-171.test.mjs — 2 回目以降の送信で下書きが消えて送られない不具合 (1.7.0 から)
// (docs/release-1.7.1.md の「2 回目以降の送信で下書きが消えて送られない不具合」、T-SC-21〜T-SC-21d)
//
// T-SC-21  回答の途中に送ると、送らずに下書きを残して知らせる。ChatGPT の入力欄には書かない。回答のあとなら送れる
// T-SC-21b ChatGPT が送信を受け付けないと、下書きを残し、ChatGPT の入力欄を空に戻し、理由を動作ログに残す
// T-SC-21c 停止のボタンが送信ボタンの id を持っていても、回答の途中に停止のボタンを押さない
// T-SC-21d 送信ボタンが遅れて出ても、出るのを待って押す (合成した Enter のキーを受け付けないページでも送れる)
// T-SC-21e ログインなしの作り (送信ボタンそのものが回答の途中に「生成を中止」に替わる。2026-10-29 に実サイトで確認) でも、
//          回答の途中は送らず、停止を押さない
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, sleep } from "../fixtures/harness.mjs";

const THREAD = "/?variant=thread2026";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openThread(query = "") {
  const page = await h.openChat(THREAD + query);
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  return { page, frame };
}
const scSnap = (frame) => frame.evaluate(() => ({
  state: document.documentElement.dataset.state,
  status: document.getElementById("status").textContent,
  draft: document.getElementById("editor").value,
}));
const streaming = (page) => page.evaluate(() => window.__mock.state.streaming);
const mockEvents = (page, type) => page.evaluate((t) => window.__mock.events.filter((e) => e.type === t).map((e) => e.via || e.type), type);
async function logsOf(code) {
  const all = await h.getStorage(null);
  return Object.entries(all).filter(([k]) => k.startsWith("diagLog:")).flatMap(([, v]) => (Array.isArray(v) ? v : [])).filter((e) => e && e.code === code);
}
// 動作ログは送信の処理のあとで、待たずに書く (D-LG-10)。書かれるまで最大 3 秒待つ
async function waitLog(code, pred) {
  for (let i = 0; i < 30; i++) {
    const rows = await logsOf(code);
    if (rows.some(pred)) return rows;
    await sleep(100);
  }
  return logsOf(code);
}

test("T-SC-21 回答の途中に送ると、送らずに下書きを残して知らせる。回答のあとなら送れる", async () => {
  h.server.clear();
  h.server.mode.conversationDelayMs = 6000; // 1 つ目の回答に 6 秒かかる
  const { page, frame } = await openThread();
  await h.type(page, frame, "一つ目の質問です");
  await frame.locator("textarea").press("Enter");
  await sleep(1500);
  assert.equal(await streaming(page), true, "前提: 1 つ目の回答の途中");
  await h.type(page, frame, "二つ目の質問です");
  await frame.locator("textarea").press("Enter");
  await sleep(1500);
  const during = { sc: await scSnap(frame), native: await h.nativeText(page), sent: h.server.byKind("conversation").length };
  await page.waitForFunction(() => !window.__mock.state.streaming, null, { timeout: 10000 });
  await frame.locator("textarea").press("Enter"); // 回答が終わってから、もう一度
  await sleep(1500);
  const conv = h.server.byKind("conversation");
  const after2 = await scSnap(frame);
  const failed = await waitLog("send.failed", (e) => e.d && e.d.reason === "page-busy");
  await page.close();
  assert.equal(during.sent, 1, "回答の途中に 2 つ目が送られた");
  assert.equal(during.sc.draft, "二つ目の質問です", `回答の途中に下書きが消えた (${JSON.stringify(during)})`);
  assert.match(during.sc.status, /回答を作っている途中/, "回答の途中だと知らせていない");
  assert.equal(during.native, "", "回答の途中に ChatGPT の入力欄へ書いた");
  assert.ok(failed.some((e) => e.d && e.d.reason === "page-busy" && e.d.via === "secure-composer"), `動作ログに残っていない: ${JSON.stringify(failed)}`);
  assert.equal(conv.length, 2, `回答のあとに送れない (${JSON.stringify(after2)})`);
  assert.ok(conv[1].body.includes("二つ目の質問です"), "2 つ目の文が送られていない");
  assert.equal(after2.draft, "", "送ったあと保護入力欄が空になっていない");
});

test("T-SC-21b ChatGPT が送信を受け付けないと、下書きを残し、入力欄を空に戻し、理由を残す", async () => {
  h.server.clear();
  const { page, frame } = await openThread("&ignoreSend=1");
  await h.type(page, frame, "受け付けられない送信です");
  await frame.locator("textarea").press("Enter");
  await sleep(1000);
  const sending = await scSnap(frame);
  await frame.waitForFunction(() => /送信できなかった/.test(document.getElementById("status").textContent), null, { timeout: 9000 });
  const sc = await scSnap(frame);
  const native = await h.nativeText(page);
  const ignored = await mockEvents(page, "submit-ignored");
  const failed = await waitLog("send.failed", (e) => e.d && e.d.reason === "not-accepted");
  await page.close();
  assert.equal(h.server.byKind("conversation").length, 0, "送られた");
  assert.equal(sending.status, "送信中…", "送っている間の表示が無い");
  assert.equal(sc.draft, "受け付けられない送信です", "下書きが消えた");
  assert.equal(native, "", "ChatGPT の入力欄に文が残っている");
  assert.deepEqual(ignored, ["button"], "送信ボタンを押していない");
  assert.ok(failed.some((e) => e.d && e.d.reason === "not-accepted" && e.d.path === "button"), `動作ログに残っていない: ${JSON.stringify(failed)}`);
});

test("T-SC-21c 停止のボタンが送信ボタンの id を持っていても、回答の途中に押さない", async () => {
  h.server.clear();
  h.server.mode.conversationDelayMs = 5000;
  const { page, frame } = await openThread("&stopSharesId=1");
  await h.type(page, frame, "一つ目の質問です");
  await frame.locator("textarea").press("Enter");
  await sleep(1500);
  assert.equal(await streaming(page), true, "前提: 1 つ目の回答の途中");
  assert.equal(await page.evaluate(() => { const b = document.querySelector("#composer-submit-button"); return b && b.dataset.testid; }), "stop-button", "前提: 停止のボタンが送信ボタンの id を持つ");
  await h.type(page, frame, "二つ目の質問です");
  await frame.locator("textarea").press("Enter");
  await page.waitForFunction(() => !window.__mock.state.streaming, null, { timeout: 10000 });
  const stops = await mockEvents(page, "stop-clicked");
  const ok = await mockEvents(page, "conversation-ok");
  const sc = await scSnap(frame);
  await page.close();
  assert.equal(stops.length, 0, "停止のボタンを押した");
  assert.equal(ok.length, 1, "1 つ目の回答が最後まで流れていない");
  assert.equal(sc.draft, "二つ目の質問です", "下書きが消えた");
});

test("T-SC-21d 送信ボタンが遅れて出ても、出るのを待って押す", async () => {
  h.server.clear();
  const { page, frame } = await openThread("&lateSendButton=1");
  await h.type(page, frame, "遅れて出るボタンの確認です");
  await frame.locator("textarea").press("Enter");
  await sleep(2500);
  const conv = h.server.byKind("conversation");
  const sc = await scSnap(frame);
  const via = await mockEvents(page, "submit");
  await page.close();
  assert.equal(conv.length, 1, `送られていない (${JSON.stringify(sc)})`);
  assert.deepEqual(via, ["button"], "送信ボタンで送っていない");
  assert.equal(sc.draft, "", "送ったあと保護入力欄が空になっていない");
});

test("T-SC-21e ログインなしの作り (送信ボタンが「生成を中止」に替わる) でも、回答の途中は送らず、停止を押さない", async () => {
  h.server.clear();
  h.server.mode.conversationDelayMs = 5000;
  const page = await h.openChat("/?variant=loggedout");
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  await h.type(page, frame, "一つ目の質問です");
  await frame.locator("textarea").press("Enter");
  await sleep(1500);
  assert.equal(await streaming(page), true, "前提: 1 つ目の回答の途中");
  assert.equal(await page.evaluate(() => document.querySelector("button[data-composer-submit]").getAttribute("aria-label")), "生成を中止", "前提: 送信ボタンが停止のボタンになっている");
  await h.type(page, frame, "二つ目の質問です");
  await frame.locator("textarea").press("Enter");
  await sleep(1000);
  const during = { sc: await scSnap(frame), native: await h.nativeText(page) };
  await page.waitForFunction(() => !window.__mock.state.streaming, null, { timeout: 10000 });
  const stops = await mockEvents(page, "stop-clicked");
  const ok = await mockEvents(page, "conversation-ok");
  await page.close();
  assert.equal(stops.length, 0, "停止のボタンを押した");
  assert.equal(ok.length, 1, "1 つ目の回答が最後まで流れていない");
  assert.equal(during.sc.draft, "二つ目の質問です", `下書きが消えた (${JSON.stringify(during)})`);
  assert.match(during.sc.status, /回答を作っている途中/, "回答の途中だと知らせていない");
  assert.equal(during.native, "", "回答の途中に ChatGPT の入力欄へ書いた");
});
