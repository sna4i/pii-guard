// tests/e2e/sc-writing-block-171.test.mjs — 回答の中の文章の欄 (writing block) を、ChatGPT の入力欄と取り違えない
// (docs/release-1.7.1.md の「回答の中の文章の欄を、入力欄と取り違える」T-SC-31〜31e)
//
// モック (?writingBlock=1): 回答を受け取ったら、回答の中に、その場で直せる文章の欄 (div.ProseMirror[contenteditable=true]) を
// 出す。会話は入力欄より前にある (実物と同じ)。
//
// T-SC-31  回答に文章の欄が出ても、保護入力欄は ChatGPT の入力欄に重なったまま (送信の受け持ちも続ける)。文章の欄は覆われず、
//          中身も style も変わらない
// T-SC-31b 文章の欄をクリックして打つと、文章の欄に入る (保護入力欄に移されない)。見回りのあとも保護入力欄は入力欄の上にある
// T-SC-31c 文章の欄があっても、保護入力欄から続けて送れる。送った文は文章の欄に書かれず、文章の欄の中身は変わらない
// T-SC-31d 入力欄の form に送信ボタンが無いとき (?noSendButton=1)、文書全体を探しても、文章の欄の「Send email」は押さず、
//          Enter で送る
// T-SC-31e 文章の欄が送信の入力欄と同じ id (prompt-textarea) を持っていても (?writingBlock=sameId)、保護入力欄は
//          ChatGPT の入力欄の上にあり、文章の欄をクリックして打つと文章の欄に入る
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, sleep } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

const WB_TEXT = "件名: 打ち合わせの日程\n\n来週の打ち合わせの候補日をお送りします。\n\nご都合の良い日をお知らせください。";

// 1 回送って、回答の中に文章の欄を出す。見回り (1 秒おき) と重ね直しを待つ
async function chatWithWritingBlock(query = "?writingBlock=1") {
  h.server.clear();
  const page = await h.openChat("/" + query);
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  await h.type(page, frame, "メールの下書きを書いて");
  await frame.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__mock.events.some((e) => e.type === "writing-block"), null, { timeout: 10000 });
  await sleep(1600);
  return { page, frame };
}
// 文章の欄の最後の段落の末尾をクリックして打つ (CDP の Input.insertText は、フォーカスのある所に入る)
async function typeIntoWritingBlock(page, text) {
  const box = await page.locator('[data-testid="writing-block-editor"] p').last().boundingBox();
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await sleep(300);
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send("Input.insertText", { text }); }
  finally { await cdp.detach().catch(() => {}); }
}
// 保護入力欄の箱・ChatGPT の入力欄・文章の欄の位置と、文章の欄の 1 行目の真ん中でいちばん上にある要素
const probe = (page) => page.evaluate(() => {
  const rect = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); };
  const host = document.querySelector("[data-pii-guard-secure]");
  const wb = document.querySelector('[data-testid="writing-block-editor"]');
  const wr = wb.getBoundingClientRect();
  const top = document.elementFromPoint(wr.left + wr.width / 2, wr.top + Math.min(wr.height / 2, 18));
  const hs = getComputedStyle(host);
  return {
    host: rect(host), hostShown: hs.display !== "none" && hs.visibility !== "hidden",
    composer: rect(document.querySelector("#composer-root #prompt-textarea")), writingBlock: rect(wb),
    topIsWritingBlock: !!(top && wb.contains(top)), wbStyle: wb.getAttribute("style"), wbText: wb.innerText,
    active: document.activeElement ? document.activeElement.getAttribute("data-testid") || document.activeElement.id || document.activeElement.tagName : null,
  };
});
// 保護入力欄の箱が ChatGPT の入力欄にぴったり重なっているか (左・上・幅。高さは下書きで変わる)
const onComposer = (p) => p.hostShown && [0, 1, 2].every((i) => Math.abs(p.host[i] - p.composer[i]) <= 2);
const draftOf = (frame) => frame.evaluate(() => document.getElementById("editor").value);

test("T-SC-31 回答に文章の欄が出ても、保護入力欄は ChatGPT の入力欄に重なったままで、文章の欄は覆われず、中身も変わらない", async () => {
  const { page } = await chatWithWritingBlock();
  const p = await probe(page);
  const owns = await h.scOwns(page);
  await page.close();
  assert.equal(h.server.byKind("conversation").length, 1, "前提: 1 回目が送れた");
  assert.ok(onComposer(p), `保護入力欄が ChatGPT の入力欄の上にない: ${JSON.stringify(p)}`);
  assert.equal(owns, true, "保護入力欄が送信を受け持っていない");
  assert.ok(p.topIsWritingBlock, `文章の欄が覆われている: ${JSON.stringify(p)}`);
  assert.equal(p.wbStyle, null, `文章の欄の style を書き換えた: ${JSON.stringify(p)}`);
  assert.equal(p.wbText, WB_TEXT, "文章の欄の中身が変わった");
});

test("T-SC-31b 文章の欄をクリックして打つと、文章の欄に入る。見回りのあとも保護入力欄は ChatGPT の入力欄の上にある", async () => {
  const { page, frame } = await chatWithWritingBlock();
  await typeIntoWritingBlock(page, "よろしくお願いします。");
  await sleep(1500); // 見回り (1 秒おき) のあと
  const p = await probe(page);
  const draft = await draftOf(frame);
  await page.close();
  assert.equal(p.active, "writing-block-editor", `文章の欄からフォーカスを移された: ${JSON.stringify(p)}`);
  assert.ok(p.wbText.endsWith("ご都合の良い日をお知らせください。よろしくお願いします。"), `打った文が文章の欄に入らない: ${JSON.stringify(p)}`);
  assert.equal(draft, "", `打った文が保護入力欄に入った: ${JSON.stringify(draft)}`);
  assert.ok(onComposer(p), `保護入力欄が ChatGPT の入力欄の上にない: ${JSON.stringify(p)}`);
});

test("T-SC-31c 文章の欄があっても、保護入力欄から続けて送れる。送った文は文章の欄に書かれない", async () => {
  const { page, frame } = await chatWithWritingBlock();
  await h.type(page, frame, "二通目の質問です");
  await frame.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__mock.events.filter((e) => e.type === "conversation-ok").length >= 2, null, { timeout: 8000 }).catch(() => {});
  await sleep(300);
  const conv = h.server.byKind("conversation");
  const wbText = await page.evaluate(() => document.querySelectorAll('[data-testid="writing-block-editor"]')[0].innerText);
  const draft = await draftOf(frame);
  await page.close();
  assert.equal(conv.length, 2, `2 回目が送れない (下書き: ${JSON.stringify(draft)})`);
  assert.ok(conv[1].body.includes("二通目の質問です"), "2 回目の文が送られていない");
  assert.equal(wbText, WB_TEXT, "送った文が文章の欄に書かれた");
  assert.equal(draft, "", "送ったあと保護入力欄が空になっていない");
});

test("T-SC-31d 入力欄の form に送信ボタンが無いとき、文書全体を探しても、文章の欄の「Send email」は押さず、Enter で送る", async () => {
  const { page, frame } = await chatWithWritingBlock("?writingBlock=1&noSendButton=1");
  await h.type(page, frame, "二通目の質問です");
  await frame.locator("textarea").press("Enter");
  await page.waitForFunction(() => window.__mock.events.filter((e) => e.type === "conversation-ok").length >= 2 ||
    window.__mock.events.some((e) => e.type === "writing-block-send"), null, { timeout: 10000 }).catch(() => {});
  await sleep(300);
  const ev = await page.evaluate(() => window.__mock.events.map((e) => e.type + (e.via ? ":" + e.via : "")));
  const conv = h.server.byKind("conversation");
  await page.close();
  assert.ok(ev.includes("submit:enter"), `前提: 送信ボタンが無いので Enter で送っている: ${JSON.stringify(ev)}`);
  assert.equal(ev.includes("writing-block-send"), false, `文章の欄の「Send email」を押した: ${JSON.stringify(ev)}`);
  assert.equal(conv.length, 2, `2 回目が送れない: ${JSON.stringify(ev)}`);
  assert.ok(conv[1].body.includes("二通目の質問です"), "2 回目の文が送られていない");
});

test("T-SC-31e 文章の欄が送信の入力欄と同じ id を持っていても、保護入力欄は ChatGPT の入力欄の上にあり、文章の欄に打てる", async () => {
  const { page, frame } = await chatWithWritingBlock("?writingBlock=sameId");
  const p0 = await probe(page);
  await typeIntoWritingBlock(page, "よろしくお願いします。");
  await sleep(1500); // 見回り (1 秒おき) のあと
  const p = await probe(page);
  const draft = await draftOf(frame);
  await page.close();
  assert.ok(onComposer(p0), `保護入力欄が ChatGPT の入力欄の上にない: ${JSON.stringify(p0)}`);
  assert.equal(p.active, "writing-block-editor", `文章の欄からフォーカスを移された: ${JSON.stringify(p)}`);
  assert.ok(p.wbText.endsWith("よろしくお願いします。"), `打った文が文章の欄に入らない: ${JSON.stringify(p)}`);
  assert.equal(draft, "", `打った文が保護入力欄に入った: ${JSON.stringify(draft)}`);
  assert.ok(onComposer(p), `打ったあと、保護入力欄が ChatGPT の入力欄の上にない: ${JSON.stringify(p)}`);
});
