# Secure Composer (ChatGPT 送信前の原文隔離) 要件・設計・検証

> ステータス: 🟡 CONDITIONAL PASS (P0 14/15 自動合格、P0-14 のみ未自動化)
> ブランチ: `feat/secure-composer` (別 worktree で作業) / baseline `9dce0f2`
> 作成: 2026-10-18 / 詳細: `docs/security/secure-composer-{baseline,threat-model,network-baseline,final-report}.md`

## 背景
ChatGPT は入力中に `POST /backend-api/f/conversation/prepare` で未送信の原文を送る。送信操作前に原文がサーバへ渡らないことをブラウザ側で保証する。

## 機能 (F)
| ID | 内容 | 状態 |
|---|---|---|
| F-SC-01 | 拡張オリジンの iframe を ChatGPT 入力欄に重ね、原文を iframe のメモリにだけ保持 | ✅ |
| F-SC-02 | 送信操作時のみ、マスク済み(ON)/原文(OFF) を正規送信へ引き渡し | ✅ |
| F-SC-03 | マスク失敗は送信停止・下書き保持 (fail-closed) | ✅ |
| F-SC-04 | iframe⇄content を SW ペアリング・バスで接続 (sender 検証、ページ偽装不可) | ✅ |
| F-SC-05 | 機密 (除外/常に伏せる語/LLM 設定) を MAIN world に出さない | ✅ (ChatGPT)。他プロバイダは残課題 |
| F-SC-06 | 状態機械 (INITIALIZING…SENT / BLOCKED) | ✅ |
| F-SEC-01 | llm-call の偽装・LLM 設定露出・LLM パスの修正 | ✅ |

## 主要ファイル
- `browser-extension/secure-composer/{secure-composer.html,.css,.js,composer-state.js,privacy-boundary.js}`
- `browser-extension/adapters/chatgpt-composer-adapter.js`
- `browser-extension/security/leak-detector.js`
- `browser-extension/{background,content,injected,composer-toggle}.js` (修正)
- テスト基盤: `tests/fixtures/{harness,cdp-recorder,mock-chatgpt/*}.mjs`
- テスト: `tests/redteam/*.test.mjs`, `tests/e2e/submit-flow.test.mjs`, `tests/engine/{composer-state,leak-detector}.test.mjs`

## テスト観点 (T) と結果
| ID | 観点 | 結果 |
|---|---|---|
| T-SC 送信前漏えい | CDP+受信サーバでカナリア/PII 混入を検査 | RT-NET-01/03 PASS (baseline FAIL を再現→解消) |
| T-SC DOM 隔離 | ページから iframe 原文を読めない | RT-DOM-01 PASS |
| T-SEC postMessage/LLM | 設定露出・偽装・設定変更 | RT-PM-01〜05 PASS |
| T-SC fail-closed | マスク失敗/障害で原文を出さない | RT-FC-01〜03 PASS |
| T-SC 送信 | ON マスク送信 / OFF 原文送信 / 二重送信 / タブ分離 | SF-01〜04 PASS |
| T-REG 退行 | engine/store 64・composer-toggle・send-path e2e | PASS |

## 残課題 (リリース前)
1. P0-14 (初期化失敗を保護中と誤表示しない) の e2e 自動化。
2. Secure Composer を Claude.ai/Gemini/Manus へ展開 (他プロバイダの MAIN world 機密露出を解消)。
3. 実サイト(ログイン後)で送信ボタン属性・`conduit_token`・`prepare` を実測し、アダプタのセレクタを裏取り。
4. composer-toggle の OFF 警告 UX を iframe 側へ移設。→ 1.7.1 で対応 (`docs/release-1.7.1.md` の F-SC-16、D-SC-04)。
5. CI: P0 レッドチーム/E2E を必須ゲート化 (`xvfb-run`)。

## 実行方法
```
cd tests/integration && npm install   # playwright (chromium は既存)
PII_GUARD_EXT=<unpacked> PII_E2E_EVIDENCE=<dir> \
  node --test --test-concurrency=1 tests/redteam/*.test.mjs tests/e2e/*.test.mjs
# baseline 再現: PII_GUARD_EXT=<9dce0f2 の展開先>
```
