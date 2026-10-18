# Secure Composer — ベースライン調査 (Phase 1)

> 対象コミット: `9dce0f2` (feat/composer-toggle) / 調査日: 2026-10-18
> 実行環境: WSL2 + Chromium (Playwright persistent context, headed) + CDP + 自己署名のモック chatgpt.com

既存の PII Guard がどう入力をマスクし、どこに原文・機密設定が流れているかを実コードと再現テストで確かめた。「実際に成立する脆弱性」と「未検証の懸念」を分けて記録する。

## 1. 既存アーキテクチャ (実コードで確認)

| 層 | 役割 | ファイル |
|---|---|---|
| ISOLATED world (content script) | ページ⇄拡張のブリッジ。`chrome.storage` 読み書き、gateway/LLM の proxy、設定の配布 | `content.js` |
| MAIN world (injected) | 実ページの `fetch`/`XHR`/`sendBeacon`/`WebSocket` をフック。送信本文をマスク | `injected.js` |
| MAIN world engine | 正規表現+辞書+機密文の検出・集約・置換 | `engine/*.js` |
| ISOLATED world UI | オン/オフのアイコン、オフ時の警告、背景の色づけ。`enabled` を直接 `chrome.storage` に書く (ページから触れない Shadow DOM) | `composer-toggle.js` |
| Service worker | バッジ、LLM_FETCH proxy (host-lock)、ML 推論の offscreen 中継 | `background.js` |
| Offscreen | transformers.js (ONNX) の NER | `offscreen.js` |

### マスキングの呼び出し経路
1. ページが `POST /backend-api/(f/)conversation` を発行 → `injected.js` の `window.fetch` フックが横取り。
2. `pickAdapter(url)` → `chatgptAdapter.extractInputs(body)` が `messages[].author.role==="user"` の `content.parts` を取り出す。
3. `sanitizeAggregated`/`sanitizeOnce` → standalone は MAIN world の `engine.maskAggregated/maskSanitize`、gateway は content script 経由。
4. サイドバー承認 → `adapter.replaceInputs` でマスク済み本文に差し替えて送信。

### Fail-Open / Fail-Closed の現状
- `sendBeacon`: プロバイダ宛ては **fail-closed** で遮断済み (`injected.js:1531`)。
- `fetch`/`XHR`: マスク失敗 (`result===null`) 時に `confirmSendUnmasked()` = `window.confirm`。**ユーザーが拒否しない限り原文送信** (fail-open)。`window.confirm` はページが乗っ取れる (下記 V-03)。
- engine 不在時 `sanitizeOnce` は `null` を返し、同じ confirm 経路に落ちる。

### Web Store 版との差
`manifest.store.json` は `http://*/*` を `optional_host_permissions` に移し、LLM_FETCH ハンドラは Store ビルドで無効 (`background.js:152` のコメント)。HF ホストは dev のみ。

## 2. 成立する脆弱性 (再現済み)

テストは `tests/redteam/*.test.mjs`、ハーネスは `tests/fixtures/`。CDP(発行試行) と モック受信サーバ(実到達) の二系統で確認。

| ID | 深刻度 | 内容 | 再現 (baseline) |
|---|---|---|---|
| **V-01** | Critical | 送信前の原文が prepare 等に乗りサーバへ到達。ページ入力欄に原文が存在する構造のため、Secure Composer 不在では防げない | `RT-NET-01` FAIL: `nonEmptyPrepare=2`, leak channels = prepare 本文 + ページ telemetry (beacon/XHR/Blob/Worker/WS) |
| **V-02** | High | `request-settings` を**ページから**送ると content script が `maskAllowlist`/`maskForceList` 実データを `postMessage(..., "*")` で配布 → ページが読める | `RT-PM-01` FAIL: forcelist/allowlist が `postMessage` と `window.__localMaskMCP.settings` の両方で読めた |
| **V-03** | High | `llm-config` をページから送ると LLM の URL/model を含む設定が返る | `RT-PM-02` FAIL: `leakedUrl=true` |
| **V-04** | High | `llm-call` の `config` をページが指定できる → SW の host-lock はすり抜けないが、**パスとモデルは任意**。`/api/pull` 等を叩ける | `RT-PM-03` FAIL: `/api/pull?x=/api/chat` に `attacker/huge-model` が到達 |
| **V-05** | Critical | マスク失敗時 `window.confirm` をページが `()=>true` に上書き + engine を破壊 → 原文がそのまま `conversation` に乗る (fail-open) | `RT-FC-01` FAIL: `leakedConversations=1` |
| **V-06** | Medium | マスキング OFF でも、入力中の原文がページ JS 経由で外へ出る (OFF は最終送信のマスクを切るだけで、入力隔離は無い) | `RT-NET-03` FAIL: `leak=84` |

### すでに塞がれている点 (回帰防止として維持)
- `RT-PM-04` PASS: ページからの `add-allowlist`/`set-enabled`/`settings` 偽装では設定が変わらない。保存は `composer-toggle.js` の閉じた Shadow DOM UI が `isTrusted` クリックで確定する (1.6.0)。
- `RT-PM-05`/`RT-FC-02`/`RT-FC-03` は Secure Composer 前提なので baseline では SKIP。

## 3. 未検証の懸念 (推測せず、実験で詰める)
- `conduit_token` が `conversation` 送信に必須か。モックでは任意ヘッダーとして再現したが、実サイトの必須性は未確認 (Phase 4/12.3)。
- 実サイト(ログイン後)の送信ボタン・停止ボタンの属性は未取得 (自動操作で開けない。モックは利用者が貼った HTML を使用)。
- 別拡張機能からの iframe 干渉・DOM 改変は脅威モデルに含むが、Chrome の制約上「完全防止」は主張しない (threat-model.md)。

## 4. 実サイトで確かめた事実 (2026-10-18)
ログインなし `https://chatgpt.com/` を自動操作で開き、**何も送信せず**入力中のみ観測:
- 入力欄は `textarea#mobile-composer-prompt`、送信は `button[data-composer-submit]`、段は CSS Grid。
- 入力中に `prepare` は観測されず (ログインなしの作り)。POST は sentinel/telemetry のみ、カナリアの混入なし。
- → `prepare` 問題はログイン後の作りに固有。モックはログイン後 (利用者が貼った実 HTML) で再現する。

関連: [[threat-model]] [[network-baseline]]
