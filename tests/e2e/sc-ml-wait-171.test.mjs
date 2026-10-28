// tests/e2e/sc-ml-wait-171.test.mjs — ML 検出がオンのとき、保護入力欄の送信がいつまでも待つ不具合 (1.7.0 から)
// (docs/release-1.7.1.md の「ML 検出がオンだと Enter を押しても送れない不具合」、T-SC-20〜T-SC-20c)
//
// モデルの取得先 (huggingface.co) を「つながるが何も返さない」サーバ (fixtures/tarpit.mjs) に向け、
// 取得が止まった状態を作る。実際のモデルは取らない (ネットワークに出ない)。
//
// T-SC-20c ML がオンなら、ページを開いた時点でモデルの読み込みが始まる (何も書かなくても offscreen の文書ができる)。
//          offscreen の文書は一度できると残るので、このテストを最初に置く
// T-SC-20  電話番号を含む下書きを Enter で送ると、1 秒後には「確認中…」が出て、上限 (8 秒) のあと確認バーが出る。
//          送ると 1 回送られ、電話番号は伏せ字になり、「ML の判定が間に合わなかった」と出て、動作ログに ml.skipped が残る
// T-SC-20b マスキングがオフでも、黄色の内訳の「マスキングする」が「確認中…」を出し、上限のあと伏せ字にして、
//          ml.skipped (mask-draft) が残る
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, FAKE_PII, sleep } from "../fixtures/harness.mjs";
import { startTarpit } from "../fixtures/tarpit.mjs";

const THREAD = "/?variant=thread2026";
const PILL_HOST = 'div[data-pii-guard="composer-toggle"]';
const DEADLINE_MS = 8000; // engine/onnx-detector.js の既定 (D-SC-09)
const PII_TEXT = `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone} です`;

let tarpit;
let h;
before(async () => {
  tarpit = await startTarpit();
  h = await launch({
    storage: { enabled: true, secureComposerEnabled: true, mlEnabled: true },
    hostRules: tarpit.rulesFor("huggingface.co", "*.huggingface.co", "hf.co", "*.hf.co"),
  });
});
after(async () => { if (h) await h.close(); if (tarpit) await tarpit.close(); });

const status = (frame) => frame.evaluate(() => document.getElementById("status").textContent);
const draftOf = (frame) => frame.evaluate(() => document.getElementById("editor").value);
async function logsOf(code) {
  const all = await h.getStorage(null);
  return Object.entries(all).filter(([k]) => k.startsWith("diagLog:")).flatMap(([, v]) => (Array.isArray(v) ? v : [])).filter((e) => e && e.code === code);
}
// アイコン (閉じた Shadow DOM) の状態と部品の位置は、テスト用のフラグがあるときだけホストの data 属性に出る
const pill = (page) => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  return e ? { tone: e.dataset.tone, layout: e.dataset.layout ? JSON.parse(e.dataset.layout) : null } : null;
}, PILL_HOST);
async function clickPill(page, part) {
  const p = await pill(page);
  const r = p && p.layout && p.layout[part];
  if (!r) return false;
  await page.mouse.click(r[0] + r[2] / 2, r[1] + r[3] / 2);
  return true;
}
async function openThread() {
  const page = await h.openChat(THREAD);
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  return { page, frame };
}

test("T-SC-20c ML がオンなら、ページを開いた時点でモデルの読み込みが始まる", async () => {
  const hasOffscreen = () => h.sw.evaluate(() => chrome.offscreen.hasDocument());
  assert.equal(await hasOffscreen(), false, "前提: まだ offscreen の文書が無い");
  const { page } = await openThread();
  let started = false;
  for (let i = 0; i < 30 && !started; i++) { started = await hasOffscreen(); if (!started) await sleep(100); }
  await page.close();
  assert.ok(started, "ページを開いてもモデルの読み込みが始まらない");
});

test("T-SC-20 ML の判定が間に合わなくても、上限のあと辞書と正規表現だけで伏せて送る", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const { page, frame } = await openThread();
  await h.type(page, frame, PII_TEXT);
  const t0 = Date.now();
  await frame.locator("textarea").press("Enter");
  await sleep(1000);
  assert.equal(await status(frame), "確認中…", "待っている間の表示が無い");
  await frame.waitForSelector('#confirm[data-show="1"]', { timeout: DEADLINE_MS + 6000 });
  const waited = Date.now() - t0;
  await frame.locator("#confirm-send").click();
  await sleep(2500);
  const st = await status(frame);
  const draft = await draftOf(frame);
  const conv = h.server.byKind("conversation");
  const skipped = await logsOf("ml.skipped");
  await page.close();
  assert.ok(waited >= DEADLINE_MS - 500, `上限より前に ML を諦めた: ${waited} ms`);
  assert.equal(conv.length, 1, "送られていない");
  assert.ok(!conv[0].body.includes(FAKE_PII.phone), "電話番号が伏せ字になっていない");
  assert.equal(draft, "", "送ったあと保護入力欄が空になっていない");
  assert.match(st, /ML の判定が間に合わなかった/, `送ったあとの一言が無い: ${JSON.stringify(st)}`);
  assert.ok(skipped.some((e) => e.d && e.d.reason === "timeout" && e.d.where === "send"), `動作ログに残っていない: ${JSON.stringify(skipped)}`);
});

test("T-SC-20b オフの「マスキングする」も、上限のあと辞書と正規表現だけで伏せる", async () => {
  await h.setStorage({ enabled: false });
  const { page, frame } = await openThread();
  await h.type(page, frame, PII_TEXT);
  await sleep(1800);
  assert.equal((await pill(page)).tone, "warning", "前提: 黄色になっている");
  assert.ok(await clickPill(page, "toggle"), "アイコンを押せない");
  await sleep(600);
  assert.ok(await clickPill(page, "maskOnce"), "内訳の「マスキングする」が出ない");
  await sleep(1000);
  assert.equal(await status(frame), "確認中…", "待っている間の表示が無い");
  const t0 = Date.now();
  let draft = await draftOf(frame);
  while (draft.includes(FAKE_PII.phone) && Date.now() - t0 < DEADLINE_MS + 6000) { await sleep(200); draft = await draftOf(frame); }
  await sleep(1500);
  const st = await status(frame);
  const skipped = await logsOf("ml.skipped");
  await page.close();
  await h.setStorage({ enabled: true });
  assert.match(draft, /<PHONE_NUMBER_\d+>/, `下書きが伏せ字になっていない: ${draft}`);
  assert.match(st, /ML の判定が間に合わなかった.*伏せたよ/, `伏せたあとの一言が無い: ${JSON.stringify(st)}`);
  assert.ok(skipped.some((e) => e.d && e.d.reason === "timeout" && e.d.where === "mask-draft"), `動作ログに残っていない: ${JSON.stringify(skipped)}`);
});
