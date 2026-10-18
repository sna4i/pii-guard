// tests/redteam/fail-closed.test.mjs — マスキングの失敗で原文を送らない (P0-07 / P0-10)
//
// RT-FC-01  ページのスクリプトが MAIN world のエンジンを壊し、window.confirm を常に true にしても、
//           マスキング ON の送信で原文が出ない (改修前は「伏せずに送りますか」の確認を
//           ページが握れるので、原文がそのまま送られる)
// RT-FC-02  Secure Composer (iframe) の中のエンジンが壊れたら送信を止め、下書きを残す。
//           エンジンを壊すのは CDP (テスト側) で、製品のコードに抜け道は無い
// RT-FC-03  会話の送信がネットワークエラーで失敗しても、原文を自動で送り直さない (P0-10)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, piiText, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true } }); });
after(async () => { if (h) await h.close(); });

async function submitDraft(page, text) {
  const frame = await h.waitSecureReady(page, 6000);
  await h.type(page, frame, text);
  await h.enter(page, frame);
  return frame;
}

test("RT-FC-01 ページがエンジンと confirm を握っても、原文は送られない", async () => {
  h.server.clear();
  const canary = makeCanary("FC1");
  const page = await h.openChat("/");
  await page.evaluate(() => {
    window.confirm = () => true; // 「伏せずに送りますか」に勝手に「はい」と答える
    const e = window.__localMaskMCP && window.__localMaskMCP.engine;
    if (e) {
      e.maskAggregated = () => { throw new Error("engine broken by page"); };
      e.maskSanitize = () => { throw new Error("engine broken by page"); };
    }
  });
  const text = piiText(canary).replace(/\n/g, " ");
  await submitDraft(page, text);
  await sleep(3000);
  const conv = h.server.byKind("conversation");
  const leaked = conv.filter((r) => MASKED_BY_ENGINE.some((v) => r.body.includes(v)));
  writeEvidence("rt-fc-01", { conversations: conv.length, leakedConversations: leaked.length });
  await page.close();
  assert.equal(leaked.length, 0, "マスキング ON なのに、原文の個人情報が会話の本文に入って届いた");
});

test("RT-FC-02 iframe のエンジンが壊れたら送信を止め、下書きを残す (P0-07)", async (t) => {
  h.server.clear();
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 6000);
  if (!frame) { await page.close(); t.skip("Secure Composer が無い拡張機能 (改修前)"); return; }
  // CDP でテスト側から iframe の中のエンジンを壊す (製品に抜け道は作らない)
  await frame.evaluate(() => {
    const e = window.__localMaskMCP.engine;
    e.maskSanitize = () => Promise.reject(new Error("engine broken (test)"));
  });
  const canary = makeCanary("FC2");
  const text = piiText(canary).replace(/\n/g, " ");
  await h.type(page, frame, text);
  await h.enter(page, frame);
  await sleep(2500);
  const conv = h.server.byKind("conversation").length;
  const prepares = h.server.byKind("prepare").filter((r) => r.body.includes(canary)).length;
  const draft = await frame.evaluate(() => document.querySelector("textarea").value);
  const st = await frame.evaluate(() => ({ state: document.documentElement.dataset.state, status: document.getElementById("status").textContent }));
  const native = await h.nativeText(page);
  writeEvidence("rt-fc-02", { conversations: conv, preparesWithCanary: prepares, draftKept: draft.includes(canary), draftLen: draft.length, state: st.state, status: st.status, nativeEmpty: !native || !native.trim(), serverKinds: h.server.requests.map((r) => r.kind || r.url).slice(0, 12) });
  await page.close();
  assert.equal(conv, 0, "エンジンが壊れているのに送信された");
  assert.equal(prepares, 0);
  assert.ok(draft.includes(canary), "下書きが消えた");
  assert.ok(!native || !native.includes(canary), "ページの入力欄に原文が入った");
});

test("RT-FC-03 送信がネットワークエラーで失敗しても自動で送り直さない (P0-10)", async (t) => {
  h.server.clear();
  await h.setStorage({ enabled: false }); // OFF: 送るのは原文。失敗時に勝手に再送しないことを見る
  const page = await h.openChat("/");
  const frame = await h.waitSecureReady(page, 6000);
  if (!frame) { await page.close(); await h.setStorage({ enabled: true }); t.skip("Secure Composer が無い拡張機能 (改修前)"); return; }
  // サーバは 500 を返す (ソケット切断 "drop" だと Chrome がトランスポート層で POST を
  // 再試行してしまい、拡張の再送と区別できない。500 は完結した応答なので再試行されない)。
  h.server.mode.conversation = "error500";
  const canary = makeCanary("FC3");
  await h.type(page, frame, canary + " 送信が失敗する文章");
  await h.enter(page, frame);
  await sleep(4000);
  h.server.mode.conversation = "ok";
  await sleep(3000); // 拡張が原文を自動再送するなら、この間に 2 本目が届く
  const conv = h.server.byKind("conversation").filter((r) => r.body.includes(canary));
  const native = await h.nativeText(page);
  writeEvidence("rt-fc-03", { conversationAttempts: conv.length, nativeHasCanary: !!(native && native.includes(canary)), serverKinds: h.server.requests.map((r) => r.kind || r.url).slice(0, 16) });
  await page.close();
  await h.setStorage({ enabled: true });
  assert.ok(conv.length <= 1, `原文が自動で再送された (${conv.length} 回)`);
  assert.ok(!native || !native.includes(canary), "失敗の後、ページの入力欄に原文が残った");
});
