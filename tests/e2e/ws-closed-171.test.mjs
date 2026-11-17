// tests/e2e/ws-closed-171.test.mjs — 閉じた WebSocket への送信が拡張機能のエラーに見える (docs/release-1.7.1.md の P-EG-01、T-EG-05)
//
// 持ち出しガードは WebSocket.prototype.send を包んでいる。ページが閉じた接続に send() すると、ブラウザが出す
// 「WebSocket is already in CLOSING or CLOSED state.」の出どころが injected.js の行に見えていた。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, sleep } from "../fixtures/harness.mjs";

let h;
before(async () => { h = await launch({ storage: { enabled: true } }); });
after(async () => { if (h) await h.close(); });

test("T-EG-05 閉じた WebSocket への送信で、拡張機能の行を出どころにしたエラーを出さない", async () => {
  const page = await h.openChat("/?variant=thread2026");
  const messages = [];
  page.on("console", (m) => messages.push({ text: m.text(), url: (m.location() && m.location().url) || "" }));
  await sleep(500);
  const r = await page.evaluate(async () => {
    const url = `wss://${location.host}/backend-api/ws`;
    // つながる前の send() はブラウザが例外を投げる (変えない)
    const early = new WebSocket(url);
    let connecting = null;
    try { early.send("too-early"); } catch (e) { connecting = String(e && e.name); }
    early.close();
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); setTimeout(() => rej(new Error("ws open timeout")), 5000); });
    ws.close();
    await new Promise((res) => { ws.onclose = res; setTimeout(res, 2000); });
    let threw = null;
    try { ws.send("after-close"); } catch (e) { threw = String(e && e.name); }
    return { connecting, threw, state: ws.readyState, hooked: WebSocket.prototype.send.name };
  });
  await sleep(500);
  await page.close();
  assert.equal(r.hooked, "patchedWsSend", "前提: 持ち出しガードが send を包んでいる");
  assert.equal(r.connecting, "InvalidStateError", "つながる前の send() の動きが変わった");
  assert.equal(r.state, 3, "前提: 接続が閉じている");
  assert.equal(r.threw, null, "閉じた接続への send() で例外が出た");
  const closed = messages.filter((m) => /CLOSING or CLOSED/.test(m.text));
  assert.equal(closed.length, 0, `コンソールにエラーが出た: ${JSON.stringify(closed)}`);
});
