// tests/engine/diag-log.test.mjs — 動作ログの検め、まとめ、保存期間、表示 (docs/diagnostic-log.md)
//
// Run: node --test tests/engine/diag-log.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DL = require("../../browser-extension/diag-log.js");

// chrome.storage.local と同じ形の、メモリの中だけの置き場所
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
  };
}
const NOW = new Date(2026, 9, 28, 14, 10, 0).getTime(); // 2026-10-28 14:10 (端末の時刻)
const DAY = 24 * 60 * 60 * 1000;
const meta = (o = {}) => ({ src: "content", site: "chatgpt.com", now: NOW, ...o });

test("T-LG-01 sanitize keeps known codes and well-typed fields only", () => {
  const ok = DL.sanitize({ code: "send.masked", d: { via: "fetch", attachments: 2 } }, meta());
  assert.equal(ok.code, "send.masked");
  assert.equal(ok.lv, "info", "重さは一覧で決まる (送り手は決められない)");
  assert.deepEqual(ok.d, { via: "fetch", attachments: 2 });
  assert.equal(ok.site, "chatgpt.com");
  assert.equal(ok.src, "content");
  assert.equal(ok.n, 1);

  assert.equal(DL.sanitize({ code: "no.such.code", d: {} }, meta()), null, "一覧に無い出来事は捨てる");
  assert.equal(DL.sanitize(null, meta()), null);
  assert.equal(DL.sanitize({ code: "send.masked", lv: "error" }, meta()).lv, "info", "送り手の重さは無視する");

  const mixed = DL.sanitize({ code: "send.masked", d: {
    via: "telepathy",          // enum の外
    attachments: -1,           // 負の数
    text: "田中様の電話は 090-1234-5678", // 一覧に無い項目
  } }, meta());
  assert.deepEqual(mixed.d, {}, "型に合わない値と一覧に無い項目は捨てる");

  const ints = DL.sanitize({ code: "attach.masked", d: { count: "3", how: "drop" } }, meta());
  assert.deepEqual(ints.d, { how: "drop" }, "文字列の数字は int として受けない");
  assert.deepEqual(DL.sanitize({ code: "attach.masked", d: { count: 2.5 } }, meta()).d, {}, "小数は受けない");
  assert.deepEqual(DL.sanitize({ code: "attach.masked", d: { count: 1e9 } }, meta()).d, {}, "大きすぎる数は受けない");
});

test("T-LG-01b hosts are lower-cased and checked; anything with text in it is dropped", () => {
  assert.equal(DL.sanitize({ code: "egress.blocked", d: { dest: "Api.Amplitude.COM", via: "fetch" } }, meta()).d.dest, "api.amplitude.com");
  for (const bad of ["evil host.com", "例え.jp", "a".repeat(254), "https://x.com/path", "x.com/path?q=1", "user@x.com", "", 42]) {
    assert.equal(DL.sanitize({ code: "egress.blocked", d: { dest: bad } }, meta()).d.dest, undefined, `${JSON.stringify(bad)} は捨てる`);
  }
  assert.equal(DL.sanitize({ code: "send.masked", d: {} }, meta({ site: "https://chatgpt.com/c/123" })).site, null, "サイトもホスト名だけ");
  assert.equal(DL.sanitize({ code: "send.masked", d: {} }, meta({ site: null })).site, null);
});

test("T-LG-01c layers keep tag, popover, role and flags only, up to 6", () => {
  const layers = [];
  for (let i = 0; i < 9; i++) layers.push({ tag: "div", popover: "manual", role: "dialog", modal: false, overlap: i === 0, cls: "secret", text: "田中" });
  const e = DL.sanitize({ code: "toggle.click_ignored", d: { reason: "occluded", layers } }, meta());
  assert.equal(e.d.layers.length, 6, "7 件目以降は捨てる");
  assert.deepEqual(e.d.layers[0], { tag: "div", popover: "manual", role: "dialog", modal: false, overlap: true }, "決めた項目だけ残る");
  const odd = DL.sanitize({ code: "toggle.click_ignored", d: { reason: "occluded", layers: [
    { tag: "DIV", popover: "weird", role: "secretword" },
    { tag: "<script>", popover: "auto" },
  ] } }, meta());
  assert.deepEqual(odd.d.layers, [{ tag: "div", popover: "", role: "other", modal: false, overlap: false }], "タグ名は小文字にし、知らない値は決めた値に置き換え、タグ名が不正なものは捨てる");
});

test("T-LG-01d errors keep a known name and place, never the message", () => {
  const e = DL.sanitize({ code: "error", d: { where: "fetch-hook", name: "SyntaxError", message: "Unexpected token '田'" } }, meta());
  assert.deepEqual(e.d, { where: "fetch-hook", name: "SyntaxError" });
  assert.equal(DL.sanitize({ code: "error", d: { where: "somewhere-else", name: "MyCustomError" } }, meta()).d.name, "Other", "知らない例外名は Other");
  assert.equal(DL.sanitize({ code: "error", d: { where: "somewhere-else" } }, meta()).d.where, undefined, "知らない場所の名前は捨てる");
  assert.deepEqual(DL.errorFields(new TypeError("x is undefined"), "storage"), { where: "storage", name: "TypeError" });
});

test("T-LG-01e times are clamped to now when they are not plausible", () => {
  assert.equal(DL.sanitize({ code: "send.masked", t: NOW - 5000 }, meta()).t, NOW - 5000);
  assert.equal(DL.sanitize({ code: "send.masked", t: NOW + 10 * DAY }, meta()).t, NOW, "未来すぎる時刻は今にする");
  assert.equal(DL.sanitize({ code: "send.masked", t: "yesterday" }, meta()).t, NOW);
});

test("T-LG-02 the same event within 60 seconds is merged; the daily cap is 500 plus one marker", async () => {
  const st = fakeStorage();
  const e = (t, d = { via: "fetch" }) => DL.sanitize({ code: "send.masked", t, d }, meta({ now: t }));
  await DL.append(st, [e(NOW)], NOW);
  await DL.append(st, [e(NOW + 30 * 1000)], NOW + 30 * 1000);
  let day = st.data["diagLog:2026-10-28"];
  assert.equal(day.length, 1, "60 秒以内の同じ出来事は 1 件にまとまる");
  assert.equal(day[0].n, 2);
  assert.equal(day[0].t, NOW + 30 * 1000, "時刻は新しいほうになる");
  await DL.append(st, [e(NOW + 31 * 1000, { via: "ws" })], NOW + 31 * 1000);
  await DL.append(st, [e(NOW + 200 * 1000)], NOW + 200 * 1000);
  day = st.data["diagLog:2026-10-28"];
  assert.equal(day.length, 3, "項目が違うもの、60 秒より離れたものは別の記録");
  assert.deepEqual(st.data.diagLogDays, ["2026-10-28"]);

  const many = [];
  for (let i = 0; i < 520; i++) many.push(DL.sanitize({ code: "attach.masked", t: NOW + 300000 + i * 61000, d: { count: i } }, meta({ now: NOW + 300000 + i * 61000 })));
  const capSt = fakeStorage();
  await DL.append(capSt, many, NOW + 600000);
  const capped = capSt.data["diagLog:2026-10-28"];
  assert.equal(capped.length, 501, "500 件で止まり、上限の記録が 1 件入る");
  assert.equal(capped[500].code, "log.capped");
  await DL.append(capSt, [DL.sanitize({ code: "send.masked", t: NOW + 999999 }, meta({ now: NOW + 999999 }))], NOW + 999999);
  assert.equal(capSt.data["diagLog:2026-10-28"].length, 501, "上限のあとは増えない");
});

test("T-LG-03 days older than 14 are removed; today and the 13 days before stay", async () => {
  const days = [];
  const init = {};
  for (let i = 0; i <= 16; i++) {
    const key = DL.dayKey(NOW - i * DAY);
    days.push(key.slice("diagLog:".length));
    init[key] = [{ t: NOW - i * DAY, lv: "info", src: "content", site: null, code: "send.masked", d: {}, n: 1 }];
  }
  init.diagLogDays = days;
  const st = fakeStorage(init);
  await DL.purge(st, NOW);
  const kept = Object.keys(st.data).filter((k) => k.startsWith("diagLog:")).sort();
  assert.equal(kept.length, 14, "今日を含めて 14 日分");
  assert.equal(kept[0], DL.dayKey(NOW - 13 * DAY));
  assert.ok(!(DL.dayKey(NOW - 14 * DAY) in st.data), "14 日前は消える");
  assert.equal(st.data.diagLogDays.length, 14);
  // 書くたびにも消える (T-LG-09 の単体版)
  st.data[DL.dayKey(NOW - 15 * DAY)] = [];
  st.data.diagLogDays.unshift(DL.dayKey(NOW - 15 * DAY).slice(8));
  await DL.append(st, [DL.sanitize({ code: "send.masked" }, meta())], NOW);
  assert.ok(!(DL.dayKey(NOW - 15 * DAY) in st.data), "書いたときに古い日も消える");
});

test("T-LG-03b readAll returns the newest first within the chosen period", async () => {
  const st = fakeStorage();
  await DL.append(st, [DL.sanitize({ code: "send.masked", t: NOW - 3 * DAY }, meta({ now: NOW - 3 * DAY }))], NOW - 3 * DAY);
  await DL.append(st, [DL.sanitize({ code: "attach.masked", t: NOW - 9 * DAY, d: { count: 1 } }, meta({ now: NOW - 9 * DAY }))], NOW - 9 * DAY);
  await DL.append(st, [DL.sanitize({ code: "egress.blocked", t: NOW, d: { dest: "api.amplitude.com" } }, meta())], NOW);
  const all = await DL.readAll(st, { days: 14, now: NOW });
  assert.deepEqual(all.map((e) => e.code), ["egress.blocked", "send.masked", "attach.masked"]);
  const week = await DL.readAll(st, { days: 7, now: NOW });
  assert.deepEqual(week.map((e) => e.code), ["egress.blocked", "send.masked"]);
  const today = await DL.readAll(st, { days: 1, now: NOW });
  assert.deepEqual(today.map((e) => e.code), ["egress.blocked"]);
  await DL.clear(st);
  assert.deepEqual(await DL.readAll(st, { days: 14, now: NOW }), []);
  assert.equal(Object.keys(st.data).length, 0, "すべて消すと、日付の一覧も消える");
});

test("T-LG-04 every code formats to a Japanese sentence without placeholders", () => {
  const samples = {
    "ext.updated": { from: "1.7.0", to: "1.7.1" },
    "settings.enabled": { value: "off", via: "icon" },
    "settings.changed": { what: "allowlist" },
    "send.masked": { via: "fetch", attachments: 1 },
    "send.cancelled": { via: "ws" },
    "send.blocked": { reason: "unknown-format", via: "xhr" },
    "send.failed": { reason: "write-failed", via: "secure-composer" },
    "ml.skipped": { reason: "timeout", where: "send" },
    "egress.blocked": { dest: "api.amplitude.com", via: "beacon" },
    "egress.scrubbed": { dest: "browser-intake-datadoghq.com", via: "fetch" },
    "attach.masked": { count: 2, how: "drop" },
    "attach.blocked": { count: 1, reason: "binary", how: "picker" },
    "attach.unmasked": { count: 1 },
    "toggle.click_ignored": { reason: "occluded", layers: [{ tag: "div", popover: "manual", role: "", modal: false, overlap: false }] },
    "confirm.click_ignored": { reason: "too-soon" },
    "ui.tampered": { ui: "icon", what: "top-layer" },
    "llm.detect": { status: "found", added: 2, filtered: 1 },
    "llm.replace": { status: "fallback" },
    "llm.http": { status: 403 },
    "gateway.status": { status: 503 },
    "engine.unavailable": { where: "masking" },
    "error": { where: "storage", name: "TypeError" },
    "log.capped": {},
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(DL.CODES).sort(), "すべての出来事に見本がある");
  for (const [code, d] of Object.entries(samples)) {
    const e = DL.sanitize({ code, d }, meta());
    assert.ok(e, code);
    const text = DL.format(e);
    assert.match(text, /[ぁ-んァ-ヶ一-龠]/, `${code} は日本語の文になる`);
    assert.doesNotMatch(text, /undefined|null|\{|\}/, `${code} に穴埋めの残りが無い: ${text}`);
  }
  const merged = { ...DL.sanitize({ code: "send.masked", d: { via: "fetch" } }, meta()), n: 3 };
  assert.match(DL.formatLine(merged), /×3/, "まとめた回数を出す");
  assert.match(DL.formatLine(DL.sanitize({ code: "send.masked" }, meta({ src: "page" }))), /ページ側から報告/);
  assert.match(DL.formatLine(DL.sanitize({ code: "send.masked" }, meta({ site: null }))), /拡張機能/);
});

test("T-LG-04b level depends on the status where the catalog says so", () => {
  assert.equal(DL.sanitize({ code: "llm.detect", d: { status: "failed" } }, meta()).lv, "warn");
  assert.equal(DL.sanitize({ code: "llm.detect", d: { status: "found" } }, meta()).lv, "info");
});
