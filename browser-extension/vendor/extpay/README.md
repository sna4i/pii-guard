# ExtPay (同梱)

ExtensionPay の公式ライブラリ。Pro 版の購入状態を確かめるために、Service Worker から読み込む (`license/license.js`、設計は `docs/pro-license.md`)。

## 出どころ

| 項目 | 値 |
|---|---|
| パッケージ | npm の `extpay` 3.1.2 (2025-10-13 公開) |
| tarball | `https://registry.npmjs.org/extpay/-/extpay-3.1.2.tgz` |
| tarball の integrity | `sha512-r3/qE7DyjeVQqllY3NZ7QwWfSYBSbLgrobJJZuNWPMx6Top+WYUpSgSbs0MAMFy8WfV/UUwXfbu8XrQXVLM3zQ==` |
| 元にしたファイル | `package/dist/ExtPay.js` (ポリフィル webextension-polyfill を含む) |
| 元のファイルの sha256 | `ec38f20eeea04502e68e99b939fe0e188045bf68cabe605080cdad79c7fae15a` |

## 変えたところ

`ExtPay.esm.js` は、`dist/ExtPay.js` の末尾に次の 1 行を足しただけのもの。それより前は 1 バイトも変えていない。

```js
export default ExtPay;
```

この拡張機能の Service Worker は ES モジュールで、`importScripts()` が使えない。`dist/ExtPay.js` は普通のスクリプト (`var ExtPay = (function(){…})();`) で、モジュールとして読むと `ExtPay` が外から見えない。`dist/ExtPay.module.js` は `import * as browser from 'webextension-polyfill'` を含み、バンドラが無いと読めない。

確かめ方: `head -c 52182 ExtPay.esm.js | sha256sum` が上の sha256 と同じになる (52182 は元のファイルの大きさ)。

## ライセンス

表記が食い違っている。どちらに従うかは、ストアに出す前に確かめる。

- `package.json` の `license`: `AGPL-3.0-or-later`
- 同梱の `LICENSE` ファイル (ここに写したもの): `LGPL-3.0` (識別子だけで、本文は入っていない)
- `dist/ExtPay.js` の中のコメント (1234 行目): "AGPLv3 licensed"

## 通信と保存 (3.1.2 のコードを読んで確かめたこと)

- 通信の相手は `https://extensionpay.com` だけ。購入・ログイン・お試しのページを開くまで通信しない (API キーが無いうちは、`getUser()` は通信せずに `paid: false` を返す)
- `chrome.storage.sync` (使えなければ `local`) に、`extensionpay_api_key`、`extensionpay_installed_at`、`extensionpay_user` (購入者のメールを含む) を置く
- 外からプログラムを読み込まない (`eval`、`new Function`、`importScripts` は無い)

## 版を上げるとき

1. 新しい版の tarball を、空のフォルダに取ってきて中身を読む (通信先、保存先、外からの読み込みが無いこと)
2. `dist/ExtPay.js` の末尾に上の 1 行を足して `ExtPay.esm.js` を作り直す
3. この README の版・integrity・sha256・大きさを書き直す
4. 全部の E2E を流す。`ExtPay.esm.js` は Service Worker が最初に読み込むので、読み込みで投げると、拡張機能の Service Worker がまるごと起動しない
