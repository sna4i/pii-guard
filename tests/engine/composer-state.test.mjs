// tests/engine/composer-state.test.mjs — Secure Composer の状態機械 (純粋関数)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SM = require("../../browser-extension/secure-composer/composer-state.js");
const S = SM.STATES;

test("正規の送信の流れを辿れる", () => {
  const m = SM.create();
  assert.equal(m.get(), S.INITIALIZING);
  assert.ok(m.to(S.SECURE_READY));
  assert.ok(m.to(S.EDITING));
  assert.ok(m.to(S.SUBMIT_REQUESTED));
  assert.ok(m.to(S.MASKING));
  assert.ok(m.to(S.COMMIT_READY));
  assert.ok(m.to(S.SUBMITTING));
  assert.ok(m.to(S.SENT));
  assert.ok(m.to(S.SECURE_READY));
});

test("飛び越しの遷移は拒否される", () => {
  const m = SM.create();
  m.to(S.SECURE_READY); m.to(S.EDITING);
  assert.equal(m.to(S.SENT), false, "EDITING から SENT へは飛べない");
  assert.equal(m.to(S.SUBMITTING), false);
  assert.equal(m.get(), S.EDITING);
});

test("MASKING 中は編集できない (競合防止)", () => {
  const m = SM.create();
  m.to(S.SECURE_READY); m.to(S.EDITING); m.to(S.SUBMIT_REQUESTED); m.to(S.MASKING);
  assert.equal(m.canEdit(), false);
  // マスク失敗は MASKING_FAILED にだけ行け、送信へは進めない
  assert.equal(m.to(S.SUBMITTING), false);
  assert.ok(m.to(S.MASKING_FAILED));
  assert.equal(m.canEdit(), true, "失敗後は編集に戻れる");
  assert.ok(m.to(S.EDITING));
});

test("どの状態からも block で BLOCKED に落ち、送信可能な状態へ戻らない", () => {
  const m = SM.create();
  m.to(S.SECURE_READY); m.to(S.EDITING); m.to(S.SUBMIT_REQUESTED); m.to(S.MASKING); m.to(S.COMMIT_READY);
  m.block("tamper");
  assert.equal(m.get(), S.BLOCKED);
  assert.equal(m.canEdit(), false);
  assert.equal(m.to(S.SUBMITTING), false);
  assert.equal(m.to(S.SENT), false);
  assert.ok(m.to(S.INITIALIZING), "回復は作り直しからのみ");
});

test("送信失敗は編集へ戻せる (自動再送なし)", () => {
  const m = SM.create();
  m.to(S.SECURE_READY); m.to(S.EDITING); m.to(S.SUBMIT_REQUESTED); m.to(S.MASKING); m.to(S.COMMIT_READY); m.to(S.SUBMITTING);
  assert.ok(m.to(S.EDITING), "送信失敗 → 編集へ");
  assert.equal(m.get(), S.EDITING);
});

test("onChange が遷移を通知する", () => {
  const m = SM.create();
  const seen = [];
  m.onChange((s) => seen.push(s));
  m.to(S.SECURE_READY); m.to(S.EDITING);
  assert.deepEqual(seen, [S.SECURE_READY, S.EDITING]);
});
