// tests/e2e/attachment-dnd.test.mjs — ドラッグ&ドロップの添付 (F-SC-13)
//
// ChatGPT はページ全体で drop を受け、落ちたファイルをそのままアップロードする (モックも同じ)。
// attachment-guard が window の capture で先に drop を捕まえ、マスク済みファイルを ChatGPT 自身の
// 汎用 file input に載せる。入力欄の上は Secure Composer の iframe が重なっているので、ファイルの
// ドラッグ中だけ iframe を透過にして drop をページ側に落とす。
//
// ドロップは CDP の Input.dispatchDragEvent で、実ファイルを座標に落とす (ブラウザの当たり判定を通る。
// ページ内で DragEvent を作るのと違い、どの要素/フレームに落ちるかは本物と同じ)。
//
// DND-01 スレッドの上に落としたテキストは、マスク済みで ChatGPT の input 経由でアップロードされる
//        (ページの drop 処理は元ファイルを受け取らない)
// DND-02 入力欄 (iframe) の上に落としても同じ。ドラッグ中だけ透過になり、終わると元に戻る
// DND-03 バイナリ (画像) はマスクできないのでブロック、アップロード 0、ピルが警告色
// DND-04 ダイアログ内への drop は行き先を取り違えないよう止める (アップロード 0)
// DND-05 マスキング OFF では ChatGPT の drop 処理にそのまま任せ、ピルが「未マスク」を警告
// DND-06 ページの JS が偽のドラッグを投げても、入力欄の iframe は透過にならない (操作を奪えない)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, makeCanary, FAKE_PII, MASKED_BY_ENGINE, sleep, writeEvidence } from "../fixtures/harness.mjs";

const HOST = 'div[data-pii-guard="composer-toggle"]';
let h;
let tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pii-sc-dnd-"));
  h = await launch({ storage: { enabled: true, secureComposerEnabled: true } });
});
after(async () => {
  if (h) await h.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name, data) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
}
function piiFile(label) {
  const canary = makeCanary(label);
  const body = `${canary}\n氏名：${FAKE_PII.surname}太郎\n電話：${FAKE_PII.phone}\nメール：${FAKE_PII.email}\n住所：${FAKE_PII.address}\n`;
  return { canary, body };
}

async function openReady() {
  const page = await h.openChat("/");
  await h.waitSecureReady(page, 8000);
  await sleep(1500); // ISOLATED world の attachment-guard / engine 初期化待ち
  return page;
}

// 本物のドラッグ: 入って、透過が効くまで待って、落とす。
// ブラウザ本体 (Aura の WebContentsViewAura::DragUpdatedCallback / Mac も同様) は、カーソル下の
// フレームが変わると旧フレームに dragleave、新フレームに dragenter を送り直す。CDP の
// dispatchDragEvent はこの付け替えをしないので、透過に切り替わった後の「入り直し」をテストが送る。
async function realDrop(page, pt, files) {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files, dragOperationsMask: 1 };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: pt.x, y: pt.y, data });
  await sleep(150);
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: pt.x, y: pt.y, data });
  await sleep(100);
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: pt.x, y: pt.y, data });
  await sleep(100);
  const midDrag = await page.evaluate(() => {
    const host = document.querySelector("[data-pii-guard-secure]");
    return host ? { passthrough: host.getAttribute("data-sc-drag") === "1", pe: host.style.pointerEvents } : null;
  });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: pt.x, y: pt.y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x: pt.x, y: pt.y, data });
  await cdp.detach().catch(() => {});
  return { midDrag };
}

async function points(page) {
  return page.evaluate(() => {
    const host = document.querySelector("[data-pii-guard-secure]");
    const hr = host.getBoundingClientRect();
    const th = document.getElementById("thread").getBoundingClientRect();
    return {
      composer: { x: Math.round(hr.left + hr.width / 2), y: Math.round(hr.top + hr.height / 2) },
      thread: { x: Math.round(th.left + th.width / 2), y: Math.round(th.top + Math.min(120, th.height / 2)) },
    };
  });
}

const mockEvents = (page, type) => page.evaluate((t) => window.__mock.events.filter((e) => e.type === t).length, type);
const pillTone = (page) => page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.dataset.tone : null; }, HOST);

async function dropAndCollect(page, where, file, waitMs = 2500) {
  const since = Date.now();
  const pt = (await points(page))[where];
  const { midDrag } = await realDrop(page, pt, [file]);
  await sleep(waitMs);
  const uploads = h.server.byKind("files-content").filter((r) => r.t >= since);
  return {
    midDrag,
    uploads,
    body: uploads.map((r) => r.body).join("\n"),
    viaInput: await mockEvents(page, "attach-upload"),
    viaPageDrop: await mockEvents(page, "drop-received"),
    leaks: h.leaksOf(MASKED_BY_ENGINE, { since }),
  };
}

test("DND-01 スレッドの上に落としたテキストはマスク済みでアップロードされる", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const { canary, body } = piiFile("DND1");
  const file = writeFile("dnd1.txt", body);
  const page = await openReady();
  const r = await dropAndCollect(page, "thread", file);
  const overlayShown = await page.evaluate(() => document.getElementById("mock-drop-overlay").style.display === "block");
  writeEvidence("dnd-01", { uploads: r.uploads.length, viaInput: r.viaInput, viaPageDrop: r.viaPageDrop, rawLeak: r.leaks.total, hasPlaceholder: /<[A-Z_]+_\d+>/.test(r.body), overlayShown });
  await page.close();
  assert.equal(r.viaPageDrop, 0, "ページの drop 処理が元ファイルを受け取った (横取り失敗)");
  assert.equal(r.viaInput, 1, "ChatGPT の file input 経由で渡っていない");
  assert.equal(r.uploads.length, 1, "アップロードが 1 回でない");
  assert.equal(r.leaks.total, 0, "ドロップした添付の中身に生の個人情報が残って送られた");
  assert.ok(/<[A-Z_]+_\d+>/.test(r.body), "マスクのプレースホルダが無い");
  assert.ok(r.body.includes(canary), "非 PII のカナリアは残るはず (中身が届いた証拠)");
  assert.equal(overlayShown, false, "ドロップ用のオーバーレイが出たまま残った");
});

test("DND-02 入力欄 (iframe) の上に落としても、透過してマスク経路に乗る", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const { canary, body } = piiFile("DND2");
  const file = writeFile("dnd2.txt", body);
  const page = await openReady();
  const r = await dropAndCollect(page, "composer", file);
  await sleep(800); // ドラッグが終わったら透過を戻す (1 秒)
  const after = await page.evaluate(() => {
    const host = document.querySelector("[data-pii-guard-secure]");
    return { pe: host.style.pointerEvents, drag: host.getAttribute("data-sc-drag") };
  });
  const scState = await (await h.secureFrame(page)).evaluate(() => document.documentElement.dataset.state);
  writeEvidence("dnd-02", { midDrag: r.midDrag, after, uploads: r.uploads.length, viaInput: r.viaInput, viaPageDrop: r.viaPageDrop, rawLeak: r.leaks.total, scState });
  await page.close();
  assert.equal(r.midDrag && r.midDrag.passthrough, true, "ドラッグ中に iframe が透過になっていない");
  assert.equal(r.viaPageDrop, 0, "ページの drop 処理が元ファイルを受け取った");
  assert.equal(r.viaInput, 1, "ChatGPT の file input 経由で渡っていない");
  assert.equal(r.leaks.total, 0, "ドロップした添付の中身に生の個人情報が残って送られた");
  assert.ok(r.body.includes(canary), "非 PII のカナリアは残るはず");
  assert.equal(after.pe, "auto", "ドラッグ後に iframe の操作が戻っていない");
  assert.equal(after.drag, null);
  assert.ok(["SECURE_READY", "EDITING"].includes(scState), `Secure Composer の状態が壊れた: ${scState}`);
});

test("DND-03 画像のドロップはブロックされ、ピルが警告色", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const png = writeFile("secret.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]));
  const page = await openReady();
  const r = await dropAndCollect(page, "thread", png, 1500);
  const tone = await pillTone(page);
  writeEvidence("dnd-03", { uploads: r.uploads.length, viaInput: r.viaInput, viaPageDrop: r.viaPageDrop, pillTone: tone });
  await page.close();
  assert.equal(r.uploads.length, 0, "マスクできない画像がアップロードされた");
  assert.equal(r.viaPageDrop, 0);
  assert.equal(tone, "warning", "ブロックしたのにピルが警告色でない");
});

test("DND-04 ダイアログ内への drop は止める (行き先の取り違えを防ぐ)", async () => {
  await h.setStorage({ enabled: true });
  h.server.clear();
  const { body } = piiFile("DND4");
  const file = writeFile("dnd4.txt", body);
  const page = await openReady();
  // プロジェクトのファイル追加のようなダイアログ (ページの drop 処理は document で受ける)
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.setAttribute("role", "dialog");
    d.id = "mock-dialog";
    d.style.cssText = "position:fixed;left:40px;top:40px;width:300px;height:160px;background:#eee;z-index:50";
    d.textContent = "プロジェクトにファイルを追加";
    document.body.appendChild(d);
  });
  const since = Date.now();
  const { midDrag } = await realDrop(page, { x: 190, y: 120 }, [file]);
  await sleep(1500);
  const uploads = h.server.byKind("files-content").filter((r) => r.t >= since);
  const viaPageDrop = await mockEvents(page, "drop-received");
  const tone = await pillTone(page);
  writeEvidence("dnd-04", { midDrag, uploads: uploads.length, viaPageDrop, pillTone: tone });
  await page.close();
  assert.equal(viaPageDrop, 0, "ダイアログへの drop が元ファイルのままページに渡った");
  assert.equal(uploads.length, 0, "ダイアログへの drop が入力欄の添付として送られた");
  assert.equal(tone, "warning");
});

test("DND-05 マスキング OFF は ChatGPT の drop 処理に任せ、ピルが未マスクを警告", async () => {
  await h.setStorage({ enabled: false });
  h.server.clear();
  const { body } = piiFile("DND5");
  const file = writeFile("dnd5.txt", body);
  const page = await openReady();
  const r = await dropAndCollect(page, "thread", file);
  const tone = await pillTone(page);
  writeEvidence("dnd-05", { uploads: r.uploads.length, viaInput: r.viaInput, viaPageDrop: r.viaPageDrop, pillTone: tone });
  await page.close();
  await h.setStorage({ enabled: true });
  assert.equal(r.viaPageDrop, 1, "OFF なのに ChatGPT の drop 処理に渡っていない");
  assert.equal(r.viaInput, 0);
  assert.equal(r.uploads.length, 1);
  assert.equal(tone, "warning", "未マスクの添付なのにピルが警告色でない");
});

test("DND-06 ページの偽ドラッグでは iframe を透過にできない", async () => {
  await h.setStorage({ enabled: true });
  const page = await openReady();
  const r = await page.evaluate(async () => {
    const host = document.querySelector("[data-pii-guard-secure]");
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
    const r = host.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 10 };
    for (let i = 0; i < 5; i++) {
      document.body.dispatchEvent(new DragEvent("dragenter", opts));
      document.body.dispatchEvent(new DragEvent("dragover", opts));
      await new Promise((res) => setTimeout(res, 50));
    }
    return { pe: host.style.pointerEvents, drag: host.getAttribute("data-sc-drag") };
  });
  writeEvidence("dnd-06", r);
  await page.close();
  assert.equal(r.pe, "auto", "ページの偽ドラッグで iframe が透過になった");
  assert.equal(r.drag, null);
});
