// tests/engine/leak-detector.test.mjs — 変換形をまたいだ漏えい検査 (spec 12.2)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../../browser-extension/security/leak-detector.js");

const V = "山田太郎";
const EMAIL = "taro.yamada@example.test";

test("生の文字列を見つける", () => {
  assert.equal(L.findLeaks("これは " + V + " です", [V]).length, 1);
  assert.equal(L.findLeaks("無関係な文", [V]).length, 0);
});

test("Base64 に変換された値を見つける", () => {
  const b64 = Buffer.from(V, "utf8").toString("base64");
  assert.ok(L.findLeaks("x" + b64 + "y", [V]).length > 0);
});

test("URL エンコード (+ 区切り含む) を見つける", () => {
  assert.ok(L.findLeaks("q=" + encodeURIComponent(V), [V]).length > 0);
  assert.ok(L.findLeaks("q=" + encodeURIComponent("山田 太郎").replace(/%20/g, "+"), ["山田 太郎"]).length > 0);
});

test("全角数字を見つける", () => {
  assert.ok(L.findLeaks("電話 ０９０１２３４５６７８", ["09012345678"]).length > 0);
});

test("JSON エスケープ (\\uXXXX) を見つける", () => {
  const asciiJson = JSON.stringify({ x: V }); // ensure_ascii ではないが NFC はそのまま
  assert.ok(L.findLeaks(asciiJson, [V]).length > 0);
  const escaped = V.split("").map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  assert.ok(L.findLeaks("prefix" + escaped, [V]).length > 0);
});

test("ゼロ幅文字を挟まれても元の値で検知できる (挿入側は別途正規化)", () => {
  // 値側のゼロ幅を除いた形も候補に含む
  const withZw = "山​田​太​郎";
  assert.ok(L.variantsOf(withZw).some((v) => v.text === V));
});

test("scanRequest は URL・ヘッダー・本文・JSON 内の文字列を見る", () => {
  const req = { url: "https://x/y", headers: { "x-foo": "bar" }, body: JSON.stringify({ a: { b: ["hi " + EMAIL] } }) };
  const hits = L.scanRequest(req, [EMAIL]);
  assert.ok(hits.some((h) => h.field === "body" || h.field === "body-json"));
});

test("結果に値そのものを含めない (番号と形だけ)", () => {
  const hits = L.findLeaks("x" + V, [V]);
  assert.deepEqual(Object.keys(hits[0]).sort(), ["at", "index", "kind"]);
});
