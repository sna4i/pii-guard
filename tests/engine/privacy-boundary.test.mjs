// tests/engine/privacy-boundary.test.mjs — 保護入力欄の連絡路のつなぎ直し
// (docs/release-1.7.1.md の「Service Worker が止まると、保護入力欄から送れなくなる」T-SC-26c、D-SC-32〜D-SC-35)
//
// 偽の chrome.runtime でポートを作り、Service Worker が止まったとき (ポートが切れる) の動きを確かめる。
import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BOUNDARY = require.resolve("../../browser-extension/secure-composer/privacy-boundary.js");

function makePort(name) {
  const onMsg = [];
  const onDisc = [];
  return {
    name, sent: [], open: true,
    onMessage: { addListener: (f) => onMsg.push(f) },
    onDisconnect: { addListener: (f) => onDisc.push(f) },
    postMessage(m) { if (!this.open) throw new Error("Attempting to use a disconnected port object"); this.sent.push(m); },
    disconnect() { this.open = false; },
    // テストの操作: Service Worker から届く / Service Worker が止まって切れる
    deliver(m) { for (const f of onMsg) f(m); },
    drop() { this.open = false; for (const f of onDisc) f(); },
  };
}
function makeRuntime() {
  const rt = { id: "ext-id", ports: [] };
  rt.connect = ({ name }) => {
    if (!rt.id) throw new Error("Extension context invalidated.");
    const p = makePort(name);
    rt.ports.push(p);
    return p;
  };
  return rt;
}
const last = (rt) => rt.ports[rt.ports.length - 1];
const requests = (port) => port.sent.filter((m) => m && m.__scReq);
const flush = () => new Promise((r) => setImmediate(r));

let rt;
let boundary;
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  rt = makeRuntime();
  globalThis.chrome = { runtime: rt };
  delete require.cache[BOUNDARY];
  boundary = require(BOUNDARY);
});
afterEach(() => {
  mock.timers.reset();
  delete globalThis.chrome;
});

test("T-SC-26c つなぎ直す: ポートが切れたら 50ms 後に新しいポートでつなぎ直し、hello を送る", () => {
  boundary.connect("sc-iframe");
  assert.equal(rt.ports.length, 1);
  rt.ports[0].drop();
  mock.timers.tick(49);
  assert.equal(rt.ports.length, 1, "50ms より前につなぎ直した");
  mock.timers.tick(1);
  assert.equal(rt.ports.length, 2, "つなぎ直していない");
  assert.deepEqual(last(rt).sent[0], { __sc: "hello", role: "sc-iframe" });
});

test("T-SC-26c 待ちの延び方: 続けて切れるたびに倍になり、5 秒より長くならない。長く続いたあとは 50ms に戻る", () => {
  boundary.connect("sc-content");
  const waits = [];
  for (let i = 0; i < 9; i++) {
    const before = rt.ports.length;
    last(rt).drop(); // つないですぐ切れる (止まった直後など)
    let waited = 0;
    while (rt.ports.length === before && waited < 10_000) { mock.timers.tick(10); waited += 10; }
    waits.push(waited);
  }
  assert.deepEqual(waits, [50, 100, 200, 400, 800, 1600, 3200, 5000, 5000]);
  // 5 秒より長く続いたあとに切れたら、50ms に戻る
  mock.timers.tick(6000);
  const before = rt.ports.length;
  last(rt).drop();
  mock.timers.tick(50);
  assert.equal(rt.ports.length, before + 1, "長く続いたあとなのに 50ms でつなぎ直さない");
});

test("T-SC-26c 置き換え: Service Worker に「置き換えた」と知らされたら、つなぎ直さない", () => {
  boundary.connect("sc-iframe");
  rt.ports[0].deliver({ __sc: "retired" });
  rt.ports[0].drop();
  mock.timers.tick(60_000);
  assert.equal(rt.ports.length, 1, "置き換えられたのにつなぎ直した (互いを追い出し合う)");
});

test("T-SC-26c 拡張機能の入れ替わり: chrome.runtime.id を読めなければ、つなぎ直さない", () => {
  boundary.connect("sc-content");
  rt.id = undefined; // 読み込み直し・更新・オフのあと
  rt.ports[0].drop();
  mock.timers.tick(60_000);
  assert.equal(rt.ports.length, 1, "拡張機能が入れ替わったのに、つなぎ直そうとした");
});

test("T-SC-26c そろう前の頼み: 相手がそろうまで待ってから送り、応答を返す", async () => {
  const b = boundary.connect("sc-iframe");
  const port = rt.ports[0];
  const p = b.request("commit", { text: "x" }, 20000);
  assert.equal(requests(port).length, 0, "相手がそろう前に送った");
  port.deliver({ __sc: "peer-ready" });
  await flush();
  const req = requests(port);
  assert.equal(req.length, 1, "そろったのに送らない");
  assert.equal(req[0].type, "commit");
  port.deliver({ __scRes: true, id: req[0].id, result: { committed: true } });
  assert.deepEqual(await p, { ok: true, result: { committed: true } });
});

test("T-SC-26c そろわない頼み: 5 秒たってもそろわなければ失敗を返す", async () => {
  const b = boundary.connect("sc-iframe");
  const p = b.request("commit", { text: "x" }, 20000);
  mock.timers.tick(5000);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(requests(rt.ports[0]).length, 0, "そろわないのに送った");
});

test("T-SC-26c 切れている間の頼み: すぐにつなぎ直し、そろってから新しいポートで送る", async () => {
  const b = boundary.connect("sc-iframe");
  rt.ports[0].deliver({ __sc: "peer-ready" });
  rt.ports[0].drop(); // Service Worker が止まった
  const p = b.request("commit", { text: "x" }, 20000);
  assert.equal(rt.ports.length, 2, "頼みがあるのに、すぐつなぎ直さない");
  const port = rt.ports[1];
  port.deliver({ __sc: "peer-ready" });
  await flush();
  const req = requests(port);
  assert.equal(req.length, 1, "つなぎ直したポートで送っていない");
  port.deliver({ __scRes: true, id: req[0].id, result: { committed: true } });
  assert.equal((await p).ok, true);
});

test("T-SC-26c 送ったあとに切れた頼み: 失敗にし、つなぎ直しても送り直さない (二重送信を避ける)", async () => {
  const b = boundary.connect("sc-iframe");
  rt.ports[0].deliver({ __sc: "peer-ready" });
  const p = b.request("commit", { text: "x" }, 20000);
  await flush();
  assert.equal(requests(rt.ports[0]).length, 1, "前提: 送った");
  rt.ports[0].drop();
  const r = await p;
  assert.equal(r.ok, false);
  mock.timers.tick(50);
  rt.ports[1].deliver({ __sc: "peer-ready" });
  await flush();
  assert.equal(requests(rt.ports[1]).length, 0, "切れた頼みを送り直した");
});

test("T-SC-26c そろうたびに onReady を呼ぶ (つなぎ直したあとの送り直しのため)", () => {
  const b = boundary.connect("sc-iframe");
  let n = 0;
  b.onReady(() => { n++; });
  rt.ports[0].deliver({ __sc: "peer-ready" });
  rt.ports[0].drop();
  mock.timers.tick(50);
  rt.ports[1].deliver({ __sc: "peer-ready" });
  assert.equal(n, 2, "つなぎ直したあとに onReady が呼ばれない");
});
