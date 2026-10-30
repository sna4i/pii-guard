// tests/e2e/sc-single-line-171.test.mjs — 1 行の並びで保護入力欄が切れる不具合
// (docs/release-1.7.1.md の「1 行の並びで保護入力欄が切れる不具合」、T-SC-22〜T-SC-22c)
//
// モックは ?variant=single2026: 2026-10-30 の利用者のスクショの「1 行の並び」(＋、文、「高」、マイク、音声のボタンが 1 行)。
// 入力欄の親が 1 行分 (36px) で切り取り、入力欄に min-height を付けても見えている範囲は増えない (症状からの仮定)。
//
// T-SC-22  案内 (画像を貼ったとき) が出ても、案内が全部見え、文の欄はスクロールしない。文の欄の下の端は入力欄の行に揃う
// T-SC-22b 4 行書くと、保護入力欄が上に伸びて 4 行とも見える。下の端は入力欄の行のまま、右のボタンを覆わない。消すと戻る
// T-SC-22c 個人情報を送ると、確認のボタンが見えていて、その位置を押すと送られる
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, FAKE_PII, sleep } from "../fixtures/harness.mjs";

const SINGLE = "/?variant=single2026";
const LINE = 24; // モックの入力欄の行の高さ

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openSingle() {
  const page = await h.openChat(SINGLE);
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  return { page, frame };
}
// iframe の中の測り (iframe の中の座標)
const sc = (frame) => frame.evaluate(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height }; };
  const ed = document.getElementById("editor");
  const st = document.getElementById("status");
  return {
    edScroll: ed.scrollHeight, edClient: ed.clientHeight, ed: box(ed),
    statusText: st.textContent, status: box(st), confirmBtn: box(document.getElementById("confirm-send")),
    vh: window.innerHeight,
  };
});
// ページの測り: 保護入力欄の箱、入力欄の見えている範囲 (切り取る親と重ねる)、右の「高」のボタン
const layout = (page) => page.evaluate(() => {
  const r = (e) => e.getBoundingClientRect();
  const host = r(document.querySelector("[data-pii-guard-secure]"));
  const ed = r(document.querySelector("#prompt-textarea"));
  const clip = r(document.querySelector("[data-composer-input-layout]"));
  return {
    host: { top: host.top, bottom: host.bottom, left: host.left, right: host.right, height: host.height },
    inputTop: Math.max(ed.top, clip.top), inputBottom: Math.min(ed.bottom, clip.bottom),
    reasoningLeft: r(document.querySelector('[data-composer-navigation-target="reasoning"]')).left,
  };
});

test("T-SC-22 1 行の並びで案内が出ても、案内が全部見え、文の欄はスクロールしない", async () => {
  const { page, frame } = await openSingle();
  await frame.evaluate(() => {
    const ed = document.getElementById("editor");
    ed.focus();
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "shot.png", { type: "image/png" }));
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(800);
  const m = await sc(frame);
  const pg = await layout(page);
  await page.close();
  assert.match(m.statusText, /ファイルや画像/, "前提: 案内が出ている");
  assert.ok(m.status.top >= -1 && m.status.bottom <= m.vh + 1, `案内が切れている: ${JSON.stringify({ status: m.status, vh: m.vh })}`);
  assert.ok(m.edScroll <= m.edClient + 1, `文の欄がスクロールする: ${m.edScroll} > ${m.edClient}`);
  assert.ok(Math.abs(pg.host.top + m.ed.bottom - pg.inputBottom) <= 2, `文の欄の下の端が入力欄の行に揃っていない: ${JSON.stringify({ host: pg.host, ed: m.ed, inputBottom: pg.inputBottom })}`);
});

test("T-SC-22b 1 行の並びで 4 行書くと、保護入力欄が上に伸びて 4 行とも見える", async () => {
  const { page, frame } = await openSingle();
  const ta = frame.locator("textarea");
  await ta.click();
  for (let i = 1; i <= 4; i++) {
    await ta.pressSequentially(`${i} 行目の文です`, { delay: 2 });
    if (i < 4) await ta.press("Shift+Enter");
  }
  await sleep(800);
  const m = await sc(frame);
  const pg = await layout(page);
  await ta.press("Control+A");
  await ta.press("Delete");
  await sleep(800);
  const empty = await layout(page);
  await page.close();
  assert.ok(m.edScroll <= m.edClient + 1, `4 行で文の欄がスクロールする: ${m.edScroll} > ${m.edClient}`);
  assert.ok(pg.host.height >= 4 * LINE, `保護入力欄が伸びていない: ${JSON.stringify(pg.host)}`);
  assert.ok(Math.abs(pg.host.bottom - pg.inputBottom) <= 2, `下の端が入力欄の行から外れた: ${JSON.stringify(pg)}`);
  assert.ok(pg.host.right <= pg.reasoningLeft + 1, `右の「高」のボタンを覆っている: ${JSON.stringify(pg)}`);
  assert.ok(Math.abs(empty.host.height - (empty.inputBottom - empty.inputTop)) <= 2, `消しても入力欄の行の高さに戻らない: ${JSON.stringify(empty)}`);
});

test("T-SC-22c 1 行の並びで個人情報を送ると、確認のボタンが見えていて、押すと送られる", async () => {
  h.server.clear();
  const { page, frame } = await openSingle();
  await h.type(page, frame, `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone} です`);
  await frame.locator("textarea").press("Enter");
  await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 5000 });
  await sleep(600);
  const m = await sc(frame);
  const pg = await layout(page);
  assert.ok(m.confirmBtn.height > 0 && m.confirmBtn.top >= -1 && m.confirmBtn.bottom <= m.vh + 1, `確認のボタンが見えない: ${JSON.stringify({ btn: m.confirmBtn, vh: m.vh })}`);
  // 見えている位置をマウスで押す (切れて見えない所は押せない)
  await page.mouse.click(pg.host.left + m.confirmBtn.left + m.confirmBtn.width / 2, pg.host.top + m.confirmBtn.top + m.confirmBtn.height / 2);
  await sleep(2000);
  const conv = h.server.byKind("conversation");
  await page.close();
  assert.equal(conv.length, 1, "送られていない");
  assert.ok(!conv[0].body.includes(FAKE_PII.phone), "伏せ字になっていない");
});
