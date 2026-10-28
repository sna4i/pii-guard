// tests/e2e/sc-fixes-171.test.mjs — Secure Composer (ChatGPT の保護入力欄) の 1.7.1 の修正
// (docs/release-1.7.1.md の「Secure Composer の修正」、T-SC-14〜T-SC-18)
//
// モックは 2026-10-28 に利用者の画面で診断した作り (?variant=thread2026): 暗い表示、角丸の箱は入力欄の 7 段上、
// 入力欄に min-height を付けると箱ごと上に伸びる。
//
// T-SC-14 保護入力欄の背景が箱の色と同じ (不透明の箱、半透明の箱、oklch() の半透明の箱)。iframe も暗い color-scheme になる
// T-SC-15 5 行書いても保護入力欄の中でスクロールしない。ChatGPT の入力欄も伸び、重なりが保たれる。消すと戻る
// T-SC-15b 入力欄の親の上限を超えて書くと、保護入力欄の中でスクロールし、親からはみ出さず、下の段のボタンを覆わない
// T-SC-15c 上限まで伸びた下書きで送信前の確認が出ても、確認のボタンは保護入力欄の中に見えていて、押せば送られる
// T-SC-16 オフで個人情報を書くとアイコンが黄色になる。ページのイベントでは消せない。オンでは黄色にならない
// T-SC-17 黄色の内訳の「マスキングする」で下書きが伏せ字になり、黄色が消える
// T-SC-18 除外リストの値は、オンで送っても残り、オフの警告にも数えられない
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, FAKE_PII, sleep } from "../fixtures/harness.mjs";

const THREAD = "/?variant=thread2026";
const PILL_HOST = 'div[data-pii-guard="composer-toggle"]';
const PII_TEXT = `${FAKE_PII.surname}さんの電話は ${FAKE_PII.phone}、メールは ${FAKE_PII.email} です`;

let h;
before(async () => { h = await launch({ storage: { enabled: true, secureComposerEnabled: true } }); });
after(async () => { if (h) await h.close(); });

const rect = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
}, sel);
// アイコン (閉じた Shadow DOM) の状態と部品の位置は、テスト用のフラグがあるときだけホストの data 属性に出る
const pill = (page) => page.evaluate((sel) => {
  const e = document.querySelector(sel);
  return e ? { tone: e.dataset.tone, warn: Number(e.dataset.warn || 0), layout: e.dataset.layout ? JSON.parse(e.dataset.layout) : null } : null;
}, PILL_HOST);
async function clickPill(page, part) {
  const p = await pill(page);
  const r = p && p.layout && p.layout[part];
  if (!r) return false;
  await page.mouse.click(r[0] + r[2] / 2, r[1] + r[3] / 2);
  return true;
}
async function openThread(query = "") {
  const page = await h.openChat(THREAD + query);
  const frame = await h.waitSecureReady(page, 10000);
  assert.ok(frame, "Secure Composer が立ち上がっていない");
  await sleep(500);
  return { page, frame };
}

test("T-SC-14 保護入力欄の背景が、深い所にある入力欄の箱の色と同じになる", async () => {
  for (const [query, expected] of [["", "rgb(48, 48, 48)"], ["&pill=translucent", "rgb(13, 13, 13)"], ["&pill=oklch", "rgb(13, 13, 13)"]]) {
    const { page, frame } = await openThread(query);
    const bg = await frame.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    const inner = await frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    const outer = await page.evaluate(() => getComputedStyle(document.querySelector("[data-pii-guard-secure] iframe")).colorScheme);
    await page.close();
    assert.equal(bg, expected, `箱の色と違う (${query || "不透明の箱"})`);
    assert.match(inner, /dark/, "iframe の中が暗い color-scheme になっていない");
    assert.match(outer, /dark/, "iframe の要素が暗い color-scheme になっていない");
  }
});

test("T-SC-15 書いた行数に合わせて伸び、中でスクロールしない。消すと戻る", async () => {
  const { page, frame } = await openThread();
  const native0 = await rect(page, "#prompt-textarea");
  const box0 = await rect(page, ".pill2026");
  const ta = frame.locator("textarea");
  await ta.click();
  for (let i = 1; i <= 5; i++) {
    await ta.pressSequentially(`${i} 行目の文章です`, { delay: 2 });
    if (i < 5) await ta.press("Shift+Enter");
  }
  await sleep(1000);
  const inner = await frame.evaluate(() => { const e = document.getElementById("editor"); return { sh: e.scrollHeight, ch: e.clientHeight }; });
  const native = await rect(page, "#prompt-textarea");
  const host = await rect(page, "[data-pii-guard-secure]");
  const box = await rect(page, ".pill2026");
  assert.ok(inner.sh <= inner.ch + 2, `保護入力欄の中でスクロールが要る (scrollHeight=${inner.sh}, clientHeight=${inner.ch})`);
  assert.ok(native.h >= native0.h + 4 * 20, `ChatGPT の入力欄が伸びていない (${native0.h} → ${native.h})`);
  assert.ok(box.h > box0.h + 60 && box.top < box0.top, `入力欄の箱が上に伸びていない (${JSON.stringify(box0)} → ${JSON.stringify(box)})`);
  assert.ok(Math.abs(host.top - native.top) <= 1 && Math.abs(host.h - native.h) <= 2, `保護入力欄が入力欄に重なっていない (host=${JSON.stringify(host)} native=${JSON.stringify(native)})`);
  await ta.press("Control+A");
  await ta.press("Delete");
  await sleep(1000);
  const nativeAfter = await rect(page, "#prompt-textarea");
  const minH = await page.evaluate(() => document.getElementById("prompt-textarea").style.minHeight);
  await page.close();
  assert.ok(Math.abs(nativeAfter.h - native0.h) <= 2, `消しても入力欄が元の高さに戻らない (${native0.h} → ${nativeAfter.h})`);
  assert.equal(minH, "", "消したあとも min-height が残っている");
});

test("T-SC-15b 入力欄の親の上限を超えて書くと、保護入力欄の中でスクロールし、下の段のボタンを覆わない", async () => {
  const { page, frame } = await openThread();
  const ta = frame.locator("textarea");
  await ta.click();
  for (let i = 1; i <= 12; i++) {
    await ta.pressSequentially(`${i} 行目`, { delay: 2 });
    if (i < 12) await ta.press("Shift+Enter");
  }
  await sleep(1200);
  const clip = await rect(page, "[data-composer-input-layout]");
  const host = await rect(page, "[data-pii-guard-secure]");
  const inner = await frame.evaluate(() => { const e = document.getElementById("editor"); return { sh: e.scrollHeight, ch: e.clientHeight }; });
  // 下の段の音声入力のボタンの中心に、ページの要素として何があるか (保護入力欄が覆っていれば iframe になる)
  const micHit = await page.evaluate(() => {
    const b = document.querySelector('[aria-label="音声入力"]');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === b || b.contains(hit));
  });
  await page.close();
  assert.ok(host.top >= clip.top - 1 && host.top + host.h <= clip.top + clip.h + 1,
    `保護入力欄が入力欄の親からはみ出している (host=${JSON.stringify(host)} clip=${JSON.stringify(clip)})`);
  assert.ok(Math.abs(host.h - clip.h) <= 2, `保護入力欄が入力欄の親の上限まで伸びていない (host=${host.h} clip=${clip.h})`);
  assert.ok(inner.sh > inner.ch + 24, `保護入力欄の中でスクロールしていない (scrollHeight=${inner.sh}, clientHeight=${inner.ch})`);
  assert.ok(micHit, "音声入力のボタンが保護入力欄に覆われている");
});

test("T-SC-15c 上限まで伸びた下書きで送信前の確認が出ても、確認のボタンは保護入力欄の中に見えている", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const { page, frame } = await openThread();
  const ta = frame.locator("textarea");
  await ta.click();
  for (let i = 1; i <= 12; i++) {
    await ta.pressSequentially(i === 1 ? `電話は ${FAKE_PII.phone} です` : `${i} 行目`, { delay: 2 });
    if (i < 12) await ta.press("Shift+Enter");
  }
  await sleep(800);
  await h.enterNoConfirm(page, frame);
  await frame.waitForSelector('#confirm[data-show="1"]', { timeout: 4000 });
  await sleep(800);
  // iframe の中は利用者がスクロールできない (body は overflow:hidden)。ボタンが iframe の表示の中にあるか
  const seen = await frame.evaluate(() => {
    const b = document.getElementById("confirm-send").getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: window.innerHeight, scrollY: Math.round(document.scrollingElement.scrollTop) };
  });
  const host = await rect(page, "[data-pii-guard-secure]");
  const clip = await rect(page, "[data-composer-input-layout]");
  await frame.locator("#confirm-send").click();
  await sleep(2000);
  const sent = h.server.byKind("conversation").length;
  await page.close();
  assert.ok(seen.scrollY === 0 && seen.top >= 0 && seen.bottom <= seen.vh, `確認のボタンが保護入力欄の外にある (${JSON.stringify(seen)})`);
  assert.ok(host.top + host.h <= clip.top + clip.h + 1, `保護入力欄が入力欄の親からはみ出している (host=${JSON.stringify(host)} clip=${JSON.stringify(clip)})`);
  assert.equal(sent, 1, "確認の送信を押したのに送られていない");
});

test("T-SC-16 オフで個人情報を書くとアイコンが黄色になり、ページのイベントでは消せない", async () => {
  await h.setStorage({ enabled: false });
  const { page, frame } = await openThread();
  await h.type(page, frame, PII_TEXT);
  await sleep(1500);
  let p = await pill(page);
  assert.ok(p, "アイコンが無い");
  assert.equal(p.tone, "warning", `黄色になっていない (${p.tone})`);
  assert.ok(p.warn >= 2, `件数が出ていない (${p.warn})`);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("mask-mcp:sc-draftinfo", { detail: { count: 0, categories: {} } }));
    window.dispatchEvent(new CustomEvent("mask-mcp:sc-maskinfo", { detail: { maskedCount: 0 } }));
  });
  await sleep(800);
  p = await pill(page);
  assert.equal(p.tone, "warning", "ページのイベントで黄色が消えた");
  await h.setStorage({ enabled: true });
  await sleep(1500);
  p = await pill(page);
  await page.close();
  assert.notEqual(p.tone, "warning", "オンなのに黄色のまま");
});

test("T-SC-17 黄色の内訳の「マスキングする」で、下書きが伏せ字になる", async () => {
  await h.setStorage({ enabled: false });
  const { page, frame } = await openThread();
  await h.type(page, frame, PII_TEXT);
  await sleep(1800);
  assert.equal((await pill(page)).tone, "warning", "前提: 黄色になっている");
  assert.ok(await clickPill(page, "toggle"), "アイコンを押せない");
  await sleep(600);
  assert.ok(await clickPill(page, "maskOnce"), "内訳の「マスキングする」が出ない");
  await sleep(1500);
  const draft = await frame.evaluate(() => document.querySelector("textarea").value);
  const p = await pill(page);
  const st = await h.getStorage(["enabled"]);
  await page.close();
  await h.setStorage({ enabled: true });
  assert.ok(!draft.includes(FAKE_PII.phone) && !draft.includes(FAKE_PII.email), `下書きに個人情報が残っている: ${draft}`);
  assert.match(draft, /<PHONE_NUMBER_\d+>/, "下書きが伏せ字になっていない");
  assert.notEqual(p.tone, "warning", "伏せたあとも黄色のまま");
  assert.equal(st.enabled, false, "「マスキングする」でオン/オフは変わらない");
});

test("T-SC-18 除外リストの値は伏せず、オフの警告にも数えない", async () => {
  await h.setStorage({ enabled: true, maskAllowlist: [FAKE_PII.email] });
  h.server.clear();
  let { page, frame } = await openThread();
  await h.type(page, frame, `${FAKE_PII.surname}さんのメールは ${FAKE_PII.email}、電話は ${FAKE_PII.phone}`);
  await h.enter(page, frame);
  await sleep(2500);
  const body = h.server.byKind("conversation").map((r) => r.body).join("\n");
  await page.close();
  assert.ok(body.includes(FAKE_PII.email), "除外リストの値が伏せられた");
  assert.ok(!body.includes(FAKE_PII.phone), "除外していない値が伏せられていない");
  await h.setStorage({ enabled: false });
  ({ page, frame } = await openThread());
  await h.type(page, frame, `連絡先は ${FAKE_PII.email} です`);
  await sleep(1500);
  const p = await pill(page);
  await page.close();
  await h.setStorage({ enabled: true, maskAllowlist: [] });
  assert.notEqual(p.tone, "warning", "除外リストの値だけなのに黄色になった");
});
