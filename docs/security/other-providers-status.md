# ChatGPT 以外 (Claude / Gemini / Manus) の保護状況

> 2026-10-18 / 対象: feat/secure-composer / 確認スクリプト: `tests/integration/verify-other-sites.mjs`

## 1. 確認方法

- ChatGPT の実環境確認と同じブラウザ (拡張を読み込み、CDP で接続) で、各サイトを新しいタブで開いた。
- **送信はしていない。** 入力欄があるサイトでは、架空の個人情報 (電話・メール) とカナリアを 1 行打った。
- 打った後 8 秒間、CDP で全リクエスト (URL と本文) と WebSocket の送信フレームを見て、打った値が出ていないかを調べた。最後に下書きを消した。
- ログインが要るサイトは、ログイン画面のタブを開いたまま残してある。

## 2. 結果 (実測)

| サイト | ログイン | 拡張の読み込み | 入力欄とピル | 送信前の原文漏れ |
|---|---|---|---|---|
| Claude (claude.ai) | 未ログイン。ログイン画面に移る | ✅ エンジン起動。拡張のエラーなし | 要ログイン | **未確認 (要ログイン)** |
| Gemini (gemini.google.com) | ログインなしで使える | ✅ fetch/XHR/beacon/WebSocket のフックが入る | ✅ ピルが入力欄に付く | ✅ **漏れなし** (2 回確認) |
| Manus (manus.im) | 未ログイン。ログイン画面に移る | ✅ 既存のフックがテレメトリの beacon を止めている | 要ログイン | **未確認 (要ログイン)** |

- Gemini で入力中に出た POST は 3 種類だけだった。`geminiweb-pa.clients6.google.com/v1/processSession`、`play.google.com/log`、`www.google-analytics.com/g/collect`。どれの本文にも打った値は無い。本文を CDP で読めなかった POST は 0 件。
- 3 サイトとも、ChatGPT 専用の部品 (Secure Composer の iframe、添付ガード) は動いていない。ホスト名で止めているとおり。

## 3. ChatGPT との差 (コード上)

| 保護 | ChatGPT | Claude / Gemini / Manus |
|---|---|---|
| 送信本文のマスク | Secure Composer が送信時にマスク | `injected.js` (MAIN world) が送信リクエストを横取りしてマスク |
| 入力中の原文の隔離 | ✅ 拡張オリジンの iframe に閉じる | ✗ 原文はページの入力欄にあり、ページの JS から読める |
| 除外リスト等を MAIN world に出さない (V-02) | ✅ | ✗ 従来どおり MAIN world に配る |
| 添付 (ファイル選択) のマスク | ✅ `attachment-guard.js` (F-SC-07) | ✗ ガードは ChatGPT のホストだけ |
| ドラッグ&ドロップのマスク | ✅ F-SC-13 | ✗ |

- Gemini は「アップロードとツール」ボタンとドロップ領域を持つ。file input は押したときに作る方式で、開いた直後のページには無い。
- Manus のアダプタは `/upload` や `/files` を明示的に対象外にしている。Claude と Gemini のアダプタも、アップロードの宛先には当たらない。

## 4. 次の一手 (提案)

1. **Claude と Manus は、ログインしてから確認スクリプトを再実行する。** 開いてあるタブでログインし、次を実行する。
   ```
   node tests/integration/verify-other-sites.mjs claude
   node tests/integration/verify-other-sites.mjs manus
   ```
2. **添付・D&D のマスクを他サイトへ広げる。** ファイル選択は、同じ input に投げ直すだけなので汎用化しやすい。D&D は「マスク済みをどの input に渡すか」がサイトごとに違う。Gemini は押したときに input を作るので、サイトごとの調査が要る。
3. **Secure Composer の他サイト展開**は、各サイトの入力欄と送信ボタンの DOM 調査が前提 (ChatGPT と同じく、ログイン後の実物で確かめる)。

関連: [[attachment-and-retry-findings]] [[secure-composer-final-report]] [[threat-model]]
