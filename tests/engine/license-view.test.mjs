// tests/engine/license-view.test.mjs — ポップアップと設定画面に出すライセンスの表示 (docs/pro-license.md の D-PRO-10、T-PRO-10)
//
// browser-extension/license/license-view.js の describeLicense(state, now) は、license:get の答えから、
// 画面に出す文と、押せるボタンを決める。chrome の API は使わない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeLicense, describeOpenFailure } = require("../../browser-extension/license/license-view.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 10, 3, 0, 0);
const base = { paid: false, plan: null, email: null, checkedAt: NOW - 60 * 1000, trialEndsAt: null, configured: true, trial: false, pro: false, source: "network" };
const PLAN = { nickname: "Pro 月額", interval: "month", intervalCount: 1, unitAmountCents: 500, currency: "jpy" };

test("T-PRO-10 未購入は「無料版」で、アップグレードとログインを出す", () => {
  const v = describeLicense(base, NOW);
  assert.equal(v.visible, true);
  assert.equal(v.status, "無料版");
  assert.equal(v.note, "");
  assert.deepEqual([v.canUpgrade, v.canLogin, v.canRefresh], [true, true, true]);
});

test("T-PRO-10b 購入済みは「Pro (プラン名)」で、アップグレードとログインは出さない", () => {
  const v = describeLicense({ ...base, paid: true, pro: true, plan: PLAN }, NOW);
  assert.equal(v.status, "Pro (Pro 月額)");
  assert.deepEqual([v.canUpgrade, v.canLogin, v.canRefresh], [false, false, true]);
  assert.equal(describeLicense({ ...base, paid: true, pro: true, plan: { nickname: null } }, NOW).status, "Pro", "プラン名が無ければ Pro だけ");
});

test("T-PRO-10c お試し中は残りの日数を切り上げて出す (境界値)", () => {
  assert.equal(describeLicense({ ...base, trial: true, pro: true, trialEndsAt: NOW + 6 * DAY + 1 }, NOW).status, "Pro (お試し中、あと 7 日)");
  assert.equal(describeLicense({ ...base, trial: true, pro: true, trialEndsAt: NOW + 1 }, NOW).status, "Pro (お試し中、あと 1 日)");
  assert.equal(describeLicense({ ...base, trial: true, pro: true, trialEndsAt: NOW + 1 }, NOW).canUpgrade, true);
});

test("T-PRO-10d 確かめられなかったときは注記を出す。最後に確かめた日時があれば添える", () => {
  const grace = describeLicense({ ...base, paid: true, pro: true, plan: PLAN, source: "grace", error: true, checkedAt: NOW - 2 * DAY }, NOW);
  assert.equal(grace.status, "Pro (Pro 月額)");
  assert.match(grace.note, /^購入状態を確認できませんでした \(最後に確認: .+\)$/);
  const none = describeLicense({ ...base, source: "none", error: true, checkedAt: null }, NOW);
  assert.equal(none.status, "無料版");
  assert.equal(none.note, "購入状態を確認できませんでした");
});

test("T-PRO-10e ID が仮のあいだは、Pro の表示そのものを出さない (D-PRO-12)", () => {
  const v = describeLicense({ ...base, configured: false, source: "unconfigured", checkedAt: null }, NOW);
  assert.equal(v.visible, false);
  assert.deepEqual([v.canUpgrade, v.canLogin, v.canRefresh], [false, false, false]);
});

test("T-PRO-10f 答えが無い (Service Worker に届かない) ときも出さない。画面を壊さない", () => {
  const v = describeLicense(undefined, NOW);
  assert.equal(v.visible, false);
  assert.deepEqual([v.canUpgrade, v.canLogin, v.canRefresh], [false, false, false]);
});

test("T-PRO-10g ページを開けなかったときの文。時間切れは、あとで開くこともあるので「開けなかった」と言い切らない", () => {
  assert.equal(describeOpenFailure("network"), "ページを開けませんでした");
  assert.equal(describeOpenFailure(undefined), "ページを開けませんでした");
  const t = describeOpenFailure("timeout");
  assert.match(t, /返事がありません/);
  assert.doesNotMatch(t, /開けませんでした/);
});
