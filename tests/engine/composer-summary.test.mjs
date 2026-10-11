// tests/engine/composer-summary.test.mjs — オフ時の警告バッジに出す件数と内訳
//
// 設計は docs/composer-toggle.md の T-01。
// Run: node --test tests/engine/composer-summary.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeWarning } = require("../../browser-extension/composer-toggle.js");

const row = (value, category) => ({ value, category, label: category, count: 1 });

test("T-01 distinct values are counted per category, most frequent first", () => {
  const s = summarizeWarning(
    [row("a@example.com", "CONTACT"), row("090-1234-5678", "CONTACT"), row("田中", "PERSON")],
    [],
    [],
  );
  assert.equal(s.count, 3);
  assert.deepEqual(s.items, [{ name: "連絡先", count: 2 }, { name: "人名", count: 1 }]);
});

test("T-01b values on the allowlist are not counted", () => {
  const s = summarizeWarning([row("a@example.com", "CONTACT"), row("Acme Corp", "ORGANIZATION")], ["Acme Corp"], []);
  assert.equal(s.count, 1);
  assert.deepEqual(s.items, [{ name: "連絡先", count: 1 }]);
});

test("T-01c a confidential sentence alone is a warning", () => {
  const s = summarizeWarning([], [], [{ entity_type: "BUSINESS_CONFIDENTIAL", reason: "frame" }]);
  assert.equal(s.count, 1);
  assert.deepEqual(s.items, [{ name: "機密と思われる文", count: 1 }]);
});

test("T-01d nothing detected means no warning", () => {
  const s = summarizeWarning([], [], []);
  assert.equal(s.count, 0);
  assert.deepEqual(s.items, []);
});

test("T-01e unknown categories and malformed rows do not break the summary", () => {
  const s = summarizeWarning([row("x", "MYSTERY"), null, { value: "" }, row("y", undefined)], [], null);
  assert.equal(s.count, 2);
  assert.deepEqual(s.items, [{ name: "その他", count: 2 }]);
});
