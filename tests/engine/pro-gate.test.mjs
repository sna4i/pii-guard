// tests/engine/pro-gate.test.mjs — エンジンの Pro の門 (docs/pro-license.md の T-PRO-08、D-PRO-07)
//
// Pro でないとき、検出の結果は今と同じ。Pro のときだけ、Pro のルールパック (engine/pro-rules.js) が効く。
// Phase 1 ではルールパックは空なので、効くことは、テストの中で一時的に足したルールで確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = "../../browser-extension/engine/";
for (const m of ["dictionaries", "patterns", "classification", "severity", "categories", "aggregate", "force-mask", "blocklist", "user-force-mask", "confidential"]) require(E + m + ".js");
const engine = require(E + "engine.js");
const proRules = require(E + "pro-rules.js");

const TEXT = "山田太郎さん (090-1234-5678、taro.yamada@example.test) の社内コード QA-PRO-7781 について";
const PRO_TEST = { category: "PRO_TEST", entity_type: "PRO_TEST", pattern: /QA-PRO-\d{4}/g };
const types = (dets) => dets.map((d) => `${d.entity_type}:${d.text}`).sort();

// テストの中だけ Pro のルールを 1 つ足し、終わったら外して Pro をオフに戻す (await してから片付ける)
async function withProPattern(fn) {
  proRules.PRO_RULE_PACK.push(PRO_TEST);
  try { return await fn(); } finally {
    proRules.PRO_RULE_PACK.splice(proRules.PRO_RULE_PACK.indexOf(PRO_TEST), 1);
    engine.setProEnabled(false);
  }
}

test("T-PRO-08 Pro の初期値はオフで、Pro のルールパックは空", () => {
  assert.equal(engine.isProEnabled(), false);
  assert.deepEqual(proRules.getProPatterns(new Set()), []);
});

test("T-PRO-08b Pro でないとき、検出の結果は今と同じ (Pro のルールが入っていても使わない)", async () => {
  const before = types(engine.collectDetections(TEXT, {}));
  await withProPattern(() => {
    assert.deepEqual(types(engine.collectDetections(TEXT, {})), before);
  });
});

test("T-PRO-08c Pro のときだけ、Pro のルールパックが効く。オフに戻すと効かない", async () => {
  const base = types(engine.collectDetections(TEXT, {}));
  await withProPattern(() => {
    engine.setProEnabled(true);
    const on = types(engine.collectDetections(TEXT, {}));
    assert.deepEqual(on, [...base, "PRO_TEST:QA-PRO-7781"].sort());
    engine.setProEnabled(false);
    assert.deepEqual(types(engine.collectDetections(TEXT, {})), base);
  });
});

test("T-PRO-08d Pro のルールも、止めた分類 (disabledCategories) には従う", async () => {
  await withProPattern(() => {
    engine.setProEnabled(true);
    const got = types(engine.collectDetections(TEXT, { disabledCategories: ["PRO_TEST"] }));
    assert.ok(!got.some((t) => t.startsWith("PRO_TEST:")), got.join(", "));
  });
});

test("T-PRO-08e Pro のとき、送る文の伏せ字にも Pro のルールが効く (画面を隠すだけの門ではない)", async () => {
  await withProPattern(async () => {
    const off = await engine.maskSanitize(TEXT, {});
    assert.ok(off.sanitized_text.includes("QA-PRO-7781"));
    engine.setProEnabled(true);
    const on = await engine.maskSanitize(TEXT, {});
    assert.ok(!on.sanitized_text.includes("QA-PRO-7781"), on.sanitized_text);
    assert.match(on.sanitized_text, /<PRO_TEST_\d+>/);
  });
});

test("T-PRO-08f setProEnabled は真偽値だけを受け、ほかの値はオフとして扱う", () => {
  try {
    engine.setProEnabled("true");
    assert.equal(engine.isProEnabled(), false);
    engine.setProEnabled(1);
    assert.equal(engine.isProEnabled(), false);
    engine.setProEnabled(true);
    assert.equal(engine.isProEnabled(), true);
  } finally { engine.setProEnabled(false); }
});
