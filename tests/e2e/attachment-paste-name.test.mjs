// tests/e2e/attachment-paste-name.test.mjs — 添付のファイル名と、ファイルの貼り付け (F-EG-05/06)
//
// AT-05    ファイル名に含まれる個人情報も伏せる (拡張子は残し、伏せ字の < > は [ ] にする)
// PASTE-01 テキストファイルの貼り付けは、中身をマスクした File で貼り直される (元の File はページに渡らない)
// PASTE-02 画像の貼り付けはマスクできないので止める (アップロード 0、ピルが警告色)
// PASTE-03 文字だけの貼り付けには触らない (添付ガードは介入しない)
//
// 貼り付けは Secure Composer を切った状態 (ネイティブ入力欄) で試す。SC が有効なら貼り付けは
// iframe に入り、iframe 側がファイルを受けずに案内を出す (attachment-dnd の範囲)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, FAKE_PII, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

const HOST = 'div[data-pii-guard="composer-toggle"]';
let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openChat() {
  const page = await h.openChat("/");
  await sleep(2000); // ISOLATED world の attachment-guard / engine 初期化待ち
  await page.waitForSelector("#mock-file", { state: "attached", timeout: 5000 });
  return page;
}
const events = (page, type) => page.evaluate((t) => window.__mock.events.filter((e) => e.type === t), type);
const pillTone = (page) => page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.dataset.tone : null; }, HOST);

async function pasteFile(page, { name, type, content, bytes, text }) {
  await page.evaluate(({ name, type, content, bytes, text }) => {
    const dt = new DataTransfer();
    const body = bytes ? new Uint8Array(bytes) : content;
    dt.items.add(new File([body], name, { type }));
    if (text) dt.setData("text/plain", text);
    const ed = document.querySelector("#prompt-textarea");
    ed.focus();
    ed.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  }, { name, type, content, bytes, text });
}

test("AT-05 ファイル名の個人情報も伏せる", async () => {
  await h.setStorage({ enabled: true, secureComposerEnabled: true });
  h.server.clear();
  const canary = makeCanary("AT5");
  const page = await openChat();
  await page.setInputFiles("#mock-file", { name: `${FAKE_PII.surname}太郎_連絡先.txt`, mimeType: "text/plain", buffer: Buffer.from(`${canary}\n電話 ${FAKE_PII.phone}`, "utf8") });
  await sleep(2500);
  const ups = await events(page, "attach-upload");
  writeEvidence("at-05", { uploads: ups.length, nameMasked: ups.length ? !ups[0].name.includes(FAKE_PII.surname) : null, keepsExt: ups.length ? /\.txt$/.test(ups[0].name) : null });
  await page.close();
  assert.equal(ups.length, 1);
  assert.ok(!ups[0].name.includes(`${FAKE_PII.surname}太郎`), `ファイル名に氏名が残った: ${ups[0].name}`);
  assert.match(ups[0].name, /\[[A-Z_]+_\d+\]/, "ファイル名の伏せ字は [ ] の形");
  assert.match(ups[0].name, /_連絡先\.txt$/, "拡張子と個人情報でない部分は残す");
  assert.equal(h.leaksOf(MASKED_BY_ENGINE).total, 0);
});

test("PASTE-01 テキストファイルの貼り付けは、マスクした File で貼り直す", async () => {
  await h.setStorage({ enabled: true, secureComposerEnabled: false });
  h.server.clear();
  const canary = makeCanary("PST1");
  const page = await openChat();
  await pasteFile(page, { name: "memo.txt", type: "text/plain", content: `${canary}\n電話 ${FAKE_PII.phone}\nメール ${FAKE_PII.email}` });
  await sleep(2500);
  const uploaded = h.server.byKind("files-content");
  const body = uploaded.map((r) => r.body).join("\n");
  const leaks = h.leaksOf(MASKED_BY_ENGINE);
  writeEvidence("paste-01", { uploads: uploaded.length, rawLeak: leaks.total, hasPlaceholder: /<[A-Z_]+_\d+>/.test(body), canaryDelivered: body.includes(canary) });
  await page.close();
  assert.equal(uploaded.length, 1, "貼り付けたファイルが 1 回アップロードされていない");
  assert.equal(leaks.total, 0, "貼り付けたファイルの中身に生の個人情報が残った");
  assert.ok(/<[A-Z_]+_\d+>/.test(body));
  assert.ok(body.includes(canary), "非 PII のカナリアは残るはず");
});

test("PASTE-02 画像の貼り付けはマスクできないので止める", async () => {
  await h.setStorage({ enabled: true, secureComposerEnabled: false });
  h.server.clear();
  const page = await openChat();
  await pasteFile(page, { name: "screenshot.png", type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13] });
  await sleep(1500);
  const uploaded = h.server.byKind("files-content");
  const pasted = await events(page, "paste-received");
  const tone = await pillTone(page);
  writeEvidence("paste-02", { uploads: uploaded.length, pasteEvents: pasted.length, pillTone: tone });
  await page.close();
  assert.equal(uploaded.length, 0, "マスクできない画像がアップロードされた");
  assert.equal(pasted.length, 0, "元の画像がページの貼り付け処理に渡った");
  assert.equal(tone, "warning");
});

test("PASTE-03 文字だけの貼り付けには介入しない", async () => {
  await h.setStorage({ enabled: true, secureComposerEnabled: false });
  const page = await openChat();
  const intercepted = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "ただの文字");
    const ed = document.querySelector("#prompt-textarea");
    let seenByPage = false;
    const probe = (e) => { if (e.clipboardData && e.clipboardData.getData("text/plain") === "ただの文字") seenByPage = true; };
    document.addEventListener("paste", probe);
    ed.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
    document.removeEventListener("paste", probe);
    return !seenByPage;
  });
  await page.close();
  await h.setStorage({ secureComposerEnabled: true });
  assert.equal(intercepted, false, "文字だけの貼り付けが止められた");
});
