// tests/engine/hostmatch.test.mjs — trusted-provider host 判定 (T-22)
//
// commit security review (2026-11-24) の指摘: SUPPORTED_HOST_RE は substring マッチで、
// "evilchatgpt.com" や path に "chatgpt.com" を含む URL (worker hook は URL 文字列全体を
// test していた) を trusted provider と扱っていた。設計線: 解析した hostname で
// exact + subdomain root の構造照合 (README の掲載ドメインと同じ)。
// 実装は browser-extension/hostmatch.js、注入順は content.js (injected.js より前)。
//
// Run: node --test tests/engine/hostmatch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const HOST = require("../../browser-extension/hostmatch.js");

const BASE = "https://chatgpt.com/";

// 1) substring false positive は provider にしない (review の指摘そのもの)
test("T-22.1 substring lookalike hosts are not providers", () => {
  for (const host of ["evilchatgpt.com", "chatgpt.com.attacker.test", "notclaude.ai",
                      "evilmanus.im", "butterfly-effect.dev.attacker.test"]) {
    assert.equal(HOST.isProviderHost(host), false, `「${host}」は substring で引っかかる`);
  }
});

// 2) worker hook が使っていた形: URL 文字列 test ではなく hostname で決める
test("T-22.2 a URL whose path contains a provider name is not a provider URL", () => {
  assert.equal(HOST.isProviderUrl("https://evil.net/chatgpt.com/worker.js", BASE), false);
});

// 3) 実 host と subdomain は provider のまま (README の掲載線)
test("T-22.3 real hosts and subdomains stay providers", () => {
  for (const host of ["chatgpt.com", "claude.ai", "sub.claude.ai", "claude.com",
                      "sub.claude.com", "chat.openai.com", "api.openai.com",
                      "gemini.google.com", "sub.manus.im", "butterfly-effect.dev"]) {
    assert.equal(HOST.isProviderHost(host), true, `「${host}」`);
  }
  assert.equal(HOST.isProviderHost("chatgpt.com."), true, "trailing dot は正規化");
});

// 4) blob worker は WHATWG URL で host が空。blob: の inner origin を見る。
//    今の substring 版は blob:https://chatgpt.com/uuid を捕まえているので、構造照合に
//    載せ替えたとき挙動を保つ (chatgpt.com 実測の worker は script URL だが、page JS は
//    blob worker を作るのが普通)。
test("T-22.4 blob URL keeps the embedded origin", () => {
  assert.equal(HOST.isProviderUrl("blob:https://chatgpt.com/66b39659-5dfc-4ced-a639-2c52afe361c8", BASE), true);
  assert.equal(HOST.isProviderUrl("blob:https://evil.net/chatgpt.com", BASE), false);
});

// 7) adapter ごとの掲載 domain。pickAdapter の host gate は全 provider を通すが、
//    adapter 選定 (どの adapter が処理するか) はその adapter 自分の domain ルートで
//    決める。inline regex コピーの代替はこれ (T-22.6 が注入済みファイルで照合する)。
test("T-22.7 adapter domains match exactly or as subdomain roots", () => {
  assert.equal(HOST.hostMatches("https://sub.claude.ai/api/completion", BASE, ["claude.ai"]), true);
  assert.equal(HOST.hostMatches("https://evilchatgpt.com/backend-api/conversation", BASE, ["chatgpt.com"]), false);
  assert.equal(HOST.hostMatches("https://chatgpt.com.attacker.test/x", BASE, ["chatgpt.com"]), false);
  assert.equal(HOST.hostMatches("wss://sub.manus.im/socket.io/?EIO=4&transport=websocket", BASE, ["manus.im"]), true);
  assert.equal(HOST.hostMatches("https://evil.net/manus.im/socket.io/", BASE, ["manus.im"]), false);
});

// 5) 注入順: hostmatch.js は injected.js より前 (namespace attach の前提)
test("T-22.5 content.js injects hostmatch.js before injected.js", () => {
  const src = fs.readFileSync(new URL("../../browser-extension/content.js", import.meta.url), "utf8");
  const iHost = src.indexOf('injectScript("hostmatch.js")');
  const iInj = src.indexOf('injectScript("injected.js")');
  assert.ok(iHost >= 0, "content.js に hostmatch.js の注入がない");
  assert.ok(iInj >= 0 && iHost < iInj, "hostmatch.js が injected.js より後に注入されている");
});

// 6) wired guard: provider 判定の呼び出しは構造照合だけ。substring regex のコピー
//    (beacon と WS の inline) も残さない。adapter の endpoint 照合は pickAdapter の
//    host gate (構造照合) の後ろに置く。
test("T-22.6 injected.js decides provider hosts through the structured predicate", () => {
  const src = fs.readFileSync(new URL("../../browser-extension/injected.js", import.meta.url), "utf8");
  assert.ok(/PiiGuardHostmatch/.test(src), "injected.js が PiiGuardHostmatch を使っていない");
  assert.ok(!src.includes("SUPPORTED_HOST_RE"), "substring regex の定義か test 呼び出しが残っている");
  assert.ok(!src.includes("claude\\.(ai|com)"), "host 判定の inline regex コピーが残っている");
  const hostCalls = (src.match(/HOST\.isProvider(Host|Url)\(/g) || []).length;
  assert.ok(hostCalls >= 6, `構造照合の呼び出しが ${hostCalls}  (fetch log, XHR log, beacon, WS, worker hook, pickAdapter gate で 6 必要がある)`);
});
