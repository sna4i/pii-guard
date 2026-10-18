# 添付ファイル・ペースト・再試行まわりの調査と要件 (Phase 追加)

> 2026-10-18 / 対象: feat/secure-composer

## 1. 調査結果 (実測 + 構造分析)

### 1.0 添付ファイルのアップロード経路 (実測, ログイン後 chatgpt.com, 2026-10-18 追記)
開いていたログイン済みセッション (CDP 9333) で、架空のカナリア .txt を file input にセットして観測 (送信なし):
```
1. POST https://chatgpt.com/backend-api/files                   (JSON: ファイル名/サイズ/MIME → presigned URL 取得)
2. PUT  https://*.oaiusercontent.com/files/<uuid>/raw            ← ★中身を Azure Blob へ直接 PUT (Content-Type: text/plain)
3. POST https://chatgpt.com/backend-api/files/process_upload_stream  (確定)
```
- **ファイルの中身は chatgpt.com ではなく別オリジン (`*.oaiusercontent.com`) への presigned PUT で出る**。Secure Composer も既存の injected.js マスクも通らず、**中身は素通り (未マスク)** を確認。
- ただし PUT を発行するのは chatgpt.com 側の JS なので、**MAIN world の fetch/XHR フック (injected.js) からはこの PUT が見える** → 横取りの足がかりになる。
- `POST /backend-api/files` のメタデータに**ファイル名**が入る (ファイル名自体の PII も二次的に対象)。
- Secure Composer の overlay はログイン後も入力欄を **100% 被覆・SECURE_READY** で、タイプ/ペーストは保護されている (別途実測)。つまり素通りするのは**明示添付の中身**。

### 1.1 長文ペースト → テキストファイル化 (実測, ログインなし chatgpt.com)
- 拡張なしで本物の chatgpt.com (ログインなし) に、実クリップボード + Ctrl+V で 500〜20,000 字を貼った。
- **結果: どのサイズでも入力欄に全文が残り (kept = 貼った文字数)、ファイルチップもアップロード通信も発生しなかった。**
- → **paste→file 変換はログイン後だけの挙動**。ログインなしでは再現できず、閾値・生成方法・アップロード先は自動取得できない (ログイン後は自動操作で開けない / memory: [[project-chatgpt-dom-notes]])。

### 1.2 構造分析 — Secure Composer が付いていれば paste→file は起きない
- Secure Composer 有効時、ユーザーはネイティブ入力欄ではなく **iframe の textarea** に貼る。iframe の textarea はただの textarea なので、何文字貼っても**ファイル化しない** (ChatGPT のファイル化ロジックはネイティブ composer 側にある)。
- 送信時は `writeNative` が**マスク済み**テキストをネイティブに入れる。ここで ChatGPT が大きすぎる本文をファイル化しても、中身は既にマスク済み。
- **したがって、ユーザーが観測した「添付テキストファイルが素通り」は次のどちらか:**
  - **(a)** ログイン後の DOM に iframe が重ならず、ペーストがネイティブ composer に入り、ネイティブ側で未マスクのままファイル化された。
  - **(b)** ＋ボタン / ドラッグ&ドロップでの**明示的なファイル添付** (入力欄を一切通らない。Secure Composer も fetch フックも通らない)。
- どちらかで対処が変わるため、ユーザーに確認が必要 (6 章)。

### 1.3 再試行ボタンの二重処理リスク (構造分析)
- Secure Composer 有効時、iframe がマスク済みをネイティブに入れて送信ボタンを押す → ChatGPT が `POST /conversation` を発行 → **injected.js の fetch フックもこれを横取りする** (フックは SC がマスク済みだと知らない)。
- `interactive:true` だと、この既にマスク済みの本文に対して**サイドバー確認が二重に出る**。キャンセルすると送信が reject → ChatGPT が「再試行」を出す。
- → 二重処理と再試行の経路が、ユーザーの言う「確認→キャンセル→再試行でマスキングが効かない」挙動の温床。
- **根治策 (F-SC-11)**: SC 有効ホスト (ChatGPT) では injected.js の ChatGPT アダプタを**停止**し、SC を唯一の経路にする。こうすればネイティブには常にマスク済みが載り、再試行の再送もマスク済みで安全。

## 2. 要件 (ID 付き)

| ID | 要件 | 検証可否 |
|---|---|---|
| F-SC-07 | 長文が ChatGPT 側でファイル化されるケースを読み取り、**マスキングしてからファイル化**する (拡張内部処理)。SC 経由入力では iframe がファイル化を防ぐので、対象は「ネイティブに渡った後にファイル化される大きなマスク済み本文」= 既にマスク済みで安全。残る本当の対象は 1.2(b) の明示添付 | ⚠️ ログイン後の実測が要る (6 章) |
| F-SC-08 | **未マスクの添付**(テキストファイル等)が composer にあるとき、拡張ボタン(ピル)に**警告マーク**を出す | ✅ モックで検証可 |
| F-SC-09 | 確認→キャンセル→ChatGPT の**再試行**ボタンでマスキングが無効化されない。再送もマスク済みであること | ✅ F-SC-11 + モックで検証可 |
| F-SC-10 | **確認機能 OFF** のとき、未解消の個人情報 or 既にマスクしたデータがある場合、ピルを**黄色**にし「マスキングされたデータがあります」等を表示 | ✅ モックで検証可 |
| F-SC-11 | SC 有効ホストでは injected.js の ChatGPT 横取りを停止 (SC を唯一の送信経路に)。二重確認・再試行バイパスの根治 | ✅ モックで検証可 |

## 3. 設計方針
- **F-SC-11**: injected.js に「このタブで SC が ChatGPT を担っているか」を知らせる。content.js が `secureComposerEnabled` と host から判定し、MAIN world へ非機密フラグ `scOwnsComposer` を配る。injected.js の `pickAdapter` は、ChatGPT かつ `scOwnsComposer` のとき chatgpt アダプタを返さない (素通し)。他プロバイダ・SC 無効時は従来どおり。
- **F-SC-08/10**: composer-toggle (ピル) が、(i) composer 内の添付チップ (未マスク) の有無、(ii) SC からの「マスク/未マスク件数」を受けて、黄色+内訳を出す。SC → content/pill への件数通知を SW ペアリング・バスに追加。
- **F-SC-07 (明示添付, 経路確定済)**: 「先にマスクしてからファイル化」= **ファイル選択の時点で横取り**するのが正道。`HTMLInputElement`(type=file) の `files` 設定と drag&drop を MAIN world でフックし、テキスト系 (txt/md/csv/json/log) は `File.text()` を読んでマスク→**マスク済み内容で新しい File を作って差し替え**る。こうすれば後段の `POST /backend-api/files` のサイズ/SHA も最初からマスク後の値になり整合する (PUT の本文だけ書き換えるとサイズ不一致で壊れる恐れ)。バイナリ (画像/PDF 等) はマスク不能なので F-SC-08 で警告 or ブロック。ファイル名も必要ならマスク。
  - 対象オリジン: フックは chatgpt.com (発行元) の MAIN world で足りる。`*.oaiusercontent.com` への PUT 自体を横取りするのは**サイズ不整合のリスクがあるため避ける** (入力時に差し替える方が安全)。

## 4. 実装状況
- **F-SC-11 (fail-open 修正)**: ✅ 実装・検証済 (本 PR)。`scOwnsComposer` を overlay の live 連動に。機密の非配布 (V-02) は設定連動で常時。RT-LIVE-01/02/03, RT-STAND-01, RT-RETRY-01, RT-PM-01〜05 で確認。
- **F-SC-09 (再試行)**: ✅ F-SC-11 で根治。RT-RETRY-01 で確認。
- **F-SC-10 (マスク済み通知の黄色ピル)**: ✅ 実装・検証済。RT-PILL-01/02。
- **F-SC-08 (未マスク添付の警告)**: ⏳ 実装予定。添付チップ検出 → ピル黄色 (F-SC-10 の仕組みを流用)。
- **F-SC-07 (明示添付のマスク差し替え)**: ⏳ 実装予定。経路は確定 (1.0 節)。file input/drop をフックしテキストをマスクした File に差し替える。モックに file-upload を足して検証 or 実環境で確認。

## 5. テスト観点
- T: SC 有効時、ネイティブ送信を injected.js が二重処理しない (サイドバーが二重に出ない)。
- T: 再試行相当の再送で、本文がマスク済みのまま届く。
- T: composer に未マスク添付チップがあるとピルが警告色。
- T: interactive OFF + マスク済みデータありでピルが黄色 + メッセージ。

## 6. ユーザーに確認したいこと (ログイン後が要る)
1. 素通りしたのは **(a) 長文ペースト由来のファイル** か **(b) ＋ボタン/ドラッグの明示添付** か。
2. (a) なら: ログイン後に長文を貼ってファイル化したときの **ファイルチップの DOM** と、送信時の **アップロード通信 (URL/メソッド/本文の形)**。
3. そもそもログイン後に Secure Composer の iframe が入力欄に**重なっているか** (重なっていないなら、paste がネイティブに入ってファイル化している = 1.2(a))。

関連: [[secure-composer-baseline]] [[threat-model]] [[project-chatgpt-dom-notes]]
