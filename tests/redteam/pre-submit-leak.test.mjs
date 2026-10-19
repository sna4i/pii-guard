// tests/redteam/pre-submit-leak.test.mjs — 送信前の原文の漏れ (P0-01 / P0-02 / P0-03 / P0-09 / P0-15)
//
// RT-NET-01  入力中の原文が prepare に乗ってサーバへ届かない (マスキング ON)
// RT-NET-02  ページが入力欄の文字を beacon / FormData / XHR / Blob / Request / WebSocket / Worker で
//            送ろうとしても、どの経路にも原文が乗らない (ページ側の入力欄に原文が無いため)
// RT-NET-03  マスキング OFF でも、送信前の原文は隔離されたまま (P0-09)
// RT-NET-04  CDP の観測と受信側の記録に矛盾がない (P0-15)
//
// Secure Composer が無い (改修前の) 拡張機能では、ページの入力欄に入力するしかないので
// RT-NET-01 は prepare に原文が乗って失敗する。これが脆弱性の再現になる
// (PII_GUARD_EXT=<改修前の展開先> で実行する)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, piiText, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch(); });
after(async () => { if (h) await h.close(); });

async function typeDraft(page, text) {
  const frame = await h.waitSecureReady(page, 6000);
  // frame があれば iframe に、無ければ (改修前) ページの入力欄に入力する
  await h.type(page, frame, text);
  return frame;
}

async function scenario(name, { masking }) {
  await h.setStorage({ enabled: masking });
  h.server.clear(); h.recorder.clear();
  const since = Date.now();
  const canary = makeCanary(name);
  const text = piiText(canary);
  const values = [canary, ...MASKED_BY_ENGINE];
  const page = await h.openChat("/?telemetry=1&ws=1&worker=1");
  const frame = await typeDraft(page, text);
  await sleep(2500); // prepare の debounce (350ms) と beacon を十分に超える
  await h.recorder.settle();
  const native = await h.nativeText(page);
  const leaks = h.leaksOf(values, { since });
  const prepares = h.server.byKind("prepare");
  const nonEmptyPrepares = prepares.filter((r) => { try { return JSON.parse(r.body).partial_query.content.parts.join("").trim().length > 0; } catch (_) { return true; } });
  const conversations = h.server.byKind("conversation");
  const cons = h.consistency({ since });
  const evidence = {
    scenario: name, masking, secureComposer: !!frame,
    nativeComposerHasCanary: typeof native === "string" && native.includes(canary),
    leakTotal: leaks.total,
    leakChannels: { cdp: leaks.cdp.map((l) => ({ url: l.url.replace(canary, "<CANARY>"), method: l.method, failed: l.failed, target: l.target, kinds: l.hits.map((x) => `${x.field}:${x.kind}`) })), ws: leaks.ws.length, server: leaks.server.map((l) => ({ url: l.url, kind: l.kind })), serverWs: leaks.serverWs.length },
    preparesReceived: prepares.length, nonEmptyPreparesReceived: nonEmptyPrepares.length,
    conversationsReceived: conversations.length,
    consistency: cons,
  };
  writeEvidence(`pre-submit-${name}`, evidence);
  await page.close();
  return evidence;
}

test("RT-NET-01/02 マスキング ON: 入力中の原文がどの経路にも乗らない", async () => {
  const e = await scenario("on", { masking: true });
  console.log("  evidence:", JSON.stringify({ sc: e.secureComposer, native: e.nativeComposerHasCanary, leaks: e.leakTotal, prepare: e.nonEmptyPreparesReceived, conv: e.conversationsReceived }));
  assert.equal(e.nativeComposerHasCanary, false, "ページ側の入力欄に原文がある (P0-03)");
  assert.equal(e.nonEmptyPreparesReceived, 0, "原文入りの prepare がサーバに届いた (P0-02)");
  assert.equal(e.leakTotal, 0, `原文が通信に乗った (P0-01): ${JSON.stringify(e.leakChannels)}`);
  assert.equal(e.conversationsReceived, 0, "送信していないのに会話の送信が始まった");
});

test("RT-NET-03 マスキング OFF: 送信前の原文は隔離されたまま (P0-09)", async () => {
  const e = await scenario("off", { masking: false });
  console.log("  evidence:", JSON.stringify({ sc: e.secureComposer, native: e.nativeComposerHasCanary, leaks: e.leakTotal, prepare: e.nonEmptyPreparesReceived }));
  assert.equal(e.nativeComposerHasCanary, false);
  assert.equal(e.nonEmptyPreparesReceived, 0);
  assert.equal(e.leakTotal, 0, `原文が通信に乗った: ${JSON.stringify(e.leakChannels)}`);
});

test("RT-NET-04 CDP の観測と受信側の記録が矛盾しない (P0-15)", async () => {
  const e = await scenario("consistency", { masking: true });
  console.log("  evidence:", JSON.stringify(e.consistency));
  assert.deepEqual(e.consistency.unexplained, [], "CDP とサーバの記録が食い違う");
});
