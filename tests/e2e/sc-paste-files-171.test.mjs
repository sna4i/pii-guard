// tests/e2e/sc-paste-files-171.test.mjs — 保護入力欄に貼った画像やファイルを添付する (docs/release-1.7.1.md の P-SC-15、T-SC-24〜T-SC-24c)
//
// 保護入力欄 (iframe) に Ctrl+V で貼ったファイルを、＋ ボタンやドラッグと同じく添付の見張りを通して添付する。
// 中身は拡張機能の中の連絡路で渡し、ページのスクリプトから見える所 (window.postMessage) を通さない。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, makeCanary, FAKE_PII, MASKED_BY_ENGINE, sleep } from "../fixtures/harness.mjs";

const PILL_HOST = 'div[data-pii-guard="composer-toggle"]';
// 架空の PNG (先頭のしるしだけ)
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4];

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openReady() {
  const page = await h.openChat("/?variant=thread2026");
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(1500); // 添付の見張りとエンジンの立ち上がり
  // ページのスクリプトが受け取る message を記録する (ファイルや中身が通っていないかを見る)
  await page.evaluate(() => {
    window.__seenMessages = [];
    window.addEventListener("message", (e) => {
      const d = e.data;
      let s = "";
      try { s = JSON.stringify(d); } catch (_) { s = String(d); }
      const hasFile = (v) => v instanceof Blob || (Array.isArray(v) && v.some(hasFile)) || (v && typeof v === "object" && !(v instanceof Blob) && Object.values(v).some((x) => x instanceof Blob));
      window.__seenMessages.push({ s: s.slice(0, 2000), file: hasFile(d) });
    }, true);
  });
  return { page, frame };
}
// 保護入力欄の中で、ファイルだけの貼り付けを起こす
function pasteFile(frame, name, type, bytesOrText) {
  return frame.evaluate(({ name, type, data }) => {
    const ed = document.getElementById("editor");
    ed.focus();
    const body = Array.isArray(data) ? new Uint8Array(data) : data;
    const dt = new DataTransfer();
    dt.items.add(new File([body], name, { type }));
    ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { name, type, data: bytesOrText });
}
const scSnap = (frame) => frame.evaluate(() => ({ status: document.getElementById("status").textContent, draft: document.getElementById("editor").value }));
const uploads = (page, via) => page.evaluate((v) => window.__mock.events.filter((e) => e.type === v).map((e) => e.name), via);

test("T-SC-24 マスキングがオフなら、保護入力欄に貼った画像を添付する", async () => {
  await h.setStorage({ enabled: false });
  h.server.clear();
  const { page, frame } = await openReady();
  await h.type(page, frame, "この画像を見て");
  await pasteFile(frame, "shot.png", "image/png", PNG);
  await sleep(2500);
  const up = await uploads(page, "attach-upload");
  const sc = await scSnap(frame);
  await page.close();
  await h.setStorage({ enabled: true });
  assert.deepEqual(up, ["shot.png"], `画像が添付されていない (${JSON.stringify(sc)})`);
  assert.equal(h.server.byKind("files-content").length, 1, "アップロードが 1 回でない");
  assert.equal(sc.draft, "この画像を見て", "下書きが変わった");
  assert.doesNotMatch(sc.status, /＋ ボタンかドラッグ/, "添付できたのに案内が出ている");
});

test("T-SC-24b マスキングがオンなら、貼った画像は添付せず、入力欄の下とアイコンで知らせる", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const { page, frame } = await openReady();
  await pasteFile(frame, "shot.png", "image/png", PNG);
  await sleep(2000);
  const up = await uploads(page, "attach-upload");
  const sc = await scSnap(frame);
  const tone = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.dataset.tone : null; }, PILL_HOST);
  await page.close();
  assert.deepEqual(up, [], "伏せられない画像が添付された");
  assert.equal(h.server.byKind("files-content").length, 0, "伏せられない画像がアップロードされた");
  assert.match(sc.status, /伏せられないファイル/, `入力欄の下で知らせていない: ${JSON.stringify(sc)}`);
  assert.equal(tone, "warning", "アイコンが黄色になっていない");
});

test("T-SC-24c マスキングがオンなら、貼ったテキストのファイルは伏せて添付し、中身はページに見えない", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const canary = makeCanary("PASTEFILE");
  const content = `${canary}\n氏名：${FAKE_PII.surname}太郎\n電話：${FAKE_PII.phone}\nメール：${FAKE_PII.email}\n住所：${FAKE_PII.address}`;
  const { page, frame } = await openReady();
  await pasteFile(frame, "memo.txt", "text/plain", content);
  await sleep(2500);
  const up = await uploads(page, "attach-upload");
  const body = h.server.byKind("files-content").map((r) => r.body).join("\n");
  const seen = await page.evaluate(() => window.__seenMessages);
  await page.close();
  assert.equal(up.length, 1, "テキストのファイルが添付されていない");
  assert.ok(body.includes(canary), "中身が届いていない");
  assert.ok(MASKED_BY_ENGINE.every((v) => !body.includes(v)), "添付の中身に生の個人情報が残っている");
  assert.ok(/<[A-Z_]+_\d+>/.test(body), "伏せ字が無い");
  assert.ok(seen.every((m) => !m.file), "ページの message にファイルが通った");
  assert.ok(seen.every((m) => !m.s.includes(canary) && MASKED_BY_ENGINE.every((v) => !m.s.includes(v))), "ページの message に中身が通った");
});
