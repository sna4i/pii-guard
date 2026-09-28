# push 前チェック

GitHub に push する前に、公開してはいけない内容が含まれていないかを検査する仕組みです。違反が見つかると push は止まり、リモートには何も送られません。

検査は push されるコミットを 1 つずつ見ます。あるコミットで入れた値を次のコミットで消しても、履歴には残って公開されるからです。

## 有効にする

クローンごとに 1 回だけ実行します。

```bash
git config core.hooksPath .githooks
```

必要なものは Node.js 18 以降と Docker です。Docker は秘密情報の検査 (gitleaks) に使います。

## 個人の禁止語リスト

氏名、個人のメールアドレス、別アカウントの ID など、絶対に公開したくない文字列を `.git/info/prepush-denylist` に 1 行ずつ書きます。

```text
# 行頭が # の行は注釈
yamada.taro
山田太郎
```

- 大文字と小文字は区別しません
- `.git/` の中はリポジトリに含まれないので、リスト自体が公開されることはありません
- テスト用データの中でも、許可の目印を付けた行でも、この規則は外せません

## 規則

| ID | 検査すること | 見る場所 | 外し方 |
|---|---|---|---|
| PP-01 | コミットの作者とコミッタのメールが GitHub の noreply アドレスか | コミット情報 | 外せない |
| PP-02 | この端末に固有の情報。ホームのパス、利用者名、Windows 側の利用者名、ホスト名、Claude Code の作業領域のパス | 追加した行、コミットメッセージ、ファイル名、バイナリ内の文字列 | 外せない |
| PP-03 | 個人の禁止語リストにある文字列 | PP-02 と同じ場所と作者名 | 外せない |
| PP-04 | フリーメールや携帯キャリアのメールアドレス | PP-02 と同じ | テスト用データ、許可の目印 |
| PP-05 | Tailscale のアドレスと MagicDNS のホスト名 | PP-02 と同じ | テスト用データ、許可の目印 |
| PP-06 | API キーやトークンなどの秘密情報 (gitleaks) | 追加した行 | `.gitleaks.toml` に理由付きで登録 |
| PP-07 | 生成物と端末ローカルのファイル。キャッシュ、配布用 zip、`node_modules`、環境変数ファイル、鍵ファイルなど | ファイル名 | 外せない |
| PP-08 | 5 MiB を超えるファイル | ファイルの大きさ | `browser-extension/vendor/` だけ対象外 |
| PP-09 | 画像と PDF | ファイル名 | 目視で確かめてから `PREPUSH_IMAGES_REVIEWED=1` |

「テスト用データ」は `tests/` 以下と、`fixtures/` や `__fixtures__/` の中です。検出器の試験のために、架空の個人情報を置く場所です。

「許可の目印」は、行のどこかに `prepush:allow` と書くことです。説明のために例を示す行などに使います。

## 引っかかったとき

どの規則でも、push していないコミットを直してから push し直します。後から消すコミットを足すだけでは、元のコミットが公開されるので通りません。

- **PP-01** は、メールアドレスを noreply に設定してからコミットを作り直します
  ```bash
  git config user.email "<ID>+<ユーザー名>@users.noreply.github.com"
  git commit --amend --reset-author --no-edit
  ```
- **PP-02 から PP-05** は、該当する値を消すか、`/home/<user>` のような仮の値に置き換えます
- **PP-06** は、本物の鍵なら発行元で失効させてから消します。誤検知なら、なぜ誤検知かを書いて `.gitleaks.toml` に登録します
- **PP-07** は、`git rm --cached <ファイル>` で追跡をやめ、`.gitignore` に足します
- **PP-08** は、リポジトリの外に置くか、ダウンロードする手順に置き換えます
- **PP-09** は、画像を開いて個人情報が写っていないかを確かめます。メールアドレス、氏名、ブラウザのタブ、通知、デスクトップのファイル名が写りやすい場所です。確かめたら次のように push します
  ```bash
  PREPUSH_IMAGES_REVIEWED=1 git push
  ```

`git push --no-verify` で検査を飛ばすことはできますが、このリポジトリでは使いません。

## 手動で走らせる

push する前に確かめたいときや、履歴全体を点検したいときに使います。

```bash
node scripts/prepush-check.mjs --range origin/main..HEAD   # これから push するもの
node scripts/prepush-check.mjs --range origin/main         # 公開済みの履歴すべて
```

## 環境変数

| 名前 | 使いどころ |
|---|---|
| `PREPUSH_IMAGES_REVIEWED=1` | 画像と PDF を目視で確かめたと申告する |
| `PREPUSH_SKIP_GITLEAKS=1` | Docker が使えないときに、秘密情報の検査だけを省く。省いたことは出力に残る |
| `PREPUSH_DOCKER` | docker の代わりに使うコマンド。podman など |
| `PREPUSH_GITLEAKS_IMAGE` | gitleaks のイメージ。既定は `zricethezav/gitleaks:v8.30.1` |
| `PREPUSH_DENYLIST` | 個人の禁止語リストの場所を変える |

## この仕組みで防げないもの

- **GitHub 上で作られるコミット**。プルリクエストをマージすると、GitHub はアカウントの主メールアドレスをコミットに記録します。squash、rebase、merge のどの方式でも同じです。防ぐには GitHub の Settings → Emails で「Keep my email addresses private」を有効にします
- **画像に写った内容**。文字として埋め込まれたメタデータは検査しますが、写り込みは PP-09 で目視を求めるだけです
- **圧縮されたメタデータ**。PNG の圧縮テキストなど、圧縮された文字列は検査しません
