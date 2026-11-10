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
| F-PRO-07 | ポップアップと設定画面に、状態 (無料版 / Pro (プラン名) / 確認できなかった注記)、「Pro にアップグレード」、「購入済みの方はこちら (ログイン)」を出す。文言は日本語 |
| F-PRO-08 | インストールから 7 日は Pro として扱い、過ぎたら無料版に戻る (リバーストライアル) |
| F-PRO-09 | ID が仮のまま (ExtensionPay に登録する前) でも、通信せず、無料版としてすべて動く |
| NF-PRO-01 | 権限の警告を増やさない (更新で拡張機能が止まらないように) |
| NF-PRO-02 | Pro でないとき、検出の処理に余計な仕事を足さない |

## 設計

| ID | 決めたこと | 要件 |
|---|---|---|
| D-PRO-01 | `vendor/extpay/ExtPay.esm.js` は、`dist/ExtPay.js` の末尾に `export default ExtPay;` を 1 行足したもの。それ以外は 1 バイトも変えない。出どころ、元のファイルの sha256、足した行、ライセンスは `vendor/extpay/README.md` に書き、`LICENSE` を写す | F-PRO-01 |
| D-PRO-02 | `license/license.js` は、ExtPay を作る関数・`chrome.storage.local`・`chrome.alarms`・`chrome.runtime`・時計を引数で受ける (`createLicenseManager(deps)`)。Service Worker は本物を渡し、テストは偽物を渡す | F-PRO-02〜05 |
| D-PRO-03 | アラーム `license-revalidate` は、無いときだけ作る。Service Worker は 30 秒ほどで止まり、起動のたびに `create` すると 60 分の時計が戻されて鳴らなくなる | F-PRO-03 |
| D-PRO-04 | 購入とログインのページを開く依頼は、拡張機能のページ (ポップアップ、設定画面) からだけ受ける。状態の問い合わせは、content script と保護入力欄からも受ける (エンジンの門に使う) | F-PRO-05 |
| D-PRO-05 | extensionpay.com の content script は付けない。付けると「extensionpay.com のデータの読み取りと変更」の警告が増え、更新したとき、利用者が許可するまで拡張機能が止まる。代わりに、`{type:"license:get", refresh:true}` でキャッシュを飛ばして確かめ直せるようにし、画面に「購入状態を更新」を置く。支払いのあとは、これか 60 分ごとの確かめ直しで反映する | NF-PRO-01、F-PRO-05 |
| D-PRO-06 | Pro かどうかは Service Worker だけで決める (`isPro()` = 購入済み、またはお試しの期間中)。content script と保護入力欄は `license:get` で問い合わせ、`licenseState` が変わったら問い合わせ直す。ページの世界には、今の設定の配り方 (`broadcastSettings()`) に `pro` を足して伝える。どの場所でも、エンジンの `setProEnabled()` を呼ぶ | F-PRO-06 |
| D-PRO-07 | エンジンは `setProEnabled(on)` で受けた値を覚え、`collectDetections()` で Pro のときだけ `proRules.getProPatterns(disabled)` を足す。オフのときは今と同じ配列をそのまま使う | F-PRO-06、NF-PRO-02 |
| D-PRO-08 | お試しは ExtPay の `installedAt` から 7 日 (`trialEndsAt`)。ExtPay のお試し (`openTrialPage`) はメールの確認が要り、インストール直後には始まらないので使わない。`installedAt` は端末側の値なので、入れ直すと数え直しになる | F-PRO-08 |
| D-PRO-09 | `EXTPAY_ID` が仮の文字列 (`{{` で始まる) なら、ExtPay を作らない。状態は無料版 (`source: "unconfigured"`)、購入とログインのボタンは押せない | F-PRO-09 |
| D-PRO-10 | 画面の文言は日本語の直書き (今の画面と同じ)。状態は「無料版」「Pro (プラン名)」「Pro (お試し中、あと N 日)」。確かめられなかったときは「購入状態を確認できませんでした」と最後に確かめた日時を添える | F-PRO-07 |

## 確かめ方

| ID | 確かめること | 場所 |
|---|---|---|
| T-PRO-01 | 60 分以内のキャッシュがあれば、ExtPay に問い合わせずにそれを返す | `tests/engine/license.test.mjs` |
| T-PRO-02 | 通信に失敗しても、最後に確かめてから 7 日以内で購入済みなら、Pro のまま (`source: "grace"`)。7 日を過ぎたら無料版 | 同上 |
| T-PRO-03 | 未購入なら無料版で、結果をキャッシュに残す | 同上 |
| T-PRO-04 | インストールから 7 日は Pro (お試し)、過ぎたら無料版 | 同上 |
| T-PRO-05 | ID が仮なら、ExtPay を作らず、無料版を返す | 同上 |
| T-PRO-06 | アラームは無いときだけ作る | 同上 |
| T-PRO-07 | 購入とログインのページを開く依頼は、拡張機能のページからだけ受ける | 同上 |
| T-PRO-08 | Pro でないとき、エンジンの検出結果は今と同じ。Pro のときだけ Pro のルールパックが効き、送る文の伏せ字にも効く。止めた分類には従う | `tests/engine/pro-gate.test.mjs` |
| T-PRO-09 | 今までの単体・E2E・統合テストがすべて通る (ExtPay を読み込んでも、無料版の動きが変わらない) | 既存のテスト |
| T-PRO-10 | 画面に出す文: 無料版、Pro (プラン名)、お試しの残り日数 (切り上げ)、確かめられなかったときの注記、ID が仮のとき、答えが無いとき | `tests/engine/license-view.test.mjs` |
| T-PRO-11 | ID が仮のまま読み込むと、無料版 (unconfigured) で、アラームも ExtPay の保存も無い。ポップアップと設定画面に「無料版」「Pro 版は準備中です」が出て、購入のボタンは出ない。ページの世界には Pro はオフとして配られる | `tests/e2e/pro-license.test.mjs` |
| T-PRO-12 | 同梱した本物の ExtPay を、extensionpay.com を名乗る模擬のサーバにつなぐ。入れた直後はお試しの Pro で、購入のページを開くまで通信しない。「Pro にアップグレード」で API キーを作って購入のページを開く。購入のあと「購入状態を更新」で「Pro (プラン名)」になり、ページの世界のエンジンにも Pro が届く。通信の失敗は 7 日の猶予。お試しは 7 日で終わる | `tests/e2e/pro-license-extpay.test.mjs` |

## 手で確かめること (ExtensionPay に登録したあと)

自動のテストは ExtPay を偽物に替えて動かすので、本物の購入の流れは手で確かめる。開発版 (読み込んだだけの拡張機能) は、ExtPay がキーを作るときに `development: true` を付ける (テストの利用者として扱われる)。

1. ExtensionPay に拡張機能を登録し、`browser-extension/license/config.js` の `EXTPAY_ID` を登録した ID に替える
2. ExtensionPay の管理画面で Stripe をテストモードでつなぎ、プランを作る
3. 開発版を読み込み直し、ポップアップの「Pro にアップグレード」から購入のページを開く。Stripe のテスト用カード (4242 4242 4242 4242、期限は未来の日付、CVC は任意) で買う
4. ポップアップに戻って「購入状態を更新」を押すと、「Pro (プラン名)」になる
5. 別のプロファイルで「購入済みの方はこちら (ログイン)」を押し、届いたメールのリンクを開いてから「購入状態を更新」を押すと、Pro になる
6. 回線を切って「購入状態を更新」を押すと、Pro のまま「購入状態を確認できませんでした」と出る
7. 管理画面で購入を取り消すと、60 分以内か「購入状態を更新」で無料版に戻る
