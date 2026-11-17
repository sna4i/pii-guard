// tests/e2e/sc-single-line-171.test.mjs — 1 行の並びの ChatGPT の入力欄と保護入力欄
// (docs/release-1.7.1.md の「1 行の並びで保護入力欄が切れる不具合」T-SC-22〜22c と、
//  「1 行の並びで、ChatGPT の入力欄が伸びない」T-SC-25〜25e)
//
// モックは ?variant=single2026。作りと並びの決め方は、2026-11-04 に読んだ実物の CSS と JavaScript を写したもの:
// 1 行の並びでは入力欄の箱が 36px に固定され、入力欄に min-height を付けても伸びない。段落が 2 つ以上か改行で
// 2 段の並びになり、空になると 1 行の並びに戻る。Shift+Enter で段落を分ける (合成のキーも受け付ける)。
//
// T-SC-22  案内 (画像を貼ったとき) が出ても、案内が全部見え、文の欄はスクロールしない。保護入力欄は入力欄の中にある
// T-SC-22b 4 行書くと 4 行とも見え、保護入力欄は入力欄の中にあり、右のボタンを覆わない。消すと 1 行の並びに戻る
// T-SC-22c 個人情報を送ると、確認のボタンが見えていて、その位置を押すと送られる
// T-SC-25  1 行に収まらない文を書くと、ChatGPT の入力欄が 2 段の並びに替わり、保護入力欄はその中に収まる
// T-SC-25b 全部消すと 1 行の並びに戻り、ChatGPT の入力欄の段落は 1 つ、付けた高さも外れる
// T-SC-25c 変換中に並びが替わっても、フォーカスと変換は保護入力欄のまま
// T-SC-25d 2 段の並びに替わったあとに送ると、伏せ字で 1 回送られ、1 行の並びに戻る
// T-SC-25e ChatGPT が並びを替えないときは、保護入力欄を上に伸ばして確認のボタンを見せ、動作ログに残す
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, FAKE_PII, sleep } from "../fixtures/harness.mjs";

const SINGLE = "/?variant=single2026";
const LINE = 24; // モックの入力欄の行の高さ
const LONG = "あ".repeat(90); // 1 行の並びでも 2 段の並びでも 1 行に収まらない長さ

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openSingle(query = SINGLE) {
  const page = await h.openChat(query);
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
// ページの測り: ChatGPT の入力欄の並び、保護入力欄の箱、入力欄の文の欄の箱、角丸の箱、右の「高」のボタン
const layout = (page) => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  const hostEl = document.querySelector("[data-pii-guard-secure]");
  const ed = document.querySelector("#prompt-textarea");
  const box = document.querySelector("[data-composer-input-layout]");
  const cs = getComputedStyle(hostEl);
  return {
    layout: box.getAttribute("data-composer-input-layout"),
    rows: document.querySelector("[data-composer-rows]").getAttribute("data-composer-rows"),
    paragraphs: ed.querySelectorAll(":scope > p").length,
    nativeText: ed.textContent,
    nativeStyle: { minHeight: ed.style.minHeight, height: ed.style.height },
    host: r(hostEl), raised: cs.boxShadow !== "none" || cs.borderRadius !== "0px",
    box: r(box), pill: r(document.querySelector(".pill2026")),
    reasoning: r(document.querySelector('[data-composer-navigation-target="reasoning"]')),
  };
});
const inside = (a, b, tol = 1) => a.top >= b.top - tol && a.bottom <= b.bottom + tol && a.left >= b.left - tol && a.right <= b.right + tol;
const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
async function logsOf(code) {
  const all = await h.getStorage(null);
  return Object.entries(all).filter(([k]) => k.startsWith("diagLog:")).flatMap(([, v]) => (Array.isArray(v) ? v : [])).filter((e) => e && e.code === code);
}

test("T-SC-22 1 行の並びで案内が出ても、案内が全部見え、文の欄はスクロールしない", async () => {
  const { page, frame } = await openSingle();
  await frame.evaluate(() => {
    const ed = document.getElementById("editor");
    ed.focus();
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "shot.png", { type: "image/png" }));
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(900);
  const m = await sc(frame);
  const pg = await layout(page);
  await page.close();
  assert.match(m.statusText, /添付/, `前提: 案内が出ている (${JSON.stringify(m.statusText)})`); // オンなので確認が出て、テストでは自動でキャンセルされ「伏せられないファイルは添付しなかったよ。」
  assert.ok(m.status.top >= -1 && m.status.bottom <= m.vh + 1, `案内が切れている: ${JSON.stringify({ status: m.status, vh: m.vh })}`);
  assert.ok(m.edScroll <= m.edClient + 1, `文の欄がスクロールする: ${m.edScroll} > ${m.edClient}`);
  assert.equal(pg.layout, "multiline", `案内のぶん、ChatGPT の入力欄が 2 段の並びに替わっていない: ${JSON.stringify(pg)}`);
  assert.ok(!pg.raised && inside(pg.host, pg.box), `保護入力欄が入力欄の外にはみ出す: ${JSON.stringify({ host: pg.host, box: pg.box, raised: pg.raised })}`);
});

test("T-SC-22b 1 行の並びで 4 行書くと 4 行とも見え、保護入力欄は入力欄の中にある", async () => {
  const { page, frame } = await openSingle();
  const ta = frame.locator("textarea");
  await ta.click();
  for (let i = 1; i <= 4; i++) {
    await ta.pressSequentially(`${i} 行目の文です`, { delay: 2 });
    if (i < 4) await ta.press("Shift+Enter");
  }
  await sleep(900);
  const m = await sc(frame);
  const pg = await layout(page);
  await ta.press("Control+A");
  await ta.press("Delete");
  await sleep(900);
  const empty = await layout(page);
  await page.close();
  assert.ok(m.edScroll <= m.edClient + 1, `4 行で文の欄がスクロールする: ${m.edScroll} > ${m.edClient}`);
  assert.ok(pg.host.height >= 4 * LINE, `保護入力欄が伸びていない: ${JSON.stringify(pg.host)}`);
  assert.equal(pg.layout, "multiline", `ChatGPT の入力欄が 2 段の並びに替わっていない: ${JSON.stringify(pg)}`);
  assert.ok(!pg.raised && inside(pg.host, pg.box) && inside(pg.host, pg.pill), `保護入力欄が入力欄の外にはみ出す: ${JSON.stringify(pg)}`);
  assert.ok(!overlaps(pg.host, pg.reasoning), `右の「高」のボタンを覆っている: ${JSON.stringify({ host: pg.host, reasoning: pg.reasoning })}`);
  assert.equal(empty.layout, "single-line", `消しても 1 行の並びに戻らない: ${JSON.stringify(empty)}`);
  assert.ok(Math.abs(empty.host.height - empty.box.height) <= 2, `消しても入力欄の行の高さに戻らない: ${JSON.stringify(empty)}`);
});

test("T-SC-22c 1 行の並びで個人情報を送ると、確認のボタンが見えていて、押すと送られる", async () => {
  h.server.clear();
  const { page, frame } = await openSingle();
  await h.type(page, frame, `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone} です`);
  await frame.locator("textarea").press("Enter");
  await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 5000 });
  await sleep(900);
  const m = await sc(frame);
  const pg = await layout(page);
  assert.ok(m.confirmBtn.height > 0 && m.confirmBtn.top >= -1 && m.confirmBtn.bottom <= m.vh + 1, `確認のボタンが見えない: ${JSON.stringify({ btn: m.confirmBtn, vh: m.vh })}`);
  assert.ok(!pg.raised && inside(pg.host, pg.box), `保護入力欄が入力欄の外にはみ出す: ${JSON.stringify(pg)}`);
  // 見えている位置をマウスで押す (切れて見えない所は押せない)
  await page.mouse.click(pg.host.left + m.confirmBtn.left + m.confirmBtn.width / 2, pg.host.top + m.confirmBtn.top + m.confirmBtn.height / 2);
  await sleep(2000);
  const conv = h.server.byKind("conversation");
  await page.close();
  assert.equal(conv.length, 1, "送られていない");
  assert.ok(!conv[0].body.includes(FAKE_PII.phone), "伏せ字になっていない");
});

test("T-SC-25 1 行に収まらない文を書くと、ChatGPT の入力欄が 2 段の並びに替わり、保護入力欄はその中に収まる", async () => {
  const { page, frame } = await openSingle();
  const before0 = await layout(page);
  await h.type(page, frame, LONG);
  await sleep(900);
  const m = await sc(frame);
  const pg = await layout(page);
  await page.close();
  assert.equal(before0.layout, "single-line", "前提: 1 行の並び");
  assert.equal(pg.layout, "multiline", `2 段の並びに替わらない: ${JSON.stringify(pg)}`);
  assert.equal(pg.rows, "stacked", "文の行とボタンの行に分かれていない");
  assert.ok(!pg.raised, "保護入力欄が、上に伸ばした板 (角丸と影) になっている");
  assert.ok(inside(pg.host, pg.box) && inside(pg.host, pg.pill), `保護入力欄が入力欄の文の欄からはみ出す: ${JSON.stringify({ host: pg.host, box: pg.box, pill: pg.pill })}`);
  assert.ok(pg.host.height >= 2 * LINE, `2 行分の高さが無い: ${JSON.stringify(pg.host)}`);
  assert.ok(m.edScroll <= m.edClient + 1, `文の欄がスクロールする: ${m.edScroll} > ${m.edClient}`);
  assert.equal(pg.nativeText.trim(), "", "ChatGPT の入力欄に文字が入った");
});

test("T-SC-25b 全部消すと 1 行の並びに戻り、ChatGPT の入力欄の段落は 1 つ、付けた高さも外れる", async () => {
  const { page, frame } = await openSingle();
  await h.type(page, frame, LONG);
  await sleep(900);
  const grown = await layout(page);
  const ta = frame.locator("textarea");
  await ta.press("Control+A");
  await ta.press("Delete");
  await sleep(900);
  const pg = await layout(page);
  await page.close();
  assert.equal(grown.layout, "multiline", "前提: 2 段の並びに替わっている");
  assert.equal(pg.layout, "single-line", `1 行の並びに戻らない: ${JSON.stringify(pg)}`);
  assert.equal(pg.paragraphs, 1, `ChatGPT の入力欄の段落が残っている: ${pg.paragraphs}`);
  assert.deepEqual(pg.nativeStyle, { minHeight: "", height: "" }, "ChatGPT の入力欄に付けた高さが残っている");
  assert.ok(!pg.raised && Math.abs(pg.host.height - pg.box.height) <= 2, `入力欄の行の高さに戻らない: ${JSON.stringify(pg)}`);
});

test("T-SC-25c 変換中に並びが替わっても、フォーカスと変換は保護入力欄のまま", async () => {
  const { page, frame } = await openSingle();
  const ta = frame.locator("textarea");
  await ta.click();
  await ta.pressSequentially("あいう", { delay: 3 });
  const cdp = await page.context().newCDPSession(page);
  const comp = "かんじ".repeat(30);
  const fixed = "漢字".repeat(30);
  try {
    await cdp.send("Input.imeSetComposition", { text: comp, selectionStart: comp.length, selectionEnd: comp.length });
    await sleep(900);
    const mid = await layout(page);
    const inner = await frame.evaluate(() => ({ active: document.activeElement && document.activeElement.id, value: document.getElementById("editor").value }));
    const pageActive = await page.evaluate(() => document.activeElement && document.activeElement.tagName);
    await cdp.send("Input.insertText", { text: fixed });
    await sleep(300);
    const value = await frame.evaluate(() => document.getElementById("editor").value);
    const pg = await layout(page);
    assert.ok(inner.value.includes(comp), `前提: 変換中の文が保護入力欄にある (${inner.value.length} 文字)`);
    assert.equal(mid.layout, "multiline", "変換中の文で 2 段の並びに替わらない");
    assert.equal(inner.active, "editor", "変換中に、保護入力欄の文の欄からフォーカスが外れた");
    assert.equal(pageActive, "IFRAME", "変換中に、ページのフォーカスが保護入力欄 (iframe) から外れた");
    assert.equal(value, "あいう" + fixed, "確定した文が保護入力欄に入っていない");
    assert.equal(pg.nativeText.trim(), "", "ChatGPT の入力欄に文字が入った");
  } finally {
    await cdp.detach().catch(() => {});
    await page.close();
  }
});

test("T-SC-25d 2 段の並びに替わったあとに個人情報を送ると、伏せ字で 1 回送られ、1 行の並びに戻る", async () => {
  h.server.clear();
  const { page, frame } = await openSingle();
  await h.type(page, frame, `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone} です。${LONG}`);
  await sleep(900);
  const mid = await layout(page);
  await h.enter(page, frame);
  await sleep(2500);
  const conv = h.server.byKind("conversation");
  const pg = await layout(page);
  await page.close();
  assert.equal(mid.layout, "multiline", "前提: 2 段の並びに替わっている");
  assert.equal(conv.length, 1, `1 回送られていない: ${conv.length}`);
  assert.ok(!conv[0].body.includes(FAKE_PII.phone), "伏せ字になっていない");
  assert.equal(pg.layout, "single-line", `送ったあと 1 行の並びに戻らない: ${JSON.stringify(pg)}`);
  assert.equal(pg.paragraphs, 1, `送ったあと ChatGPT の入力欄の段落が残っている: ${pg.paragraphs}`);
});

test("T-SC-25e ChatGPT が並びを替えないときは、保護入力欄を上に伸ばして確認のボタンを見せ、動作ログに残す", async () => {
  const { page, frame } = await openSingle(`${SINGLE}&noSplit=1`);
  await h.type(page, frame, `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone} です`);
  await frame.locator("textarea").press("Enter");
  await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 5000 });
  await sleep(1500);
  const m = await sc(frame);
  const pg = await layout(page);
  const logs = await logsOf("composer.not_expanded");
  await page.close();
  assert.equal(pg.layout, "single-line", "前提: モックは合成の Shift+Enter で並びを替えない");
  assert.ok(pg.raised && pg.host.top < pg.box.top, `保護入力欄を上に伸ばしていない: ${JSON.stringify(pg)}`);
  assert.ok(m.confirmBtn.height > 0 && m.confirmBtn.top >= -1 && m.confirmBtn.bottom <= m.vh + 1, `確認のボタンが見えない: ${JSON.stringify({ btn: m.confirmBtn, vh: m.vh })}`);
  assert.equal(logs.length, 1, `動作ログの composer.not_expanded が 1 件でない: ${JSON.stringify(logs)}`);
});
