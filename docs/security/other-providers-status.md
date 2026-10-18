# ChatGPT 以外 (Claude / Gemini / Manus) の保護状況

> 2026-10-18 / 対象: feat/secure-composer / 確認スクリプト: `tests/integration/verify-other-sites.mjs` (`--wait-login=<秒>` でログインを待ってから確認する)

## 1. 確認方法

- ChatGPT の実環境確認と同じブラウザ (拡張を読み込み、CDP で接続) で確認した。Claude と Manus は利用者がログインした後に確認した (2026-10-18 20:30 ごろ)。
- **送信はしていない。** 入力欄に架空の個人情報 (電話・メール) とカナリアを 1 行打った。その後、次の操作ごとに数秒ずつ通信を見て、最後に下書きを消した。
  1. 打ち終わり
  2. フォーカスを外したあと
  3. 下書きの入った入力欄をクリックしたあと
- 見た通信は、全タブ・iframe・Worker・Service Worker のリクエスト (URL・ヘッダー・本文) と WebSocket の送信フレーム。打った値は、変換形 (全角・URL エンコード・JSON エスケープ・Base64) も含めて探した。
- 怪しい通信は、本文を生のバイト列で取り直した。protobuf は入れ子まで分解し、圧縮 (gzip/zlib)・UTF-16・Base64 の中も見た。

## 2. 結果 (実測)

| サイト | 拡張の動作 | 送信前の原文漏れ |
|---|---|---|
| Claude (claude.ai、ログイン後) | ✅ ピルが付く。送信フックが入る。Secure Composer は動かない | ✅ **漏れなし** |
| Gemini (gemini.google.com、ログインなしで利用可) | ✅ 同上 | ✅ **漏れなし** (3 回確認) |
| Manus (manus.im、ログイン後) | ✅ 同上 | ❌ **漏れあり: 下書きが Amplitude に出る** (2.1) |

- **Claude:** 打ち始めに `claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction` が 1 回出る。中身は protobuf (約 10KB、圧縮なし) で、入れ子まで分解すると機能フラグのような設定キーが約 190 個入っていた。原文はどの形でも入っていない。計測 (`claude.ai/api/event_logging/v2/batch`) にも入っていない。
- **Gemini:** 入力中に出た POST は `processSession`、`play.google.com/log`、`google-analytics.com/g/collect` だけで、どれにも原文は無い。
- 3 サイトとも、ChatGPT 専用の部品 (Secure Composer の iframe、添付ガード) は動いていない。ホスト名で止めているとおり。

### 2.1 Manus: 下書きが Amplitude に送られる (送信前の漏れ)

| 項目 | 実測 |
|---|---|
| 送り先 | `https://api2.amplitude.com/2/httpapi` (外部の解析サービス) |
| 経路 | ページの fetch POST (`text/plain`、JSON) |
| きっかけ | **下書きの入った入力欄をクリックしたとき** (編集で普通に起きる)。打つだけ・フォーカスを外すだけでは出ない |
| イベント | `[Amplitude] Element Clicked` (Amplitude の自動計測) |
| 入っていた場所 | `event_properties["[Amplitude] Element Text"]` = クリックした要素 (入力欄) の文字 |
| 入っていた値 | カナリアと電話番号が生のまま。メールは入っていなかった |

- 再現は 2 回 (確認スクリプトと、段階別の調査)。送った値は架空のものだけ。
- 拡張の今の対策は、プロバイダ自身のホストへの `sendBeacon` を止めるだけ (`injected.js` の sendBeacon フック。計測に下書きが混ざりうる、という同じ理由)。外部ホスト (`amplitude.com`) への fetch は対象外なので通ってしまう。Manus の送信アダプタも `amplitude` を明示的に対象外にしている。
- ChatGPT では起きない。下書きは拡張オリジンの iframe の中にあり、ページの JS からは読めないので、クリック計測にも入らない。

### 2.2 直し方の候補 (未実装)

| 案 | 中身 | 長所 | 短所 |
|---|---|---|---|
| A | 送信以外の通信 (fetch/XHR/beacon/WebSocket) の本文に、今の下書きの一部 (一定の長さ以上) が入っていたら止める | 検出できない名前や機密も含め、下書きが出ること自体を防ぐ。サイトや計測ツールに依存しない | 下書きを読む処理が要る。下書きを正当に使う機能 (入力補完など) があれば止まる |
| B | 外部の解析ホスト (Amplitude・Segment・Mixpanel 等) への通信の本文をエンジンで調べ、個人情報があれば伏せるか止める | 解析は動き続ける | エンジンが見つけられない値 (名前の一部・機密) は出る。ホストの一覧の保守が要る |
| C | プロバイダのページから外部の解析ホストへの通信を全部止める | 最も単純で確実 | 解析を全部止めるのでサイトの挙動が変わる。一覧外のホストは素通り |

推奨は A。ChatGPT の Secure Composer と同じく、「送信前の原文は送信経路以外から出ない」を守る形になる。B と C は相手 (計測ツール) の作りに依存する。

## 3. ChatGPT との差 (コード上)

| 保護 | ChatGPT | Claude / Gemini / Manus |
|---|---|---|
| 送信本文のマスク | Secure Composer が送信時にマスク | `injected.js` (MAIN world) が送信リクエストを横取りしてマスク |
| 入力中の原文の隔離 | ✅ 拡張オリジンの iframe に閉じる | ✗ 原文はページの入力欄にあり、ページの JS から読める |
| 除外リスト等を MAIN world に出さない (V-02) | ✅ | ✗ 従来どおり MAIN world に配る |
| 添付 (ファイル選択) のマスク | ✅ `attachment-guard.js` (F-SC-07) | ✗ ガードは ChatGPT のホストだけ |
| ドラッグ&ドロップのマスク | ✅ F-SC-13 | ✗ |

- Claude (ログイン後) は、ページに汎用の file input (accept 指定なし) を 1 つ常に置いている。添付の中身はマスクされずに出る。
- Gemini は「アップロードとツール」ボタンとドロップ領域を持つ。file input は押したときに作る方式で、開いた直後のページには無い。Manus (ログイン後) も開いた直後のページには無い。
- Manus のアダプタは `/upload` や `/files` を明示的に対象外にしている。Claude と Gemini のアダプタも、アップロードの宛先には当たらない。

## 4. 次の一手 (提案)

1. **Manus の Amplitude への漏れを塞ぐ** (2.2 の案 A を推奨)。
2. **添付・D&D のマスクを他サイトへ広げる。** ファイル選択は、同じ input に投げ直すだけなので汎用化しやすい。D&D は「マスク済みをどの input に渡すか」がサイトごとに違う。Gemini は押したときに input を作るので、サイトごとの調査が要る。
3. **Secure Composer の他サイト展開**は、各サイトの入力欄と送信ボタンの DOM 調査が前提 (ChatGPT と同じく、ログイン後の実物で確かめる)。

関連: [[attachment-and-retry-findings]] [[secure-composer-final-report]] [[threat-model]]
