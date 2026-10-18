# Secure Composer — 最終レポート

> 対象: PII Guard (feat/secure-composer, baseline `9dce0f2`) / 作成: 2026-10-18
> 検証環境: WSL2 + Chromium (Playwright persistent context, headed) + CDP (全 target auto-attach) + 自己署名モック chatgpt.com + 受信記録サーバ

## 19.1 エグゼクティブ・サマリー

### やったこと
- ChatGPT のネイティブ入力欄に、**拡張オリジンの iframe (Secure Composer)** を重ね、入力中の原文を iframe のメモリにだけ保持する構成を実装。原文はページの DOM・React state・MAIN world・`postMessage`・保存領域・通信のどれにも渡らない。
- 送信操作 (Enter / 送信ボタン) のときだけ、**マスク済み (ON) / 原文 (OFF)** を content script 経由でネイティブ入力欄に書いて正規送信する。マスク失敗時は送信を止め、下書きを残す (fail-closed)。
- iframe ⇄ content script の通信を、ページから偽装できない **SW ペアリング・バス (`chrome.runtime.connect` + sender 検証)** で実装。
- 既存の P0 級の穴 (LLM 設定の露出・偽装 llm-call・機密リストの MAIN world 露出・fail-open) を修正。
- CDP + 受信サーバの二系統で原文漏えいを検査する再現テスト基盤を新設し、baseline で脆弱性を再現 → 修正版で解消を確認。

### セキュリティ上の改善
baseline で再現した 6 脆弱性 (V-01〜V-06) をすべて修正。送信前の原文漏えい (prepare 含む) は CDP・受信サーバの両方で **0**。

### UX 上の改善
ユーザー操作は「入力して Enter / 送信」だけ。マスキング ON/OFF 以外の操作・確認ダイアログ・手動コピーは不要 (spec 3)。IME・Undo/Redo・クリップボード・複数行は textarea の標準機能で動く。見た目はネイティブ入力欄から測った色・フォント・余白・プレースホルダを iframe に反映。

### 最終判定: **CONDITIONAL PASS**
P0 15 項目のうち **14 項目を自動テストで PASS**。残る **P0-14 (初期化失敗を保護中と誤表示しない)** は設計完了＋コードレビュー＋使用時 fail-closed (RT-FC-02) まで確認済みだが、「iframe の初期化失敗そのもの」を注入する end-to-end 自動テストは未実装 (本番コードにテスト用の抜け道を作らない方針のため)。この 1 点が未自動化のため、全面 PASS ではなく CONDITIONAL とする。詳細は 19.6。

---

## 19.2 アーキテクチャ

```
ページ (chatgpt.com, 信頼しない)
  ├─ ネイティブ入力欄 (空のまま。送信操作時だけマスク済み/原文が一瞬入る)
  └─ <iframe src=chrome-extension://…/secure-composer.html>  ← ページは contentDocument に触れない
        └─ textarea (原文はここだけ) + engine (iframe 内でマスク) + state machine
PII Guard content script (ISOLATED world)
  └─ adapters/chatgpt-composer-adapter.js : iframe を採寸して重ね、commit を受けて正規送信
service worker
  └─ Secure Composer ペアリング・バス (iframe ⇄ content を tabId 単位で中継, sender 検証)
```

### データフロー (マスキング ON の送信)
1. ユーザーが iframe の textarea に入力 (原文は iframe のメモリのみ)。
2. Enter → iframe: `SECURE_READY→EDITING→SUBMIT_REQUESTED→MASKING`。
3. iframe 内の engine で `maskSanitize` (除外リスト等は iframe が `chrome.storage` から直接読む → MAIN world に出ない)。失敗なら `MASKING_FAILED` で停止・下書き保持。
4. 裏取り: `leak-detector` で「常に伏せる語」の生値が残っていないか確認。
5. `COMMIT_READY→SUBMITTING` → ペアリング・バス経由で content script に commit。
6. content script がマスク済みをネイティブ入力欄に書き、送信ボタンをクリック (= 正規送信)。
7. `SENT→SECURE_READY`、下書きクリア。失敗時は編集に戻し、原文は自動再送しない。

### 信頼境界と状態機械
`docs/security/threat-model.md` (INV-1〜5) と `secure-composer/composer-state.js` を参照。

---

## 19.3 セキュリティ所見

| ID | 深刻度 | 原因 | 修正 | 修正ファイル | 再現/確認 |
|---|---|---|---|---|---|
| V-01 | Critical | 入力中の原文がページの入力欄にあり、`prepare`・telemetry でサーバへ出る | 原文を拡張 iframe に隔離。ページ入力欄に原文を置かない | `secure-composer/*`, `adapters/chatgpt-composer-adapter.js` | RT-NET-01: baseline leak=14→**0**, nonEmptyPrepare=2→**0** |
| V-02 | High | `request-settings` で `maskAllowlist`/`maskForceList` の実データを MAIN world に配布 | ChatGPT では機密リストを MAIN world に送らない。マスクは iframe が storage を直接読んで実行 | `content.js` (broadcastSettings), `secure-composer.js` | RT-PM-01: baseline で読めた→**読めない** |
| V-03 | High | `llm-config` が LLM の URL/モデルを MAIN world に返す | 返すのは `mode`/`timeoutMs` のみ。URL/モデルは isolated world と SW が保持 | `content.js` (handleLlmConfig) | RT-PM-02: `leakedUrl` true→**false** |
| V-04 | High | ページが `llm-call` の `config` で任意のパス/モデルを指定でき、`/api/pull` 等を叩ける | `handleLlmCall` はページの config を無視し storage から再構築。SW も推論 2 パスに固定許可 | `content.js`, `background.js` (LLM_FETCH) | RT-PM-03: `/api/pull`+攻撃モデル到達→**到達せず** |
| V-05 | Critical | マスク失敗時 `window.confirm`(ページが乗っ取り可) で原文送信 (fail-open) | Secure Composer はマスク失敗で送信停止・下書き保持。iframe 内 engine はページから壊せない | `secure-composer.js` | RT-FC-01: baseline leaked=1→**0** |
| V-06 | Medium | マスキング OFF でも入力中の原文がページ経由で外へ | OFF でも Secure Composer が入力隔離を維持 (OFF は最終送信のマスク無効化のみ) | `secure-composer/*` | RT-NET-03: baseline leak=84→**0** |

### 残存リスク (正直な明示)
- **R-1 (別拡張機能)**: 同等権限の悪意ある拡張は同じタブに content script を注入でき、DOM/キー入力を観測しうる。Chrome の権限モデル上どの拡張でも防げない。本実装はページ JS からの防御が主目的 (threat-model 4 節)。
- **R-2 (他プロバイダの MAIN world 露出)**: V-02 の機密リスト非配布は **ChatGPT のみ**。Claude.ai / Gemini / Manus は従来どおり MAIN world エンジンが使うため露出が残る。Secure Composer を他プロバイダへ展開するのが恒久対策 (フォローアップ)。
- **R-3 (実サイトの送信ボタン/`conduit_token`)**: 送信ボタン属性・停止ボタン・`conduit_token` 必須性はモックの仮定。実サイト (ログイン後) は自動で開けず未検証。`docs/security/network-baseline.md` 4 節。

---

## 19.4 テスト結果

| 層 | 本数 | 結果 | 備考 |
|---|---|---|---|
| 単体 (engine/store) | 64 | PASS | 既存マスキングの退行なし (P0-12) |
| 単体 (state machine) | 6 | PASS | `composer-state.test.mjs` |
| 単体 (leak-detector) | 8 | PASS | `leak-detector.test.mjs`、変換形の検出 |
| ベクタ | 全 | PASS | `validate_vectors.js` |
| prepush 自己検査 | 49 | PASS | |
| E2E/レッドチーム (Secure Composer) | 16 | PASS | 下記 |
| E2E (composer-toggle, レガシー) | 45+ | PASS | SC 無効で従来 UX を検証 (P0-12) |
| E2E (send-path, レガシー) | 16 | PASS | fetch フック経路の退行なし (P0-12) |

### レッドチーム/E2E 16 本 (修正版、teardown 後プロセス残 0)
RT-NET-01〜04, RT-DOM-01, RT-PM-01〜05, RT-FC-01〜03, SF-01〜04 — すべて PASS。
baseline (`9dce0f2`) では RT-FC-01, RT-PM-01/02/03, RT-NET-01/03/04 が FAIL (= 脆弱性を再現)。

---

## 19.5 ネットワーク証拠 (CDP + 受信サーバ)

- **送信前 (マスキング ON, RT-NET-01)**: CDP で全 target を監視し、入力中に発行された通信を記録。カナリア・既知 PII の混入 = CDP **0** / 受信サーバ **0** / WebSocket **0**。`prepare` の原文入り = **0**。ネイティブ入力欄 = 空。
- **送信前 (マスキング OFF, RT-NET-03)**: 同上 0。
- **送信後 (マスキング ON, SF-01)**: `conversation` は 1 本、本文はプレースホルダ (`<PHONE_NUMBER_1>` 等) を含み、生の電話/メール/住所は **0**。非 PII のカナリアは通過 (本文到達の証拠)。
- **送信後 (マスキング OFF, SF-02)**: 送信操作後に限り原文が 1 本届く。
- **整合性 (P0-15, RT-NET-04)**: CDP の発行試行・ブラウザ遮断・受信サーバ到達を区別して突き合わせ、矛盾 = **0**。
- 証拠 JSON は実行時 `PII_E2E_EVIDENCE=<dir>` に出力 (値は伏せ、ヒットは番号と変換形のみ記録)。

---

## 19.6 P0 判定表

| ID | 内容 | 判定 | 根拠 |
|---|---|---|---|
| P0-01 | 未送信原文が ChatGPT に到達しない | PASS | RT-NET-01 |
| P0-02 | 原文入り prepare がサーバに到達しない | PASS | RT-NET-01 |
| P0-03 | 正規 Composer に未送信原文が残らない | PASS | RT-NET-01 / SF-01 (native 空) |
| P0-04 | ページ JS から iframe の原文を取れない | PASS | RT-DOM-01 (SecurityError) |
| P0-05 | ページ JS から機密設定を取れない | PASS | RT-PM-01 / RT-PM-02 |
| P0-06 | postMessage 偽装で設定変更できない | PASS | RT-PM-03 / RT-PM-04 / RT-PM-05 |
| P0-07 | マスク失敗で原文送信にフォールバックしない | PASS | RT-FC-02 |
| P0-08 | マスキング ON で正常送信できる | PASS | SF-01 |
| P0-09 | マスキング OFF でも送信前は隔離 | PASS | RT-NET-03 (前) / SF-02 (送信時) |
| P0-10 | 障害時に原文を自動再送しない | PASS | RT-FC-03 |
| P0-11 | タブ間で状態が混線しない | PASS | SF-04 |
| P0-12 | 既存マスキング機能が退行しない | PASS | engine/store 64 + composer-toggle + send-path e2e |
| P0-13 | 原文がログ/保存に残らない | PASS(レビュー) | iframe は storage を読むだけ・原文を書かない。adapter/secure-composer は原文をログ出力しない。RT-PM-01 が web storage も走査し検出 0 |
| P0-14 | 初期化失敗を保護中と誤表示しない | **CONDITIONAL** | BLOCKED 状態 + adapter の overlay 撤去を実装・コードレビュー済、使用時 fail-closed は RT-FC-02 で確認。初期化失敗注入の e2e は未自動化 |
| P0-15 | CDP と受信記録が矛盾しない | PASS | RT-NET-04 |

**結論**: P0 の 14/15 が自動 PASS、P0-14 は設計完了だが初期化失敗の end-to-end 自動化が未了。よって **CONDITIONAL PASS**。残作業は 19.7。

---

## 19.7 残作業 (リリース前に閉じるべき)
1. **P0-14 の自動化**: iframe の engine 初期化失敗を注入する手段 (本番に抜け道を作らず、テスト専用ビルド or CDP で engine スクリプトを差し替え) を用意し、BLOCKED → overlay 撤去 → ネイティブが「保護中」と誤表示されないことを e2e 化。
2. **R-2**: Secure Composer を Claude.ai / Gemini / Manus へ展開し、全プロバイダで MAIN world から機密を排除。
3. **R-3**: 実サイト (ログイン後) で送信ボタン属性・`conduit_token` 必須性・`prepare` 挙動を確認し、アダプタのセレクタを実測で裏取り。
4. **composer-toggle 統合**: OFF 時の警告 UX を iframe 側に移設 (現状は SC 有効ホストで警告をオフにして衝突回避)。
5. **CI**: P0 (レッドチーム/E2E) を必須ゲートに (`xvfb-run` でヘッドレス表示を用意)。

関連: [[secure-composer-baseline]] [[threat-model]] [[network-baseline]]
