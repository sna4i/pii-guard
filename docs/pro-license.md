# Pro 版のライセンス管理 (Phase 1: ExtensionPay の組み込み)

- 日付: 2026-11-10
- ブランチ: `feat/pro-license` (`fix/1.7.1` から)
- 範囲: 課金の仕組み (ExtensionPay) を組み込み、Pro かどうかの判定を 1 つのモジュールに分ける。Pro の機能そのもの (カスタムルール、復元、サイト別の設定) は Phase 2

## 前提 (変えないこと)

- 入力した文章・検出結果・書き換え後の本文は、外のサーバーに送らない。外との通信は、ライセンスの確認だけ
- 無料版の機能と、検出の挙動 (ルール、辞書、伏せ字の形) は変えない。回数の制限も付けない
- 外からプログラムを読み込まない。ExtPay は同梱する

## 調べたこと (2026-11-10)

拡張機能:

- バンドラは無い。`browser-extension/` をそのまま読み込み、ストア版は `manifest.store.json` を `manifest.json` にするだけ (`scripts/build-store.sh`)
- Service Worker (`background.js`) は ES モジュール (`"type": "module"`)。`importScripts()` は使えない
- エンジン (`engine/*.js`) は、ブラウザでは `window.__localMaskMCP.engine` に機能を足し、node では `require` で読める。ルールは `engine.js` の `collectDetections()` が `patterns.getPresetPatterns()` から読む
- エンジンは 3 つの場所で別々に動く: content script (ISOLATED world)、ページの世界 (MAIN world、`content.js` が `<script>` で読み込む)、保護入力欄 (拡張機能の iframe)
- 多言語対応の仕組みは無い (`_locales` が無く、画面の文字は日本語の直書き)
- テストは `node --test` の単体テスト (`tests/engine` など) と、Playwright の E2E (`tests/e2e`、`tests/redteam`、`tests/integration`)

ExtensionPay (npm の `extpay` 3.1.2 の中身を読んだ):

- `dist/ExtPay.js` は、ポリフィル (webextension-polyfill) を含む普通のスクリプト (`var ExtPay = (function(){…})();`)。ES モジュールとしては読めない。`dist/ExtPay.module.js` は `import * as browser from 'webextension-polyfill'` を含み、バンドラが無いと読めない
- 要る権限は `storage` だけ。ホストの権限は要らない (README も触れていない)。extensionpay.com に content script を置くのは、支払い直後の通知 (`onPaid`) とお試しの開始の通知 (`onTrialStarted`) を使うときだけ
- `getUser()` は、API キーが無ければ通信せずに `paid: false` を返す。API キーは、購入・ログイン・お試しのページを開いたとき (`openPaymentPage` `openLoginPage` `openTrialPage`) に初めて作る (`POST /extension/<id>/api/new-key`)
- 保存先は `chrome.storage.sync` (使えなければ `local`)。キーは `extensionpay_api_key`、`extensionpay_installed_at`、`extensionpay_user` (購入者のメールを含む)
- `installedAt` は ExtPay が初めて動いた日時で、端末側 (`extensionpay_installed_at`) に置く。サーバーの値ではない
- お試し (`openTrialPage`) は、メールアドレスを入れ、届いたリンクを押すと始まる。カードの登録の話は無い。インストール直後に自動では始まらない
- `getUser()` の `plan` は文字列ではなく、`{ unitAmountCents, currency, nickname, interval, intervalCount }` の形
- ライセンスの表記が食い違う: `package.json` は `AGPL-3.0-or-later`、`LICENSE` は `LGPL-3.0`

## 要件

| ID | 要件 |
|---|---|
| F-PRO-01 | ExtPay を同梱し、Service Worker で `ExtPay(EXTPAY_ID)` と `startBackground()` を初期化する。ID は 1 か所 (`license/config.js` の `EXTPAY_ID`) に置く |
| F-PRO-02 | `getUser()` の結果を `chrome.storage.local` の `licenseState` に `{ paid, plan, email, checkedAt, trialEndsAt }` で残す。60 分以内なら通信せずにそれを返す |
| F-PRO-03 | 60 分ごとに確かめ直す (`chrome.alarms`) |
| F-PRO-04 | 通信に失敗したとき、最後に確かめてから 7 日以内なら、残っている購入済みの状態を信じる (有料の人を締め出さない) |
| F-PRO-05 | 画面からの問い合わせに答える: `{type:"license:get"}` で状態、`{type:"license:openPayment"}` で購入のページ、`{type:"license:openLogin"}` でログインのページ |
| F-PRO-06 | エンジンがルールを読むところで、Pro なら Pro のルールパックを足す。ルールの中身は空でよい。画面を隠すだけの門にしない |
| F-PRO-07 | ポップアップと設定画面に、状態 (無料版 / Pro (プラン名) / 確認できなかった注記)、「Pro にアップグレード」、「購入済みの方はこちら (ログイン)」を出す。文言は日本語。確認できなかった注記は、Service Worker が ExtensionPay に確かめられなかったときのもの。Service Worker そのものが答えないときは、Pro の表示を出さない (D-PRO-12) |
| F-PRO-08 | インストールから 7 日は Pro として扱い、過ぎたら無料版に戻る (リバーストライアル) |
| F-PRO-09 | ID が仮のまま (ExtensionPay に登録する前) でも、通信せず、無料版としてすべて動く |
| NF-PRO-01 | 権限の警告を増やさない (更新で拡張機能が止まらないように) |
| NF-PRO-02 | Pro でないとき、検出の処理に余計な仕事を足さない |

## 設計

| ID | 決めたこと | 要件 |
|---|---|---|
| D-PRO-01 | `vendor/extpay/ExtPay.esm.js` は、`dist/ExtPay.js` の末尾に `export default ExtPay;` を 1 行足したもの。それ以外は 1 バイトも変えない。出どころ、元のファイルの sha256、足した行、ライセンスは `vendor/extpay/README.md` に書き、`LICENSE` を写す | F-PRO-01 |
| D-PRO-02 | `license/license.js` は、ExtPay を作る関数・`chrome.storage.local`・`chrome.alarms`・`chrome.runtime`・時計を引数で受ける (`createLicenseManager(deps)`)。Service Worker は本物を渡し、テストは偽物を渡す | F-PRO-02〜05 |
| D-PRO-03 | アラーム `license-revalidate` は、無いときと、間隔が今と違うときだけ作る。Service Worker は 30 秒ほどで止まり、起動のたびに `create` すると 60 分の時計が戻されて鳴らなくなる | F-PRO-03 |
| D-PRO-04 | 購入とログインのページを開く依頼と、確かめ直し (`refresh`) は、ポップアップと設定画面 (`popup.html`、`options.html`) からだけ受ける。保護入力欄の iframe も拡張機能のページだが、AI のサイトの中にあるので受けない。状態の問い合わせは、content script と保護入力欄からも受ける (エンジンの門に使う)。ページを開けなかったとき (ExtPay は API キーを作る通信のあとでページを開く) は `{ ok: false, reason: "network" }` を返し、画面に「ページを開けませんでした」と出す。通信が 10 秒で返らないときは `{ ok: false, reason: "timeout" }` を返し、「決済サービスから返事がありません。しばらく待っても開かないときは、もう一度押してください」と出す (ExtPay の通信は止められないので、そのあとでページが開くこともある)。ログインのページは、ExtPay が窓を開くのを待たない (`open_login_page`) ので、窓が開かなくても `ok: true` になる。「開けませんでした」と出るのは、API キーを作る通信が失敗したときだけ。ページを開く依頼は、同時に 1 本だけ ExtPay に渡す。ExtPay は API キーが無いと、依頼のたびに新しいキーを作り、最後に届いたものだけを残す。重ねると、残らなかったキーのページで買った人が、無料版に見えてしまう (「ログイン」で戻せる)。走っているあいだに押し直したときは ExtPay を呼ばない。同じ種類なら同じ依頼の結果を待ち、別の種類は並べずに `{ ok: false, reason: "busy" }` で断って「別のページを開いているところです。開いたら (開かないときは 1 分ほど待ってから)、もう一度押してください」と出す (並べると、返ったときに溜まった依頼がまとめて ExtPay を呼ぶ)。ExtPay を呼んでから 60 秒 (時間切れの 6 倍) たっても返らない依頼は見捨て、次の依頼は新しく始める (見捨てた依頼がまだキーを作っていれば、キーが 2 つ以上になりうる)。年齢は、メモリの中だけで使う単調な時計 (`performance.now()`) で測る (壁の時計を戻しても見捨てない) | F-PRO-05 |
| D-PRO-05 | extensionpay.com の content script は付けない。付けると「extensionpay.com のデータの読み取りと変更」の警告が増え、更新したとき、利用者が許可するまで拡張機能が止まる。代わりに、`{type:"license:get", refresh:true}` でキャッシュを飛ばして確かめ直せるようにし、画面に「購入状態を更新」を置く。支払いのあとは、これか 60 分ごとの確かめ直しで反映する | NF-PRO-01、F-PRO-05 |
| D-PRO-06 | Pro かどうかは Service Worker だけで決める (`isPro()` = 購入済み、またはお試しの期間中)。content script と保護入力欄は `license:get` で問い合わせ、`licenseState` が変わったら問い合わせ直す。ページの世界には、今の設定の配り方 (`broadcastSettings()`) に `pro` を足して伝える。どの場所でも、エンジンの `setProEnabled()` を呼ぶ | F-PRO-06 |
| D-PRO-07 | エンジンは `setProEnabled(on)` で受けた値を覚え、`collectDetections()` で Pro のときだけ `proRules.getProPatterns(disabled)` を足す。オフのときは今と同じ配列をそのまま使う | F-PRO-06、NF-PRO-02 |
| D-PRO-08 | お試しは ExtPay の `installedAt` から 7 日 (`trialEndsAt`)。ExtPay のお試し (`openTrialPage`) はメールの確認が要り、インストール直後には始まらないので使わない。`installedAt` は端末側の値 (`chrome.storage.sync`) なので、消すと数え直しになる。**ExtPay が `installedAt` を書くのは、初めて作られたとき (ID が決まった版を初めて動かしたとき)。** 今の利用者の 7 日は、本物の ID を入れた版に更新した日から始まる。なので、本物の ID は、最初の Pro の機能と同じ版で入れる (Pro の中身が空のまま、お試しの 7 日だけが過ぎないように) | F-PRO-08 |
| D-PRO-09 | `EXTPAY_ID` が仮の文字列 (`{{` で始まる) なら、ExtPay を作らない。状態は無料版 (`source: "unconfigured"`)、購入とログインのボタンは押せない | F-PRO-09 |
| D-PRO-10 | 画面の文言は日本語の直書き (今の画面と同じ)。状態は「無料版」「Pro (プラン名)」「Pro (お試し中、あと N 日)」。確かめられなかったときは「購入状態を確認できませんでした」と最後に確かめた日時を添える | F-PRO-07 |
| D-PRO-11 | ExtPay の通信には時間切れが無いので、待つのは 10 秒までにして、通信の失敗として扱う (7 日の猶予が効く)。ExtPay への問い合わせは、ふつうは同時に 1 本だけ。時間切れのあとも問い合わせそのものは返るまで残り、そのあいだの確かめ直しは、新しく始めずに同じ問い合わせを待つ。時間切れの 6 倍 (60 秒、単調な時計) たっても返らない問い合わせだけは見捨て、次の確かめ直しで新しく始める (見捨てるたびに 1 本増えうる)。`licenseState` に書くのは、すでに書いた答えより新しく始めた問い合わせの答えだけ (古い答えで新しい答えを上書きしない。あとの問い合わせが失敗した・返らないときは、遅れて届いた答えでも残す。どの答えを書くかは、書き込みを待つ前に決める)。見捨てた問い合わせを待っていた呼び手には、もっと新しく始めた問い合わせの答えがあれば (書いている途中を含む)、そちらを返す。Chrome は、応答の遅い fetch を待つ Service Worker を止めることがあり、そのときは問い合わせごと消える (次の起動で新しく始める)。`license:get` には、画面にも content script にも保護入力欄にも、7 日以内のキャッシュがあれば通信を待たずに返し、60 分を過ぎていれば裏で確かめ直す (`source: "stale"`)。通信を待つのは、画面の「購入状態を更新」(`refresh: true`) と、キャッシュが無いか 7 日を過ぎたときだけ。答えが届けば `licenseState` が書き換わり、storage の変化で伝わる。ポップアップと設定画面は、キャッシュで先に出したとき (`source: "stale"`) は、続けて `refresh: true` で確かめ直しの答えを待って出し直す (確かめられなければ注記が出る)。裏の確かめ直しが走っていればそれを待ち、もう終わっていれば、もう 1 回問い合わせる。どちらの画面も、`licenseState` が書き換わったら出し直す (時間切れの注記のあとで答えが届いたときも)。最後に確かめた日時が未来 (時計が戻った) なら、古いものとして扱う。アラームは、無いときと、間隔が今と違うときに作る | F-PRO-02〜04 |
| D-PRO-12 | ID が仮のあいだ (と、Service Worker から答えが無いとき) は、ポップアップと設定画面に Pro の表示そのものを出さない。「準備中」の表示や、まだ通信しない ExtensionPay の説明を、今の利用者に見せないため。Service Worker が答えないのは、Service Worker が起動できないとき (拡張機能の保護そのものが動いていないとき) で、Pro の欄に出せる正しい状態が無い | F-PRO-07、F-PRO-09 |
| D-PRO-14 | ExtPay は LGPL-3.0 として扱う (本家の GitHub の `LICENSE` に従う。npm の `package.json` とコードの中のコメントは AGPL で、食い違いは残る)。LGPL-3.0 の条件に合わせ、`vendor/extpay/` に別のファイルのまま置き (差し替えられる)、LGPL-3.0 と GPL-3.0 の本文 (`COPYING.LESSER`、`COPYING`) を同梱し、拡張機能の直下の `THIRD_PARTY_NOTICES.txt` に、使っていること・ライセンス・本文の場所・末尾に足した 1 行を書く。設定画面の「エンジン」の欄から、その告知にリンクする。2026-11-11 に利用者が「LGPL として扱う」を選んだ | F-PRO-01 |
| D-PRO-13 | 画面以外 (content script、保護入力欄) への `license:get` の答えは `{ pro, trial, configured, source }` だけ。ページの世界 (AI のサイトのスクリプトが読める所) に渡すのは `pro` だけ。ただし、`licenseState` (購入者のメールとプランを含む。F-PRO-02) は `chrome.storage.local` にあり、content script (ISOLATED world) からは読める。確かめ直して書き換わるたびに、`storage.onChanged` でも content script に届く。保護入力欄の iframe (AI のタブの中にある拡張機能のページ) にも届き、読める。どちらも AI のサイトとは別の世界・別のオリジンなので、AI のサイトのスクリプトからは読めない | F-PRO-05 |

## 確かめ方

| ID | 確かめること | 場所 |
|---|---|---|
| T-PRO-01 | 60 分以内のキャッシュがあれば、ExtPay に問い合わせずにそれを返す | `tests/engine/license.test.mjs` |
| T-PRO-02 | 通信に失敗しても、最後に確かめてから 7 日以内で購入済みなら、Pro のまま (`source: "grace"`)。7 日を過ぎたら無料版 | 同上 |
| T-PRO-03 | 未購入なら無料版で、結果をキャッシュに残す | 同上 |
| T-PRO-04 | インストールから 7 日は Pro (お試し)、過ぎたら無料版 | 同上 |
| T-PRO-05 | ID が仮なら、ExtPay を作らず、無料版を返す | 同上 |
| T-PRO-06 | アラームは無いとき (と、間隔が今と違うとき) だけ作る | 同上 |
| T-PRO-07 | 画面以外への答えは Pro かどうかだけ。購入とログインのページは、ポップアップと設定画面からの依頼でだけ開く (保護入力欄の iframe や content script からは開かない)。開けなかったら失敗を返し、ExtPay が返らなければ 10 秒で `reason: "timeout"` を返す。開く依頼は同時に 1 本だけで、同じ種類の押し直しは結果を待ち (ExtPay は 1 回だけ)、別の種類は `busy` で断る。返らない依頼は 60 秒で見捨て、見捨てた依頼があとで返っても、走っている依頼を手放さない。content script からの `refresh` は聞かない | 同上 |
| T-PRO-13 | キャッシュが古いとき、同時の問い合わせでも ExtPay への確認は 1 回だけ | 同上 |
| T-PRO-14 | ExtPay が返らないときは、時間切れを通信の失敗として扱う (7 日以内なら猶予)。時間切れのあとも、問い合わせが返るまでは次を始めない。返ったら次は新しく始める。返らない問い合わせは 60 秒 (時間切れの 6 倍、単調な時計) で見捨てる。壁の時計が戻っても見捨てない。見捨てた問い合わせがあとで返っても、走っている問い合わせを手放さない。キャッシュに書くのは、すでに書いた答えより新しく始めた問い合わせの答えだけ (遅れた答えでも、新しい答えが無ければ残す。新しい答えを書いている途中に古い答えが届いても上書きしない)。見捨てた問い合わせを待っていた呼び手には、新しい答えを返す | 同上 |
| T-PRO-15 | content script にも画面にも、7 日以内のキャッシュを通信を待たずに返し、古ければ裏で確かめ直す (時計では測らず、待ったときの答えとの違いで確かめる)。画面の `refresh` は確かめ直しを待つ | 同上 |
| T-PRO-16 | 最後に確かめた日時が未来なら、古いものとして確かめ直し、猶予の根拠にしない | 同上 |
| T-PRO-08 | Pro でないとき、エンジンの検出結果は今と同じ。Pro のときだけ Pro のルールパックが効き、送る文の伏せ字にも効く。止めた分類には従う | `tests/engine/pro-gate.test.mjs` |
| T-PRO-09 | 今までの単体・E2E・統合テストがすべて通る (ExtPay を読み込んでも、無料版の動きが変わらない) | 既存のテスト |
| T-PRO-10 | 画面に出す文: 無料版、Pro (プラン名)、お試しの残り日数 (切り上げ)、確かめられなかったときの注記。ID が仮のときと答えが無いときは出さない。ページを開けなかったときの文 (時間切れは「開けなかった」と言い切らない)、別のページを開いている途中の文 | `tests/engine/license-view.test.mjs` |
| T-PRO-11 | ID が仮のまま読み込むと、無料版 (unconfigured) で、アラームも ExtPay の保存も無い。ポップアップと設定画面に Pro の表示は出ない。ページの世界には Pro はオフとして配られる | `tests/e2e/pro-license.test.mjs` |
| T-PRO-12 | 同梱した本物の ExtPay を、extensionpay.com を名乗る模擬のサーバにつなぐ。入れた直後はお試しの Pro で、購入のページを開くまで通信しない。「Pro にアップグレード」で API キーを作って購入のページを開く。購入のあと「購入状態を更新」で「Pro (プラン名)」になり、ページの世界のエンジンにも Pro が届く。Pro のときは、保護入力欄から送る文と、content script (ISOLATED world) のエンジンで伏せる文の両方に、Pro のルールが効く (写しの Pro のルールパックにテスト用のルールを 1 つ入れて確かめる。どちらかの配線を外すと、その経路のテストだけが落ちることも確かめた)。通信の失敗は 7 日の猶予。お試しは 7 日で終わる。ポップアップは開いたらすぐキャッシュで出し、裏の確かめ直しの答えが届いたら出し直す。確かめ直しが失敗したら注記を出す (模擬のサーバで答えを止めて確かめる)。開いているあいだに購入状態が書き換わったら出し直す。ポップアップのプランの行の下の線が消えない | `tests/e2e/pro-license-extpay.test.mjs` |

## 出す前に決めること・直すこと

| 項目 | 内容 |
|---|---|
| ExtPay のライセンス | **決定 (2026-11-11): LGPL-3.0 として扱う** (D-PRO-14)。本文・告知・設定画面からのリンクは用意した。表記の食い違い (package.json とコードのコメントは AGPL-3.0) は残るので、作者から AGPL だと言われたら、同梱をやめる (課金の仕組みは `license/license.js` だけで差し替えられる) |
| プライバシーポリシーとストアの開示 | 本物の ID を入れる版で、`docs/privacy-policy.md` (ストアに載せるポリシー) と `browser-extension/PRIVACY.md` に書き足す。「Pro にアップグレード」か「ログイン」を押したとき、ページを開く前に API キーを作る通信 (`POST /api/new-key`) をし、そのあとは購入状態の確認 (60 分ごと、拡張機能や Chrome が更新されたとき、ポップアップ・設定画面・AI のサイトのページ・保護入力欄を開いたときの裏の確認、「購入状態を更新」) で extensionpay.com と通信すること (送るのは拡張機能の ID と API キー)。API キーは `chrome.storage.sync` で同じ Google アカウントの別の端末にも届くので、その端末では一度も押さなくても通信すること、購入者のメールを `licenseState` (`chrome.storage.local`) に置くこと、ExtPay が `chrome.storage.sync` に API キー・購入者の情報 (メールを含む)・`installedAt` を置き、Chrome の同期で別の端末にも届くこと。ストアのプライバシーの申告 (メールを扱う) も直す |
| お試しの始まり | D-PRO-08 のとおり、本物の ID は最初の Pro の機能と同じ版で入れる |
| ページの世界に配る `pro` | AI のサイトは、利用者が Pro かどうかを読める (送ることもできる)。ページが偽の設定で `pro` を変えても、変わるのはページの世界の予備のエンジンだけで、検出が増えるだけ。今の脅かしの見立て (ページの世界はページが握る) の中なので、見立てに書き足す |

## 手で確かめること (ExtensionPay に登録したあと)

自動のテストは ExtPay を偽物に替えて動かすので、本物の購入の流れは手で確かめる。開発版 (読み込んだだけの拡張機能) は、ExtPay がキーを作るときに `development: true` を付ける (テストの利用者として扱われる)。

1. 先に「出す前に決めること・直すこと」の表を片付ける。そのうえで ExtensionPay に拡張機能を登録し、`browser-extension/license/config.js` の `EXTPAY_ID` を登録した ID に替える
2. ExtensionPay の管理画面で Stripe をテストモードでつなぎ、プランを作る
3. 開発版を読み込み直し、ポップアップの「Pro にアップグレード」から購入のページを開く。Stripe のテスト用カード (4242 4242 4242 4242、期限は未来の日付、CVC は任意) で買う
4. ポップアップに戻って「購入状態を更新」を押すと、「Pro (プラン名)」になる
5. 別のプロファイルで「購入済みの方はこちら (ログイン)」を押し、届いたメールのリンクを開いてから「購入状態を更新」を押すと、Pro になる
6. 回線を切って「購入状態を更新」を押すと、Pro のまま「購入状態を確認できませんでした」と出る
7. 管理画面で購入を取り消すと、60 分以内か「購入状態を更新」で無料版に戻る
