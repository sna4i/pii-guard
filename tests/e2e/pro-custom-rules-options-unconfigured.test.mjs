// tests/e2e/pro-custom-rules-options-unconfigured.test.mjs — ExtensionPay の ID が仮のままの版 (出荷までの状態) の設定画面に、
// Pro のカスタムルールのカードを出さない (Pro Phase 2 の設計 (P1)、T-CR-46。#pro-card の T-PRO-11b と同じ決まり)
//
// ID が仮の版は、tests/fixtures/harness.mjs の通常の起動 (拡張機能の写しを作らない)。launchPro は ID を替えた写しを
// 読み込むので、同じテストのファイル (node --test では 1 つのプロセス) には置けない。別のファイルにしてある。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true } }); });
after(async () => { if (h) await h.close(); });

test("T-CR-46 ID が仮の版: カード (#custom-rules-card) は出ない。ルールが保存してあっても出ず、確かめの Worker も立てない", async () => {
  // ルールが保存してあっても (別の版で保存したものが残っていても) 出さない
  await h.setStorage({ proCustomRules: { version: 1, rules: [{ id: "r1", label: "PROJECT", kind: "words", words: ["アルファ計画"], match: "exact", enabled: true }] } });
  const p = await h.ctx.newPage();
  const errors = [];
  const workers = []; // 開いてから今までに立てた Worker (立ててすぐ止めたものも数える。p.workers() は、動いているものだけ)
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("worker", (w) => workers.push(w.url()));
  try {
    await p.goto(`chrome-extension://${h.extId}/options.html`);
    // 答えが届いて描き終わるまで待つ (Service Worker への問い合わせを 1 往復させてから見る)
    const state = await p.evaluate(() => chrome.runtime.sendMessage({ type: "license:get" }));
    assert.equal(state.configured, false, "前提: ID が仮");
    await p.waitForTimeout(300);
    assert.notEqual(await p.$("#custom-rules-card"), null, "カードの要素はある (hidden で隠す)");
    assert.equal(await p.$eval("#custom-rules-card", (el) => el.hidden), true, "hidden のまま");
    assert.equal(await p.isVisible("#custom-rules-card"), false, "見えない");
    assert.deepEqual(workers, [], "カードを出さない版では、確かめの Worker も立てない");
    assert.deepEqual(errors, [], "エラーも出さない");
  } finally { await p.close(); }
});
