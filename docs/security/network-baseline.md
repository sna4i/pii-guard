# Secure Composer — ネットワーク・ベースライン (Phase 1)

> 2026-10-18 / 観測: CDP (発行試行) + モック受信サーバ (実到達) の二系統

## 1. prepare の実通信 (利用者観測 + モック再現)
利用者が実環境で観測した、入力中 (送信前) の通信:
```
POST /backend-api/f/conversation/prepare
{ "client_prepare_state":"sent", "action":"next", "model":"gpt-6-thinking",
  "partial_query":{"author":{"role":"user"},"content":{"content_type":"text","parts":["入力中のテキスト"]}},
  "client_prepare_dispatch":"debounced", "client_prepare_source":"composer_editor_state" }
→ { "status":"ok", "conduit_token":"..." }
```
モック (`tests/fixtures/mock-chatgpt/`) は、入力の debounce (350ms) でこの prepare を発行し、`conduit_token` を返し、送信時 `POST /backend-api/f/conversation` にそのトークンを `x-conduit-token` で付ける構造で再現した。`prepare`/`conversation` の URL は実物に合わせ (`/backend-api/(f/)conversation(/prepare)?`)、content script と DNR が実 URL に対して動く。

## 2. 対象にする送信経路 (URL だけに依存しない)
`injected.js` が既にフックしている: `fetch` / `XMLHttpRequest` / `navigator.sendBeacon` / `WebSocket`。Secure Composer では**原文がページ側に存在しない**ことを主防御にするので、経路の網羅は多層防御の二層目。prepare の遮断は DNR をあわせて使う (network-guard)。

対象 URL (既知、ただしこれだけに依存しない):
```
/backend-api/f/conversation/prepare
/backend-api/conversation/prepare
```

## 3. baseline 観測結果 (2026-10-18)
`tests/redteam/pre-submit-leak.test.mjs` を baseline (`9dce0f2`) に対して実行:

| シナリオ | prepare(原文入り) | 漏えいチャネル | 判定 |
|---|---|---|---|
| マスキング ON | 2 | prepare 本文 + ページ telemetry (beacon `/ces/v1/t`, XHR Blob `/ces/v1/x`, GET クエリ `/ces/v1/r`, Worker, WS) | **FAIL (V-01)** |
| マスキング OFF | 5 | 同上 (leak=84) | **FAIL (V-06)** |

CDP では `/ces/*` の一部が `net::ERR_ABORTED` (keepalive beacon の CDP 上の扱い) になり、受信サーバには到達。**発行試行・ブラウザ遮断・実到達を別々に記録**し、受信サーバの記録を原文到達の最終判定に使う (spec 12.6)。

## 4. conduit_token の扱い (Phase 4 で詰める)
- モックでは `conversation` に `conduit_token` を任意付与で再現。実サイトでの必須性は未確認。
- 方針: prepare を常時遮断して送信を壊すのではなく、**原文をページに置かない**ことで「原文入り prepare」をそもそも発生させない。送信確定後に、マスキング済みテキストだけで必要なら prepare を 1 回だけ通す。送信時点でページ側に原文が無いことを検証する (P0-02 + consistency)。

## 5. 二系統の証拠取得
- **ブラウザ側**: `tests/fixtures/cdp-recorder.mjs` が `Target.setAutoAttach` ですべての target (ページ/iframe/Worker/SW) に `Network.enable`。`requestWillBeSent`/`ExtraInfo`/`getRequestPostData`/`loadingFailed(blockedReason)`/`webSocketFrameSent` を記録。
- **受信側**: `tests/fixtures/mock-chatgpt/server.mjs` が実到達した本文・ヘッダー・WS フレームを記録。
- **突き合わせ**: `harness.consistency()` が「CDP 成功だがサーバ未着」「サーバ着だが CDP に成功記録なし」を検出 (P0-15)。カナリア検査は `security/leak-detector.js` が raw/NFC/NFKC/全角/JSON/`\u`/URL/Base64 の変換形を見る (spec 12.2)。

関連: [[secure-composer-baseline]] [[threat-model]]
