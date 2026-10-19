# Secure Composer — 脅威モデル (Phase 1)

> 2026-10-18 / 対象: PII Guard Secure Composer

## 1. 守りたいもの (資産)
- **A1 入力中の原文**: ユーザーが打ち込み中で、まだ送信操作をしていないテキスト。
- **A2 機密設定**: 除外リスト (`maskAllowlist`)、常に伏せる語 (`maskForceList`)、ローカル LLM の URL/モデル。
- **A3 マスキングの完全性**: マスキング ON のとき、送信本文に原文の個人情報が残らないこと。

## 2. 攻撃者 (spec 11)
- **T-PAGE**: chatgpt.com のページ内 JavaScript。DOM・`window`・`postMessage`・`fetch`/`XHR`/`WS`/`Worker` を自由に使える。悪意あるサイト更新や XSS を含む。
- **T-EXT**: 同居する別の悪意ある拡張機能。
- **T-NET**: 異常なネットワーク (API 変更、リトライ、切断、複数同時送信)。
- **T-USER-MISTAKE**: マスキングを回避する入力 (Unicode 混在・分割・エンコード)。意図的回避そのものは「ユーザーの自由」だが、取りこぼしは精度指標で測る。

## 3. 信頼境界
```
     ページ MAIN world (T-PAGE: 信頼しない)
   ─────────────┼──────────────  postMessage は検疫ゾーン
     ISOLATED world content script (拡張、信頼する)
   ─────────────┼──────────────  chrome.runtime (sender 検証)
     Service worker / Offscreen (拡張、信頼する)
   ─────────────┼──────────────
     拡張オリジンの iframe = Secure Composer (原文を保持してよい唯一の DOM)
```
- 原文を保持してよいのは: Secure Composer iframe の最小限のメモリ、明示的に許可したローカル PII/LLM 処理のみ。
- 原文を**渡してはいけない**: ページの Composer/React state/JS、MAIN world のグローバル、`postMessage`、HTML/`data-*` 属性、`localStorage`/`sessionStorage`/IndexedDB、URL、ログ、外部 API、解析/テレメトリ。

## 4. 保証範囲と、保証しないこと (正直に)
### 保証する (P0 で検証)
- マスキング ON/OFF いずれでも、送信操作前に原文がネットワークへ出ない。
- ページ JS から Secure Composer の原文・機密設定を読めない (iframe は拡張オリジン = ページから `contentDocument` 不可、`postMessage` は同一オリジン＋nonce で検証)。
- マスク失敗時は送信を止める (fail-closed)。ON の送信本文は必ずマスク済み。

### 保証しない (Chrome 拡張の限界として明示)
- **別拡張機能 (T-EXT)**: 同等以上の権限を持つ悪意ある拡張は、同じタブに content script を注入でき、DOM やキー入力を観測しうる。これは Chrome の権限モデル上どの拡張でも防げない。本実装は「ページ JS」からの防御を主目的とし、別拡張は脅威として明記するに留める。
- **OS/ブラウザ本体の侵害**、スクリーンショット系マルウェア、物理アクセス。
- **ユーザー自身が OFF でマスクを無効化して意図的に原文を送る操作** (入力隔離は維持するが、本人の送信は妨げない)。
- **プロバイダのサーバ内部の扱い** (保存/学習)。ブラウザから出る前に原文を出さないことだけを保証する。

## 5. 不変条件 (実装で絶対に崩さない)
- **INV-1**: ページ側 Composer と React state に原文を書き込まない (マスキング済み本文を送信直前にだけ引き渡す)。
- **INV-2**: マスキング失敗 → 送信停止・下書き保持。原文フォールバック送信は無い。
- **INV-3**: 権限付き操作 (設定変更・LLM 呼び出し・送信確定) は `isTrusted` な拡張 UI 操作か、sender 検証済み `chrome.runtime` 経由のみ。`postMessage` では発火しない。
- **INV-4**: 機密設定は MAIN world へ配布しない。MAIN world へ渡すのは非機密の表示用フラグのみ。
- **INV-5**: 保護機構の初期化に失敗したら「保護中」を表示しない。安全を保証できない状態は BLOCKED として扱う。

関連: [[secure-composer-baseline]] [[network-baseline]]
