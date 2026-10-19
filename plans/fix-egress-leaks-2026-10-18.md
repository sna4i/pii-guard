# 漏れの全面対応 (Claude / Gemini / Manus の送信・送信前・添付)

> 2026-10-18 / ブランチ: feat/secure-composer / 起点: 利用者「漏れがあるならすべて対応して」

## 1. 実測で分かった漏れ (空送信: `tests/integration/dryrun-send.mjs`)

空送信は、ページの fetch / XHR / sendBeacon / WebSocket を拡張のフックより下で止め、CDP の Fetch でも止めて行った (何も外に出ていない)。

| ID | サイト | 経路 | 状態 |
|---|---|---|---|
| LK-01 | Claude | 送信が protobuf の RPC `claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction` (fetch、本文は Uint8Array)。下書きは root.2.3 | **マスクされない** (拡張は JSON 本文しか見ない) |
| LK-02 | Gemini | 送信が WebChannel `geminiweb-pa.clients6.google.com/v1/processSession` (XHR、フォーム `reqN___data__` = Base64 の protobuf)。下書きは root.2.9.1 | **マスクされない** (宛先もアダプタの対象外) |
| LK-03 | Manus | 下書きの入った入力欄をクリックすると Amplitude の自動計測が要素の文字を送る (fetch と sendBeacon) | **送信前に漏れる** |
| LK-04 | Claude/Gemini/Manus | 添付 (ファイル選択・ドラッグ&ドロップ・貼り付け) の中身 | **マスクされない** (添付ガードは ChatGPT だけ) |
| LK-05 | 全サイト | 添付のファイル名 | **マスクされない** |
| LK-06 | 全サイト | 数字を 1 桁ずつ空白で区切った電話番号・カード番号など | **検出をすり抜ける** (既知の限界) |
| LK-04b | Gemini | ファイルを選んだ瞬間に名前と中身が `push.clients6.google.com/upload/` へ (2026-10-18 追加で実測) | **マスクされない** |
| LK-04c | Manus | ファイルを選んだ瞬間に中身が `GenerateDocumentSuggestion` へ、名前が Amplitude へ (同上) | **マスクされない** |
| LK-04d | Claude | 添付の中身と名前が送信の本文 root.2.15 に入る (同上) | **マスクされない** |
| LK-10 | Claude/Gemini/Manus | 除外リスト・常に伏せる語の値が MAIN world に配られ、ページの JS から読める (既知の V-02) | **露出** |
| (確認済) | Manus | 送信 (socket.io の `user_message`) | マスクされている |

根本の問題: サイトが通信の形を変えると、拡張のマスクが**黙って素通し (fail-open)** になる。LK-01/02 はまさにこれ。

## 2. 要件

| ID | 要件 |
|---|---|
| F-EG-01 | Claude の PerformAction (protobuf) の送信をマスクする。確認画面 (サイドバー) も従来どおり使える |
| F-EG-02 | Gemini の processSession (WebChannel + protobuf) の送信をマスクする。確認画面も使える |
| F-EG-03 | **安全網**: 利用者が打った・貼った文字から検出した個人情報が、マスクされないまま通信 (どの宛先・どの経路でも) に入っていたら、文字の本文なら伏せ字に置き換え、置き換えられない形 (バイナリ等) なら止める。送信アダプタが処理した通信 (利用者が確認画面で選んだ結果) は対象外 |
| F-EG-04 | 外部 (サイト自身以外) の宛先への通信に、下書きの一部 (20 文字以上の連続) が入っていたら止める (個人情報として検出できない名前や機密も、解析ツールに出さない) |
| F-EG-05 | 添付の中身を Claude/Gemini/Manus でもマスクする (テキストはマスクして差し替え、マスクできないものはマスキング ON なら止める。ChatGPT と同じ方針) |
| F-EG-06 | 添付のファイル名に含まれる個人情報もマスクする (全サイト) |
| F-EG-07 | 数字を空白で 1 桁ずつ区切った電話番号・カード番号・マイナンバーも検出する (過検出を増やさない) |
| F-EG-08 | 除外リスト・常に伏せる語を、全サイトで MAIN world に配らない。ページのマスクは ISOLATED world のエンジンに頼む (V-02) |

非機能: サイトが形を変えたときは素通しではなく止める側に倒す (F-EG-03 が受け止める)。マスキング OFF のときは何もしない。性能: 通信 1 件あたりの検査は本文 2MB まで、それ以上は添付ガードの領分。

## 3. 設計

- `browser-extension/security/egress-guard.js` (新規、MAIN world とテスト (Node) の両方で読める純粋関数):
  - protobuf をスキーマなしで分解し、文字列フィールドの集め・置き換え・再組み立てをする (長さの入れ子も正しく直す)。
  - WebChannel のフォーム (`count` / `ofs` / `reqN___data__`) の分解と組み立て。
  - 検出済みの値の集合と、その変換形 (生・NFKC・全角・JSON エスケープ・URL エンコード・Base64) の検索と置き換え。
  - 通信 1 件の判定 `decide()`: 通す / 伏せ字にして通す / 止める。
- `injected.js`:
  - 下書きの見張り: ページ上の入力欄 (textarea・contenteditable 等) の入力・貼り付け・ドロップの文字をエンジンで検出し、値を覚える (一定時間)。
  - 送信アダプタ: Claude の PerformAction、Gemini の processSession を protobuf の上で extract/replace し、既存の `processBody` (確認画面を含む) に載せる。
  - fetch / XHR / sendBeacon / WebSocket の全フックで、アダプタが処理しなかった通信に `decide()` を掛ける。
- 添付 (`attachments/attachment-guard.js`) を Claude/Gemini/Manus にも広げ、ファイル名もマスクする。
- エンジン: 空白区切りの数字列を、検証つき (電話の形・Luhn・マイナンバーの検査数字) でだけ拾う。

## 4. テスト

| ID | 内容 |
|---|---|
| T-EG-01 | protobuf の分解→置き換え→再組み立てで、入れ子の長さが正しく直り、触っていないフィールドはバイト単位で同じ |
| T-EG-02 | WebChannel のフォームを分解→組み立てて元に戻る。中の protobuf の文字列を置き換えられる |
| T-EG-03 | `decide()`: 生/URL/JSON の形は伏せ字に置き換え、Base64 やバイナリは止める。外部宛ての下書きの一部は止める。サイト自身宛てで個人情報が無ければ通す |
| T-EG-04 | 実サイトの空送信: Claude・Gemini の送信本文がマスク済み。Manus の Amplitude が止まる。何も外に出ない |
| T-EG-05 | 添付の空送信: 中身とファイル名がマスク済み、画像は止まる |
| T-EG-06 | eval: 空白区切りの数字列が検出され、過検出 0 のまま |
| T-EG-07 | e2e: ファイル名の伏せ字 (AT-05)、ファイルの貼り付け (PASTE-01〜03) |
| T-EG-08 | レッドチーム: リストの値が MAIN world に出ない (RT-V02-01)、それでも常に伏せる語は伏せる (RT-V02-02) |

## 5. 結果 (2026-10-18)

| ID | 状態 | 確認 |
|---|---|---|
| F-EG-01 | ✅ | 空送信: Claude の PerformAction が伏せ字で出る (添付・貼り付け込み) |
| F-EG-02 | ✅ | 空送信: Gemini の processSession が伏せ字で出る |
| F-EG-03 | ✅ | 単体 T-EG-01〜04、空送信: Manus の Amplitude を止める。記憶は読み直しをまたいで残る (実測) |
| F-EG-04 | ✅ | 単体 T-EG-03c、空送信: Manus の Amplitude (下書きの一部) を止める |
| F-EG-05 | ✅ | 空送信: 3 サイトでファイル選択・ドロップ・貼り付けの中身が伏せ字。e2e AT/DND/PASTE |
| F-EG-06 | ✅ | e2e AT-05、空送信: Claude の本文・Manus のアップロード先 URL のファイル名が伏せ字 |
| F-EG-07 | ✅ | eval spaced 15/15、否定 6 件で過検出 0 |
| F-EG-08 | ✅ | RT-V02-01 (変更前のコードでは落ちる)、RT-V02-02 |

残る限界は `docs/security/other-providers-status.md` の 4 章 (問い合わせによる推測、検出できない値、バイナリは止める、OS からの本物のドラッグは手で確認)。
