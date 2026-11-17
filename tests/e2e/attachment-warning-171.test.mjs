// tests/e2e/attachment-warning-171.test.mjs — 添付の警告を、送るまで出し続ける (docs/release-1.7.1.md の P-SC-17/18、AT-05〜AT-05d)
//
// マスクしていない添付と止めた添付の黄色は、時間では消さない。送ったとき (ChatGPT)、会話が替わったとき、
// 内訳の「確認した」を押したときに消す。アイコンを押したときの内訳は、警告の種類に合わせる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, sleep } from "../fixtures/harness.mjs";

const HOST = 'div[data-pii-guard="composer-toggle"]';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

async function openReady(path = "/") {
  const page = await h.openChat(path);
  await h.waitSecureReady(page, 8000).catch(() => {});
  await sleep(2000); // 添付の見張りとアイコンの立ち上がり
  await page.waitForSelector("#mock-file", { timeout: 5000 });
  return page;
}
// アイコン (閉じた Shadow DOM) の状態。テスト用のフラグがあるときだけホストの data 属性に出る
const pill = (page) => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  return {
    tone: e.dataset.tone,
    layout: e.dataset.layout ? JSON.parse(e.dataset.layout) : null,
    popover: e.dataset.popover ? JSON.parse(e.dataset.popover) : null,
  };
}, HOST);
async function clickPart(page, part) {
  const p = await pill(page);
  const r = p && p.layout && p.layout[part];
  if (!r) return false;
  await page.mouse.click(r[0] + r[2] / 2, r[1] + r[3] / 2);
  return true;
}

test("AT-05 マスキングがオフで画像を添付すると黄色になり、8 秒たっても黄色のまま", async () => {
  await h.setStorage({ enabled: false });
  const page = await openReady();
  await page.setInputFiles("#mock-file", { name: "photo.png", mimeType: "image/png", buffer: PNG });
  await sleep(1000);
  const first = await pill(page);
  await sleep(7500);
  const later = await pill(page);
  await page.close();
  await h.setStorage({ enabled: true });
  assert.equal(first && first.tone, "warning", "添付しても黄色にならない");
  assert.equal(later && later.tone, "warning", "8 秒たったら黄色が消えた");
});

test("AT-05b アイコンを押すと添付の内訳が出て、「確認した」で黄色が消える", async () => {
  await h.setStorage({ enabled: false });
  const page = await openReady();
  await page.setInputFiles("#mock-file", { name: "photo.png", mimeType: "image/png", buffer: PNG });
  await sleep(2200); // 動いた直後のクリックは受け付けない (D-29)
  assert.ok(await clickPart(page, "toggle"), "アイコンを押せない");
  await sleep(500);
  const open = await pill(page);
  assert.equal(open.popover && open.popover.title, "マスクしていない添付があります", `内訳が添付のものでない: ${JSON.stringify(open.popover)}`);
  assert.ok(open.popover.items.some((t) => t.includes("photo.png")), "内訳にファイル名が無い");
  await sleep(600);
  assert.ok(await clickPart(page, "ack"), "「確認した」が無い");
  await sleep(500);
  const done = await pill(page);
  await page.close();
  await h.setStorage({ enabled: true });
  assert.equal(done.tone, "off", `「確認した」を押しても黄色のまま: ${JSON.stringify(done)}`);
});

test("AT-05c ChatGPT でマスキングがオンのとき、確認して添付した画像の黄色は送るまで続き、送ると消える", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const page = await openReady("/?variant=thread2026");
  const frame = await h.waitSecureReady(page, 8000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  page.once("dialog", (d) => d.accept());
  await page.setInputFiles("#mock-file", { name: "photo.png", mimeType: "image/png", buffer: PNG });
  await sleep(8500);
  const waiting = await pill(page);
  await h.type(page, frame, "この画像を見て");
  await frame.locator("textarea").press("Enter");
  await sleep(2500);
  const sent = await pill(page);
  const conv = h.server.byKind("conversation").length;
  await page.close();
  assert.equal(waiting && waiting.tone, "warning", "送る前に黄色が消えた");
  assert.equal(conv, 1, "前提: 送れていない");
  assert.equal(sent && sent.tone, "on", `送ったのに黄色のまま: ${JSON.stringify(sent)}`);
});

test("AT-05d 会話を移ると、添付の黄色が消える", async () => {
  await h.setStorage({ enabled: false });
  const page = await openReady();
  await page.setInputFiles("#mock-file", { name: "photo.png", mimeType: "image/png", buffer: PNG });
  await sleep(1000);
  const before1 = await pill(page);
  await page.click('a[data-nav="c"]');
  await sleep(2500);
  const moved = await pill(page);
  await page.close();
  await h.setStorage({ enabled: true });
  assert.equal(before1 && before1.tone, "warning", "前提: 黄色になっていない");
  assert.equal(moved && moved.tone, "off", `会話を移っても黄色のまま: ${JSON.stringify(moved)}`);
});
