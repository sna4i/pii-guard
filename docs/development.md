# PII Guard — 開発者向け資料

**日本語** / [English](./development.en.md)

拡張機能を使うだけなら、リポジトリ直下の [README](../README.md) を参照してください。この資料は、ゲートウェイ・MCP サーバ・検出エンジンの仕組みと開発手順をまとめたものです。

![Python 3.11](https://img.shields.io/badge/python-3.11-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)
![Pydantic v2](https://img.shields.io/badge/Pydantic-v2-E92063?logo=pydantic&logoColor=white)
![uv](https://img.shields.io/badge/uv-0.11-DE5FE9?logo=python&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Presidio](https://img.shields.io/badge/Presidio-MS-5E5CE6)
![SudachiPy](https://img.shields.io/badge/SudachiPy-core-E60012)
![pytesseract](https://img.shields.io/badge/pytesseract-OCR-4B5563)
![FastMCP](https://img.shields.io/badge/FastMCP-stdio-7C3AED)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-local--LLM-000000?logo=ollama&logoColor=white)
![Qwen3](https://img.shields.io/badge/Qwen3-1.7b%20%2F%204b-615CED)
![pytest](https://img.shields.io/badge/tests-pytest-0A9EDC?logo=pytest&logoColor=white)
![Ruff](https://img.shields.io/badge/lint-Ruff-D7FF64?logo=ruff&logoColor=black)

生成 AI サービスへ送信する前に、ローカル PC 上で個人情報を検出・マスクする軽量ゲートウェイ + Chrome 拡張機能です。ブラウザ拡張 (Chrome MV3) が Claude.ai / ChatGPT / Manus の送信を横取りし、PII を検出します。オプションで FastAPI ゲートウェイ (Docker) と Presidio / SudachiPy / プリセット正規表現による多段アナライザを使用でき、さらに Ollama / LM Studio / llama.cpp によるローカル LLM を接続すれば文脈考慮型の追加検出と AI 置換モードが利用できます (v0.5.0+)。検出結果は送信直前にサイドバーでユーザー確認され、確定したものだけマスク済みペイロードとして送信されます。第三者サーバーへの送信はありません。(100%の検出が可能というわけではありません。補助的なツールとして利用ください。)

Chrome ウェブストアで配布している拡張機能と、開発用のビルドがあります。版ごとの変更は [CHANGELOG](../browser-extension/CHANGELOG.md)、今後の予定は [TODO.md](../TODO.md) を参照してください。

push する前の検査 (端末のパス・個人情報・秘密情報) は [prepush-check.md](./prepush-check.md) にまとめています。クローンしたら最初に `git config core.hooksPath .githooks` を実行してください。

## 目次

- [概要](#概要)
- [アーキテクチャ](#アーキテクチャ)
- [検出対象カタログ](#検出対象カタログ)
- [ベンダー別 API キー検出 (v0.5.0+)](#ベンダー別-api-キー検出-v050)
- [重要度 (severity) 分類](#重要度-severity-分類)
- [一般名詞ブロックリスト](#一般名詞ブロックリスト)
- [セットアップ](#セットアップ)
- [使い方 (Gateway API)](#使い方-gateway-api)
- [ブラウザ拡張](#ブラウザ拡張)
- [ローカル LLM 連携 (v0.5.0)](#ローカル-llm-連携-v050)
- [Claude Code / Claude Desktop 連携](#claude-code--claude-desktop-連携)
- [Chrome Web Store 公開ビルド](#chrome-web-store-公開ビルド)
- [テスト](#テスト)
- [ディレクトリ構成](#ディレクトリ構成)

## 概要

| レイヤ | 技術 | 責務 |
|---|---|---|
| ブラウザ拡張 | Chrome MV3 / Shadow DOM / Service Worker | 送信インターセプト、サイドバー UI、LLM プロキシ |
| ゲートウェイ (任意) | FastAPI + Pydantic v2 + uv on Docker | Presidio / Sudachi / 正規表現の合成パイプライン |
| MCP サーバ (任意) | FastMCP (stdio) | Claude Desktop へ `sanitize_text` 等のツール提供 |
| ローカル LLM (任意) | Ollama / LM Studio / llama.cpp | 文脈考慮型 PII 検出 + AI 置換モード |

拡張はゲートウェイ不要でも動作します (standalone モード)。ゲートウェイが `127.0.0.1:8081` で応答すれば自動的に併用されます (hybrid モード)。LLM を有効化すると拡張が Service Worker 経由で直接 Ollama を呼び出します。ゲートウェイも LLM もホストマシン / LAN から外に出ることはありません。

## アーキテクチャ

```text
      HTTP request (/sanitize/text, /proxy/*)        MCP stdio (sanitize_text, ...)
              │                                                │
              ▼                                                ▼
        FastAPI router  ───────────────────────────────▶  FastMCP server
              │             (shared MaskingService)
              ▼
     ┌──────────────────────────────────────────────┐
     │             MaskingService                   │
     │  detect_language(text)  →  "ja"/"en"/"mixed" │
     │          │                                   │
     │          ▼                                   │
     │  analyzers_by_language[lang]  (or legacy)    │
     │          │                                   │
     │   ┌──────┼──────────┬───────────┐            │
     │   ▼      ▼          ▼           ▼            │
     │ Presidio Sudachi  Regex  (future analyzer)   │
     │   │      │          │                        │
     │   └──────┴──────────┘                        │
     │        merged RecognizerResult[]             │
     │        │                                     │
     │        ▼                                     │
     │  _resolve_overlaps (sweep-line)              │
     │        │                                     │
     │        ▼                                     │
     │  allow-list filter + mask strategy           │
     │  (tag | partial | hash)                      │
     └────────────────────┬─────────────────────────┘
                          ▼
           sanitized text + DetectionResult[]
                          │
                          ▼
          MITM proxy → upstream LLM  (optional)
                          │
                          ▼
           audit log (JSONL) + admin_token bootstrap
```

アナライザ構成 (全て実装済み):

| アナライザ | 言語 | 役割 |
|---|---|---|
| Presidio | 英語中心 | `PERSON` / `EMAIL_ADDRESS` / `CREDIT_CARD` など固定カテゴリ |
| SudachiPy | 日本語 | 形態素解析で `名詞,固有名詞` のみ抽出 (一般名詞は素通し) |
| RegexAnalyzer | 両対応 | 社内 ID・API キー・住所・40+ カテゴリのプリセット |
| ローカル LLM | 両対応 | 文脈考慮型 PII 検出 (regex は安全網として残す) |

`Analyzer` Protocol (`src/app/services/analyzers/base.py`) で 3 種を統一しているため、新規アナライザ (例: GiNZA) の追加は 1 ファイルで完結します。

## 検出対象カタログ

デフォルトで以下のカテゴリが有効です (`enable_preset_patterns: true`)。カテゴリ単位で無効化する場合は `disabled_pattern_categories` に追加してください。

| カテゴリ | entity_type | 検出例 | 検出元 |
|---|---|---|---|
| 人名 | `PERSON` / `PROPER_NOUN_PERSON` | 田中太郎、山田 | Presidio NER / Sudachi |
| メールアドレス | `EMAIL_ADDRESS` | user@example.com | Presidio |
| 電話番号 | `PHONE_NUMBER` | 090-1234-5678, 03-1234-5678 | Presidio / プリセット |
| 都道府県+市区町村 | `PREFECTURE_CITY` | 東京都渋谷区 | プリセット正規表現 |
| 住所 (番地まで) | `ADDRESS` | 東京都渋谷区1丁目2番3号 | プリセット正規表現 |
| 都道府県 (単体) | `JP_PREFECTURE_DICT` | 東京都 / 大阪府 (47 都道府県) | 静的辞書 |
| 政令指定都市 (単体) | `JP_DESIGNATED_CITY` | 札幌市 / 横浜市 / 大阪市 (20 市) | 静的辞書 |
| 主要国名 | `WORLD_COUNTRY` | 日本 / Japan / 米国 / USA / France 等 (G20 + 主要アジア) | 静的辞書 |
| 日本人苗字 | `JP_SURNAME` | 佐藤 / 鈴木 / 高橋 / 田中 … (top 50) | 静的辞書 |
| Western first names | `WESTERN_FIRST_NAME` | John / Mary / David 等 (curated) | 静的辞書 |
| 年齢 | `AGE` | 35歳 | プリセット正規表現 |
| 性別 | `GENDER` | 男性 / 女性 | プリセット正規表現 |
| 会社名 | `COMPANY` | 株式会社マスクテスト | プリセット正規表現 |
| 金額 | `MONETARY_AMOUNT` | ¥15,000 / 100万円 | プリセット正規表現 |
| 日付 | `DATE` | 2024/01/15, 令和6年1月 | プリセット正規表現 |
| IP アドレス | `IP_ADDRESS` | 192.168.1.1 | プリセット正規表現 |
| URL | `URL` | https://example.com | プリセット正規表現 |
| マイナンバー | `MY_NUMBER` | 1234 5678 9012 | プリセット正規表現 |
| 口座番号 | `BANK_ACCOUNT` | 普通 1234567 | プリセット正規表現 |
| 免許証番号 | `DRIVERS_LICENSE` | 12-34-567890-12 | プリセット正規表現 |
| パスポート | `PASSPORT` | AB1234567 | プリセット正規表現 |
| DB 接続情報 | `DB_CONNECTION` | `postgresql://...` | プリセット正規表現 |
| API キー | `API_KEY` / `SECRET` | `sk-xxx`, `password=xxx` | [ベンダー別テーブル](#ベンダー別-api-キー検出-v050) |
| 内部 ID | `INTERNAL_ID` | PRJ-001, EMP-12345 | プリセット正規表現 |
| クレジットカード | `CREDIT_CARD` | 4111-1111-1111-1111 | Presidio |
| 地名 | `LOCATION` / `PROPER_NOUN_LOCATION` | 東京、大阪 | Presidio / Sudachi |
| 組織名 | `PROPER_NOUN_ORG` | グーグル | Sudachi |

**`PREFECTURE_CITY` と `ADDRESS` の使い分け**: 「東京都渋谷区」のような都道府県+市区町村単体は `PREFECTURE_CITY` として検出されます。「東京都渋谷区1丁目2番3号」のように番地まで続く場合は `ADDRESS` が longer span として勝ち、overlap resolver が自動で解決します。

**辞書ベース fallback カテゴリ** (`JP_SURNAME` / `JP_PREFECTURE_DICT` / `JP_DESIGNATED_CITY` / `WORLD_COUNTRY` / `WESTERN_FIRST_NAME`): Sudachi / Presidio を有効にしていない standalone 構成でも、日本の主要苗字・都道府県・政令指定都市・主要国名・Western 名を確実にマスク対象にする静的辞書層です。辞書本体は `browser-extension/engine/dictionaries.js` と `src/app/services/analyzers/dictionaries.py` で同じ内容を保持しています。名を辞書に追加する場合は両方を同時に更新してください。

### ビジネス文書向け 15 カテゴリ (Milestone 8 Wave A)

| カテゴリ | entity_type | 検出対象 |
|---|---|---|
| 郵便番号 | `POSTAL_CODE` | `〒651-0087`, `123-4567` |
| 部署コード | `DEPARTMENT` | `DIV-101`, `部署コード: D-001` |
| 契約番号 | `CONTRACT_NUMBER` | `CONTRACT-ABC-001`, `契約番号: CT-2024-01` |
| 発注番号 / PO | `PURCHASE_ORDER` | `PO-1234567`, `発注番号: PO-9999` |
| 顧客 ID | `CUSTOMER_ID` | `CUST-0001`, `顧客ID: C-999` |
| 請求書番号 | `INVOICE_NUMBER` | `INV-20240415`, `請求番号: INV-12` |
| 社員 ID | `EMPLOYEE_ID` | `STAFF-00123`, `社員番号: E-0042` |
| 会員 ID | `MEMBER_ID` | `MEMBER-123456`, `会員ID: M-555` |
| 患者 ID | `PATIENT_ID` | `PATIENT-12345`, `患者ID: P-77` |
| 製品コード / SKU | `SKU` | `SKU-ABC-123`, `商品コード: X-77` |
| 血液型 | `BLOOD_TYPE` | `AB型`, `A型` |
| 年収 / 月収 | `ANNUAL_INCOME` | `年収1200万円`, `月収 40 万円` |
| 特許番号 | `PATENT_NUMBER` | `特許2024-123456`, `JP 1234567` |
| 資産番号 | `ASSET_NUMBER` | `ASSET-12345`, `資産番号: FA-999` |
| ライセンス番号 | `LICENSE_NUMBER` | `LIC-ABC-2024` |

プリセットは `src/app/services/analyzers/presets.py` で定義されています。漏洩傾向のある新カテゴリが判明するたびに順次拡張していく前提です。誤検知は `disabled_pattern_categories` もしくはブラウザ拡張のレビューモーダルで個別に解除してください。

## ベンダー別 API キー検出 (v0.5.0+)

`API_KEY` カテゴリは汎用 `sk-*` / `pk_*` / `access_key_*` に加えて、主要 SaaS の固定プレフィックストークンを直接認識します。`browser-extension/engine/patterns.js` と `src/app/services/analyzers/presets.py` で同じ内容を保持 (両方を必ず同時に更新)。

| Vendor | プレフィックス / フォーマット | 用途 |
|---|---|---|
| OpenAI | `sk-<32+>` / `sk-proj-...` / `sk-svcacct-...` / `sk-None-...` | プロジェクト/サービス/レガシー各種キー |
| Anthropic | `sk-ant-api03-<80+>` / `sk-ant-admin01-<80+>` | Claude API / Admin |
| Notion | `ntn_<40+>` / `secret_<43>` | Integration token (新/旧) |
| GitHub | `ghp_<36>` / `gho_<36>` / `ghu_<36>` / `ghs_<36>` / `ghr_<36>` / `github_pat_<80+>` | PAT / OAuth / fine-grained |
| Slack | `xoxb-*` / `xoxp-*` / `xoxa-*` / `xoxr-*` / `xoxs-*` | Bot / User / App / Refresh |
| Google | `AIza[A-Za-z0-9_\-]{35}` / `ya29.<40+>` | GCP / Firebase / OAuth |
| AWS | `AKIA` / `ASIA` / `AROA` / `AIDA` / `ANPA` / `ANVA` / `APKA` / `ABIA` / `ACCA` + `[A-Z0-9]{16}` | IAM / STS / Federated |
| Hugging Face | `hf_<34+>` | Access token |
| Stripe | `sk_live_*` / `sk_test_*` / `pk_live_*` / `pk_test_*` / `rk_*` / `whsec_*` | Secret / Publishable / Webhook |
| Twilio | `AC<32 hex>` / `SK<32 hex>` | Account SID / API Key SID |
| SendGrid | `SG.<22>.<43>` | API key (2 segments) |
| Groq | `gsk_<40+>` | API key |
| Replicate | `r8_<37+>` | API key |
| Tavily | `tvly-<16+>` | Search API key |
| GitLab | `glpat-<20+>` / `glrt-<20+>` | Personal / Runner |
| Mailgun | `key-<32 hex>` | Private API key |
| npm | `npm_<36>` | Automation / publishing |
| Fireworks AI | `fw_<24+>` | API key |
| Airtable | `pat<14>.<64 hex>` | Personal access |
| Linear | `lin_api_<32+>` / `lin_oauth_<32+>` | API / OAuth |
| Figma | `figd_<40+>` | Personal access |
| Discord | `[MN][A-Za-z\d]{23}.<6>.<27+>` | Bot token |
| Cloudflare | `cf-<40+>` | API token |
| JWT | `eyJ...·eyJ...·...` | 三分割 base64url (Supabase 等) |
| HTTP header | `Bearer <16+>` / `X-Api-Key: ...` | リクエストヘッダ書式 |
| 証明書 | `-----BEGIN … PRIVATE KEY-----` | RSA / EC / OpenSSH / PGP / DSA |

これらは全て `entity_type` を `API_KEY` (PEM 鍵のみ `SECRET`) として出力し、[severity 分類](#重要度-severity-分類) で critical 扱いです。サイドバーでは赤枠 + ロック、送信前に必ずユーザー確認が入ります。

ローカル LLM を有効にしている場合でも、これらの構造化トークンは regex の安全網として常に検出されます。LLM が「これは API キーではない」と判断しても、regex による critical 検出は残るため取りこぼしは起きません。

## 重要度 (severity) 分類

各検出には `category` (表示バケット) / `classification` (言語分類) に加えて `severity` (漏洩時の危険度) が付与されます。`src/app/services/severity.py` の `LABEL_TO_SEVERITY` がベース、`severity_for_surface(label, surface)` が検出された実テキストを見て動的に tier を上げます。UI はこの値を元に左ボーダー色・カテゴリヘッダー色・長押しゲートを切り替えます。

| Severity | 対象ラベル (抜粋) | UI 色 | UI 挙動 |
|---|---|---|---|
| critical | `MY_NUMBER`, `PASSPORT`, `DRIVERS_LICENSE`, `CREDIT_CARD`, `BANK_ACCOUNT`, `API_KEY`, `SECRET`, `DB_CONNECTION`, + 動的昇格 | rose `#e11d48` | `force_masked_categories` 由来のロック行のみ長押し (0–1.5s) 必要 |
| high | `PHONE_NUMBER`, `ADDRESS`, `PATIENT_ID`, `JP_SURNAME`, `WESTERN_FIRST_NAME` | orange `#ea580c` | クリックで切替 |
| medium | `LOCATION`, `PREFECTURE_CITY`, `JP_PREFECTURE_DICT`, `JP_DESIGNATED_CITY`, `WORLD_COUNTRY`, `EMPLOYEE_ID`, `MEMBER_ID`, `CUSTOMER_ID`, `CONTRACT_NUMBER`, `MONETARY_AMOUNT`, `URL`, `IP_ADDRESS` 他 | yellow `#ca8a04` | クリックで切替 |
| low | `AGE`, `GENDER`, `DATE`, `BLOOD_TYPE`, `POSTAL_CODE`, `SKU`, `KATAKANA_NAME` | slate `#64748b` | クリックで切替 |

### Surface-aware 昇格ルール

`severity_for_surface(label, value)` は base severity を以下の規則で critical に昇格します (Python と JS engine で同じ正規表現):

| ラベル | 昇格条件 | 例 |
|---|---|---|
| `PERSON` / `PROPER_NOUN_PERSON` | 常に critical | 「田中太郎」 |
| `ORGANIZATION` / `COMPANY` / `PROPER_NOUN_ORG` | surface に `株式会社` `㈱` `有限会社` `㈲` `合同会社` `合資会社` を含む | 「株式会社アクメ」「アクメ㈱」 |
| `EMAIL_ADDRESS` | surface が `user@host.tld` 形式 (ドメイン付き) | `tanaka@acme.com` |

### PERSON 偽陽性フィルタ

Sudachi / Presidio は時折、敬語や業務表現 (例: 「ご注意くださいますようお願いいたします」) を `PROPER_NOUN_PERSON` と誤判定します。これを防ぐため `is_false_positive_person(surface)` が以下の条件で検出を完全に drop します:

- surface 長 > 6 文字 (実際の名前は 2–6 文字)
- かつ次のいずれかを含む: `ます` `ません` `ください` `いたします` `願い` `注意` `確認` `ご了承` `申し訳` `よろしく` `とおり` `ように` `については` `ところ` `ため` `こと` 等

カテゴリヘッダーは配下の子行の最悪 severity で塗られます (例: `PERSON` カテゴリに `API_KEY` が混ざっていれば critical 色)。`RuntimeConfig.default_uncheck_below` で「この重要度未満の行は初期状態で未チェックにする」閾値を設定できます (デフォルト `"low"` = 全行初期マスク)。

## 一般名詞ブロックリスト

Sudachi の `sudachidict_core` はカタカナの汎用ビジネス用語 (`プロジェクト` / `メンバー` / `チーム` 等) を稀に固有名詞とタグ付けします。`RuntimeConfig.common_noun_blocklist` に表面文字列を登録しておくと、マスク処理の前段で完全一致でドロップされます (大文字小文字区別・前方一致なし)。

デフォルトでは次の 26 語が登録されています:

```
プロジェクト, メンバー, チーム, マネージャー, リーダー, ユーザー,
クライアント, サーバー, システム, データ, ファイル, フォルダ,
フォルダー, レポート, ミーティング, タスク, チケット, スケジュール,
ドキュメント, アカウント, パスワード, メッセージ, スタッフ,
カスタマー, オフィス, ミーティングルーム
```

ブロックリストは `min_score` / `enabled_pii_classes` / `allow_entity_types` より先に適用されるため、たとえ別のアナライザが信頼度 1.0 で検出していてもドロップされます。用途例:

- 偽陽性の抑制 — 「プロジェクトαの進捗」のような一般語を恒常的に除外
- 安全装置 — 「東京」を追加して、位置情報の誤送を強制的にブロック (検出ラベルが `PROPER_NOUN_LOCATION` でもドロップされる)

## セットアップ

本プロジェクトは Docker 前提で管理しています。ホストに Python や uv をインストールする必要はありません。必要なのは `docker` と `docker compose` だけです。

### ゲートウェイ起動

```bash
cd /path/to/pii-guard
make up                        # build + 起動 + /health 待ち + admin_token 表示
make config                    # 認証済みで /admin/config を pretty-print
make logs                      # コンテナログを tail
make down                      # 停止 (data/ は保持)
make help                      # 全ターゲット一覧
```

`make up` は内部で `mkdir -p data && docker compose up -d --build` を行い、`/health` が 200 を返すまで最大 60 秒待機します。`.env` は任意で、`ADMIN_TOKEN` は初回リクエスト時に自動生成されて `data/admin_token` (mode 0600) に保存されるため、`.env` を用意しなくてもそのまま動きます。

コードを書き換えた後は `make up` がそのまま `--build` を含むので毎回拾ってくれますが、レイヤキャッシュが壊れた気配があるときは `make rebuild` (`docker compose build --no-cache` のエイリアス) を使ってください。

```bash
TOKEN=$(cat data/admin_token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/config
```

初回ビルドは spaCy `en_core_web_lg` (~400 MB) の取得があるため数分かかります。2 回目以降はレイヤキャッシュが効きます。OCR で日本語を扱う場合は、Dockerfile の `tesseract-ocr-eng` の横に `tesseract-ocr-jpn` を追加してから再ビルドしてください。

依存は `uv.lock` で完全にロックされており、このファイルは repo にコミットします。`docker compose build` は `uv.lock` を基に `uv sync --frozen` で再現性のあるインストールを実行します。依存を変更するときのみ、使い捨てコンテナで uv を走らせてロックファイルを更新します:

```bash
docker run --rm -it -v "$PWD:/app" -w /app \
    ghcr.io/astral-sh/uv:0.11-python3.11-bookworm-slim \
    sh -c 'uv add <package> && cat uv.lock > /dev/null'
```

### 自動起動 (OS ログイン時にゲートウェイを起動)

Chrome 拡張はサンドボックスの制約で自身から Docker を起動できないため、OS ログイン時にゲートウェイを自動で立ち上げる仕組みを用意しています。1 度実行すれば以降は自動。

Linux / WSL2:

```bash
cd /path/to/pii-guard
bash scripts/install-autostart.sh
```

systemd user service (`~/.config/systemd/user/mask-mcp-gateway.service`) を登録します。systemd が使えない環境 (WSL で `/etc/wsl.conf` の `systemd=true` 未設定など) では `~/.bashrc` フックに自動フォールバックします。次回ログインから `docker compose up -d` が自動実行され、container 自体は `restart: unless-stopped` なので Docker daemon 再起動にも追従します。確認は `systemctl --user status mask-mcp-gateway`、削除は `bash scripts/install-autostart.sh --uninstall` です。

Windows (WSL + Docker Desktop 前提) の場合は PowerShell (管理者権限不要) から:

```powershell
cd C:\Users\<you>\workspace\pii-guard
powershell -File scripts\install-autostart.ps1
```

Windows タスクスケジューラに `MaskMcpGatewayAutostart` が登録され、ログイン時に `wsl -d <distro> -- bash -c "cd <repo> && docker compose up -d"` が実行されます。削除は `powershell -File scripts\install-autostart.ps1 -Uninstall`。

拡張インストール後、ゲートウェイに届かない状態で popup を開くと「Gateway が見つかりません」が表示され、OS 向けの install コマンドがコピー可能な形で出ます。

### Standalone モード (Docker 不要)

`feat/serverless-engine-phase1` 以降、拡張機能に pure-JavaScript の PII 検出エンジンが同梱されています。Docker ゲートウェイを立ち上げなくても、regex ベースのプリセット (EMAIL / PHONE_NUMBER / POSTAL_CODE / MY_NUMBER / API_KEY / BLOOD_TYPE / ANNUAL_INCOME など 40+ カテゴリ) はブラウザ内でそのまま動きます。

精度目安:

| カテゴリ | Standalone (Phase 1) | Gateway (Phase 2 + Presidio) |
|---|---|---|
| 構造化 PII (email / phone / 郵便番号 / マイナンバー / API key / …) | ≒ 同等 | 同等 |
| 日本語固有名詞 (田中太郎、株式会社〇〇) | 部分 (COMPANY + KATAKANA_NAME のみ) | 高 (Sudachi 形態素) |
| 英語 PERSON / LOCATION / ORGANIZATION | 未対応 | 高 (Presidio NER) |

標準では hybrid モードで動作し、ゲートウェイが `127.0.0.1:8081` で応答すればゲートウェイを使い、応答しなければ自動的に standalone エンジンへフォールバックします。

## 使い方 (Gateway API)

ゲートウェイは `docker compose up -d` で起動済みの前提です。以下の `curl` はすべてホストから動作中のコンテナ (`127.0.0.1:8081`) に対して叩きます。

### テキスト単体のマスキング

```bash
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "John Doe lives at 1 Main St. Email john@example.com"}'
```

レスポンスの `detections` 配列は以下のカラムを持つので、どのクライアントでもそのままテーブル描画できます。

| カラム | 意味 |
|---|---|
| `entity_type` | Presidio / Sudachi / プリセットが付けたラベル |
| `start` / `end` | 元テキスト中の文字オフセット |
| `line` / `column` | 1 始まりの行・列 (PDF やログ参照時の目印) |
| `text` | 元テキストの該当部分 |
| `context_before` / `context_after` | 前後 ~20 文字のスニペット |
| `score` | Presidio の確信度 (0.0–1.0) |
| `action` | `masked` (置換済) または `allowed` (pass-through) |

### OpenAI / Claude へ転送 (MITM パススルー)

ゲートウェイは純粋な MITM として動作するため、クライアントは自分でプロバイダ宛の認証ヘッダ (OpenAI なら `Authorization: Bearer ...`、Anthropic なら `x-api-key: ...`) を付与します。ゲートウェイ側には API キーを置きません。

```bash
curl -X POST http://127.0.0.1:8081/proxy/openai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"My email is john@example.com"}]}'

curl -X POST http://127.0.0.1:8081/proxy/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-3-5-sonnet-latest","messages":[{"role":"user","content":"My phone is 090-1234-5678"}],"max_tokens":512}'
```

### 日本語 (Sudachi) 固有名詞マスキング

`RuntimeConfig.morphological_analyzer` を `"sudachi"` に切り替えると、SudachiPy による形態素解析が Presidio の検出結果にアドオンされ、`("名詞","固有名詞",...)` のみが `PROPER_NOUN_PERSON` / `PROPER_NOUN_LOCATION` / `PROPER_NOUN_ORG` / `PROPER_NOUN` としてマスキング対象に加わります。一般名詞はマスクされません。

```bash
cat <<'JSON' | curl -X PUT http://127.0.0.1:8081/admin/config \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' -d @-
{
  "filter_enabled": true,
  "morphological_analyzer": "sudachi",
  "sudachi_split_mode": "A",
  "proper_noun_pos_patterns": [["名詞", "固有名詞"]]
}
JSON

curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "田中太郎は東京本社にいる"}'
```

期待されるレスポンス (抜粋):

```jsonc
{
  "sanitized_text": "<PROPER_NOUN_PERSON>は<PROPER_NOUN_LOCATION>本社にいる",
  "detections": [
    { "entity_type": "PROPER_NOUN_PERSON", "text": "田中太郎", "action": "masked" },
    { "entity_type": "PROPER_NOUN_LOCATION", "text": "東京", "action": "masked" }
  ]
}
```

`sudachi_split_mode` と `proper_noun_pos_patterns` は両方とも省略可能で、既定値はそれぞれ `"C"` (複合固有名詞を 1 トークンに融合) と `[["名詞", "固有名詞"]]` です。`"A"` は最小単位まで分割 (例: `東京スカイツリー` → `東京` + `スカイツリー`)、`"B"` は中間、`"C"` は最長単位で融合します。

### 言語別アナライザ振り分け + 正規表現カスタム検出

長文の英語と日本語が混在するワークロードでは、`RuntimeConfig.analyzers_by_language` で入力テキストの CJK 比率で振り分けできます。社内 ID や案件コードのように Presidio の定型カテゴリでも Sudachi でも拾えない業務固有パターンには、`RegexAnalyzer` によるカスタム正規表現を 1 本の分析器として追加できます。

```bash
cat <<'JSON' | curl -X PUT http://127.0.0.1:8081/admin/config \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' -d @-
{
  "analyzers_by_language": {
    "en":    ["presidio", "regex"],
    "ja":    ["sudachi",  "regex"],
    "mixed": ["presidio", "sudachi", "regex"]
  },
  "regex_patterns": [
    ["EMPLOYEE_ID",   "EMP-\\d{5}"],
    ["PROJECT_CODE",  "PRJ-[A-Z]{3}-\\d{4}"]
  ]
}
JSON
```

`regex_patterns` の各要素は `[entity_type, regex]` の 2 要素リストで、JSON エスケープの都合上 `\\d` のようにバックスラッシュを二重化して書きます。`analyzers_by_language` が未設定 (`null`) の場合は従来通り Presidio 常時 + Sudachi 任意の挙動になり、既存デプロイには影響しません。

### 集約エンドポイント

`POST /v1/extension/sanitize/aggregated` は、同じテキストが複数回出現する場合にサイドバー UI 側で `田中太郎 (2件)` のように 1 行で表示できるよう集約されたレスポンスを返します。オリジナルの `POST /v1/extension/sanitize` は後方互換のため従来通り per-detection 形式で返します。

```json
{
  "original_text": "リーク情報: 田中太郎の年収1200万円。",
  "aggregated": [
    { "value": "田中太郎", "label": "PROPER_NOUN_PERSON", "category": "PERSON", "count": 1, "positions": [[6, 10]], "masked": true }
  ],
  "audit_id": "...",
  "force_masked_categories": ["PERSON", "ORGANIZATION", "FINANCIAL"]
}
```

`force_masked_categories` は `RuntimeConfig.force_mask_keywords` (既定: `["リーク","未公開","機密","confidential","leak"]`) が原文内に名詞として現れた場合にロックされる大分類名の配列です。

## ブラウザ拡張

Claude Code の `ANTHROPIC_BASE_URL` 経由のマスクは Anthropic API を叩く Claude Code / SDK に閉じています。Web 版 Claude.ai / ChatGPT / Gemini / Manus のチャット UI は SDK を介さず直接ブラウザから fetch を投げるため、`BASE_URL` ではカバーできません。そこで用意したのが `browser-extension/` の Chrome MV3 拡張です。

| | `ANTHROPIC_BASE_URL` 方式 | ブラウザ拡張方式 |
|---|---|---|
| 対象 | Claude Code / Anthropic SDK を使うプロセス | Web ブラウザの AI チャット UI |
| カバー範囲 | Anthropic 1 プロバイダ | Claude.ai / ChatGPT / Gemini / Manus |
| 動作原理 | HTTP プロキシ (MITM) | `window.fetch` / `XHR.send` の monkey-patch |
| 認証 | 不要 (クライアントの API キーをパススルー) | なし (ループバック信頼モデル) |
| 追加エンドポイント | 既存 `/proxy/*` | 新規 `POST /v1/extension/sanitize` |

インストールは `make up` でゲートウェイを起動した後、`chrome://extensions` → Developer mode → Load unpacked → `browser-extension/` を選択するだけです。詳細手順・対応状況・既知の制約は [browser-extension/README.md](../browser-extension/README.md) を参照してください。

### インタラクティブ・レビュー (デフォルト ON)

ゲートウェイの検出結果を送信直前に Shadow DOM パネルで表示し、誤検知 (「プロジェクト」や「会社」がカタカナ名ヒューリスティックに巻き込まれた等) はチェックを外して元テキストのまま送信できます。Enter で確定、Esc でキャンセル (送信自体を中止)。ポップアップの「送信前に確認する」チェックを外すと従来どおりの自動マスクモードに戻ります。パネルは `z-index: 2147483647` の固定要素を `document.body` に差し込む Shadow DOM 設計で、ホストページの DOM / CSS には干渉しません。

### UI モード

| モード | 動作 | エンドポイント |
|---|---|---|
| サイドバー (デフォルト) | 画面右側に固定パネル。同じ文字列の重複は `田中太郎 (2件)` のように 1 行へ集約 + カテゴリ折り畳み + 一括 ON/OFF + すべて選択/解除 + リアルタイムプレビュー。`機密` / `未公開` / `リーク` / `confidential` / `leak` などのキーワードが含まれる場合、`force_mask_categories` (デフォルト `PERSON` / `ORGANIZATION` / `FINANCIAL`) に属するカテゴリは ロックアイコン付きでロックされ、長押しゲートでのみ解除できます。 | `POST /v1/extension/sanitize/aggregated` |
| モーダル (従来) | Phase 2 と同じ中央モーダル。1 検出 = 1 行の per-occurrence 表示。 | `POST /v1/extension/sanitize` |

### サイドバー UX

| 機能 | 説明 |
|---|---|
| Push + Shrink レイアウト | サイドバーはチャットに被らず `<body>` 直下の flex sibling として並ぶ。wrapper に `transform: translateZ(0)` + `contain: layout` を付与し、チャットの `position: fixed` composer / header も wrapper 内に閉じ込める。`min(400px, 50vw)` でビューポートに追従 |
| 独立スタッキング | host は `position: relative` + `z-index: 2147483647` + `isolation: isolate`。ホスト側の sticky/fixed 要素がサイドバー上に漏れない |
| モードピル (ヘッダー右) | `AI 置換 (実験的)` / `検出補助 (Regex + AI)` / `Regex のみ` を色分けピル表示 |
| テーマ自動同期 | `getComputedStyle` でホストページの背景色を検出、輝度 < 0.5 で dark palette 適用 |
| Severity フィルタタブ | `All` `Critical` `High` `Medium` `Low` のセグメントコントロール |
| 操作ルール (v0.5.0 確定) | 長押しは critical 行がマスク中のときだけ。critical-unmasked / locked / high / medium / low はすべてワンタップでマスク/解除。長押し時間は 0–1.5s スライダーで調整 |
| Before/After 縦列揃え | 4 列グリッド `[icon] [変更前] [→] [変更後]` で arrow と placeholder 列が全行で揃う。長値は `text-overflow: ellipsis` で切詰 + `title` 属性に全文格納 |
| 緑バー (右側) | マスク OFF 行の右端に 4px 緑バー = この値はそのまま送信される視覚マーカー |
| 除外ボタン | 各行に `✖ 除外` ボタン → `chrome.storage.local.maskAllowlist` に永続登録。次回以降の検出で自動 unmask |
| 出現回数表示 | 行 2 行目に `出現回数 N回` と明示 |
| AI 分析中オーバーレイ | LLM 有効時、サイドバー中央に二重リングスピナー + `AI 分析中…` / `AI 置換中…`。pointer-events 透過で下の regex 行は操作可能。LLM 解決後に行が順次 stagger-in (80ms × index) で現れ、完了直後に overlay フェードアウト |
| AI 検出バッジ | LLM 検出行は (a) 行アイコンが `✨` (紫パルス drop-shadow)、(b) 2 行目に `● AI 検出` 紫グラデピル |
| ユニーク番号タグ (replace モード) | 同じ値は同じタグ、異なる値は異なる番号で 1:1 復元可能マッピング (`<name_1>`, `<name_2>`, `<company_1>` …)。送信先 AI サービスが `<income>` 等を見ても値を復元できないプライバシー保証 |
| カテゴリヘッダーのみのロック | force-masked 由来のロック表示はカテゴリ行にのみ置き、各行には表示しない |

### マスキング除外データベース

`chrome://extensions` → 拡張アイコン右クリック → オプション、もしくはポップアップの「⚙ 詳細設定」ボタンで開く `options.html` で管理:

- 値の追加・削除・全削除
- JSON エクスポート (タイムスタンプ付き) / JSON インポート (重複自動マージ)
- マスキング有効/無効、interactive、UI mode、Gateway 疎通ステータス
- ダークモード自動追従

クロスタブ即時反映: 一方のタブで除外リストに追加すると、`chrome.storage.onChanged` → `content.js` → `injected.js` → `mask-mcp:settings-updated` CustomEvent → 開いている全タブのサイドバーが該当行を即座に unmask + 緑バー表示します。リロード不要。

### 強制マスク (drag-and-drop で追加)

サイドバー上のバー「テキストをここにドラッグしてマスク対象に追加」にチャット画面のテキストをドロップすると、9 カテゴリ (PERSON / LOCATION / ORGANIZATION / CONTACT / FINANCIAL / CREDENTIAL / IDENTITY / INTERNAL_ID / OTHER) の chip から選ぶ popover が出ます。選択するとその値は以降すべての入力で必ず検出され、選択したカテゴリのセクションに表示されます。

- 永続化キー: `chrome.storage.local.maskForceList` (形式: `[{value, category}]`)
- マッチ戦略: **完全一致** (case-sensitive、部分一致・regex なし)
- スコープ: **グローバル** (すべての対応サービスで共通)
- 削除: 対象行の「✖ 削除」ボタンで force list から除去
- severity: カテゴリのデフォルト severity を継承 (PERSON → high, CREDENTIAL → critical, 等)

### Socket.IO (WebSocket) 対応

manus.im など Socket.IO over WebSocket を使うサービスは `fetch` / `XHR` を経由しないため、専用フックで対応しています:

1. `injected.js` の `WebSocket.prototype.send` を wrap
2. Engine.IO v4 EVENT フレーム (`42[...]` / `4213[...]`) をパース
3. `["message", {type:"user_message", contents:[{type:"text", value:"..."}]}]` の `value` フィールドのみマスキング適用
4. ping / pong / CONNECT / DISCONNECT / ACK は素通し
5. ユーザーキャンセル時はそのフレームのみ silent drop (WebSocket は閉じない = chat session 維持)

WebSocket URL に含まれる JWT (manus は `?token=...` で認証) は LOG 出力時に `token` `auth` `key` `sentry_key` 等を `REDACTED` に置換します。診断ログから session 認証情報が漏れないよう設計しています。

## ローカル LLM 連携 (v0.5.0)

ゲートウェイ不要で、ブラウザ拡張 + 手元の Ollama (または LM Studio / llama.cpp) だけで文脈考慮型の PII 検出を追加できます。3 つの動作モードをオプション画面から選択可能:

- `Regex のみ` — LLM 無しの従来挙動
- `検出補助 (Regex + AI)` — LLM が contextual PII を追加、同じ surface は LLM ラベルで上書き。regex は構造化 PII (メール・クレカ・電話) の安全網として残る
- `AI 置換 (実験的)` — LLM が本文全体を `<tag_N>` プレースホルダーに書き換え、送信先 AI サービスに原文が届かない。`applyUniqueTagsToReplace()` が同一 surface に同一タグ、異なる surface に異なる番号を保証

### 最小構成

```bash
# 1) Ollama を CORS 許可付きで起動 (拡張は chrome-extension:// origin を使うため必須)
docker run -d --name ollama --gpus all \
  -e OLLAMA_HOST='0.0.0.0:11434' \
  -e OLLAMA_ORIGINS='*' \
  -p 11434:11434 \
  -v ollama:/root/.ollama \
  --restart unless-stopped \
  ollama/ollama:latest

# 2) モデルを pull (日本語軽量なら qwen3:1.7b、精度重視なら qwen3:4b)
docker exec -it ollama ollama pull qwen3:4b

# 3) 拡張の「⚙ 詳細設定」から
#    - ローカル LLM 連携を有効化
#    - URL に http://localhost:11434
#    - 接続確認 → モデルを選択
```

### アーキテクチャ要点

- Service Worker がプロキシ: Chrome の Private Network Access (PNA) ポリシーは HTTPS ページから `http://localhost` への fetch をブロックするため、LLM コールは全て特権コンテキストである service worker に `LLM_FETCH` メッセージで委譲
- Host-lock: service worker は `chrome.storage.local.localLlmUrl` とホスト/プロトコルが一致する URL 以外を拒否。任意の HTTP プロキシとしては使えない
- Sender-ID 検証: foreign extension から SW への中継は `sender.id !== chrome.runtime.id` で弾かれる
- `think: false` + `format: "json"`: Ollama API リクエストに 3 つの必須パラメータ — `think: false` (Qwen3 系の思考トークン抑止)、`format: "json"` (JSON grammar 制約)、`num_predict: 2048` (生成上限)
- 多段リトライ: (a) `500/503 "loading model"` → 最大 6 回 × 3s 間隔、(b) `AbortError` (推論 stall) → 最大 2 回 × 2s 間隔。inner bridge budget = `timeoutMs × 3 + 30s` で全リトライをカバー
- ユニーク番号タグ: replace モードの出力を `<name_1>`, `<company_2>`, `<hospital_1>` のような 1:1 マッピングで正規化
- Fail-closed on replace / Fail-open on detect: `AI 置換` モードは LLM が 1 件でも失敗すると outbound リクエスト全体を abort、`検出補助` モードは LLM がタイムアウトしても regex/Sudachi 結果のみで残留

### 推奨モデル (v0.5.0+) — **Qwen3 系を前提にチューニング**

検出プロンプトは `browser-extension/engine/llm-prompts.js` で Qwen3 の特性 (JSON grammar 追従、CJK+EN 混在耐性、`<think>` トークン抑止) に合わせて最適化されています。他モデル (Llama3 / Gemma2 / Phi3.5) でも動作しますが、精度と応答速度の安定性で **Qwen3:4b 以上を推奨**。

検出補助モードのシステムプロンプトは、入力によらず 1 通りです。日本語と英語の両方の例を含み、入力の中に書かれた指示には従わないよう、例でも実演しています。出力は値とラベルだけで、理由は書かせません。モデルの大きさや正規表現の検出結果に合わせて組み立てを変える方法も試しましたが、精度が下がったので採用していません。設計と評価の結果は [llm-prompt-optimization.md](./llm-prompt-optimization.md) にあります。

プロンプトを変えたら、実物の LLM で現行版と比べてください。

```bash
node scripts/eval-llm-prompts.mjs --url http://127.0.0.1:11434 --models qwen3:4b,qwen3:1.7b --verbose
node tests/integration/e2e-llm-detect.mjs browser-extension http://127.0.0.1:11434 qwen3:1.7b
```

| Model | Size | VRAM | Badge |
|---|---|---|---|
| `qwen3:1.7b` | 1.1 GB | ~1.5 GB | 軽量 |
| `qwen3:4b` | 2.5 GB | ~3 GB | **推奨** |
| `qwen3:8b` | 4.7 GB | ~5 GB | 高精度 |
| `qwen3:14b` | 8.2 GB | ~9 GB | 最高精度 |
| `gemma3:4b` | 2.5 GB | ~3 GB | 代替 |
| `llama3.2:3b` | 2.0 GB | ~2 GB | 代替 |
| `phi3.5:3.8b` | 2.2 GB | ~2.5 GB | 代替 |

オプション画面からワンクリックのダウンロード (`POST /api/pull` ストリーミング NDJSON で進捗バー付き) / 削除 (`DELETE /api/delete` 確認ダイアログあり) が可能です。使用中モデルを削除した場合は `localLlmModel` 選択も自動クリアされます。

### 既知の制約

| 症状 | 原因 | 対処 |
|---|---|---|
| 403 (CORS) が返る | Ollama の `OLLAMA_ORIGINS` 未設定 | docker-compose に `OLLAMA_ORIGINS: "*"` を追加。オプション画面の「接続確認」が自動検知して remediation alert を表示 |
| コールドスタートで遅い | 4B+ モデルは初回 20–40s、9B+ thinking は 60–90s | タイムアウトを 120000ms (デフォルト) ~ 240000ms で調整 |
| LLM が `エンジニア` `アクセスキー` など一般語を検出 | モデル側の過検出 | プロンプト `HARD NEGATIVE LIST` + クライアント `LLM_DENYLIST` / `LLM_DENY_REGEX` |
| 検出結果が出ない (Qwen3) | 旧実装で `think: true` デフォルトがトークン budget を消費 | 現行は `think: false` 明示。リロードで解消 |

詳細な設定・ログ例・セキュリティ設計は [browser-extension/README.md#local-llm-proxy-v050-experimental](../browser-extension/README.md#local-llm-proxy-v050-experimental) を参照。

## Claude Code / Claude Desktop 連携

ゲートウェイを Claude Code / Claude Desktop と組み合わせて、Enter を押すだけで自動的に PII をマスクしてから Anthropic に送信する構成を作れます。

### 方法 1: Claude Code — `ANTHROPIC_BASE_URL` (ストリーミング対応)

Claude Code 内部の Anthropic SDK は `ANTHROPIC_BASE_URL` 環境変数でエンドポイントを上書きできます。ゲートウェイの `/proxy/anthropic` を指定すると、全 API コールがゲートウェイ経由になり、ユーザの入力テキスト内の PII がマスクされてから Anthropic に転送されます。

```bash
make up
ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude

alias claude-safe='ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude'
```

データフロー:

```
あなたの入力 (Enter)
  → Claude Code SDK → http://127.0.0.1:8081/proxy/anthropic/v1/messages
  → ゲートウェイが messages[] 内の PII をマスク
  → マスク済みペイロードを https://api.anthropic.com/v1/messages に転送
  → ストリーミング応答がそのままパススルーで返る
```

`stream: true` リクエスト (Claude Code のデフォルト) はゲートウェイが SSE チャンクをそのまま中継するため、通常と同じ打鍵感でトークンが表示されます。`x-api-key` はクライアントが付けたものをそのまま転送 (ゲートウェイにはキー不要)。

### 方法 2: Claude Desktop — MCP サーバ登録

Claude Desktop は MCP (Model Context Protocol) でツールを提供するサーバを登録できます。このプロジェクトの MCP サーバは以下のツールを公開しています:

| ツール | 説明 |
|---|---|
| `sanitize_text(text, mask_strategy)` | テキストの PII を検出してマスク |
| `detect_language(text)` | ja / en / mixed 判定 |
| `set_analyzer_config(...)` | アナライザ設定を変更 |
| `set_provider(provider_id)` | 転送先プロバイダを切替 |
| `toggle_filter(enabled)` | フィルタ ON/OFF |
| `get_runtime_config()` | 現在の設定を取得 |

設定手順:

1. ラッパースクリプトに実行権限を付与 (初回のみ)

   ```bash
   chmod +x scripts/mcp-stdio.sh
   ```

2. `claude_desktop_config.json` に追加
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`

   WSL の場合 (Claude Desktop は Windows 側で動作するため `wsl` 経由で呼ぶ):

   ```json
   {
     "mcpServers": {
       "pii-guard": {
         "command": "wsl",
         "args": ["bash", "/home/<user>/workspace/pii-guard/scripts/mcp-stdio.sh"]
       }
     }
   }
   ```

   Mac / ネイティブ Linux の場合 (直接実行):

   ```json
   {
     "mcpServers": {
       "pii-guard": {
         "command": "/absolute/path/to/pii-guard/scripts/mcp-stdio.sh"
       }
     }
   }
   ```

3. Claude Desktop を再起動すると、ツール一覧に `sanitize_text` 等が現れます。

方法 1 (Base URL) が全リクエストを自動的にマスクするのに対し、MCP は Claude がツールを呼ぶタイミングでだけマスクされる違いがあります。必ずマスクしたいなら方法 1、必要なときだけマスクしたいなら方法 2 が向いています。

## Chrome Web Store 公開ビルド

`browser-extension/` は dev ビルドで、ローカル LLM プロキシ、`http://*/*` host permission、options ページの LLM 設定カードが含まれます。これらは Store には一切出ない設計です。

Store 向けの配布物は `scripts/build-store.sh` で生成します:

```bash
./scripts/build-store.sh
# → dist/browser-extension-store/         (unpacked, Load unpacked 可能)
# → dist/browser-extension-store.zip      (Developer Dashboard アップロード用)
```

ビルドスクリプトの処理:

1. `browser-extension/` → `dist/browser-extension-store/` にコピー
2. `manifest.json` を `manifest.store.json` に置換 (`http://*/*` なし、6 chat-provider ホストのみ)
3. `engine/surrogates.js` + `engine/llm-prompts.js` を削除
4. `STORE-STRIP:START … STORE-STRIP:END` ブロックを `sed` で除去 (HTML と JS 両方のコメント形式に対応)
5. 検証: `http://*/*` が manifest に残っていない、marker が残っていない、削除ファイルへの参照なし、manifest が JSON valid、全 `.js` が `node --check` を通る
6. Store Dashboard 用に zip 化

詳細は [browser-extension/README.md#building-the-chrome-web-store-variant](../browser-extension/README.md#building-the-chrome-web-store-variant) を参照してください。

## テスト

テストは Docker のビルドステージで走らせます。ホストに何もインストールする必要はありません。

```bash
make test
# 内部で: docker build --target test --progress=plain -t local-mask-mcp:test .
```

`Dockerfile` の `test` ステージは `builder` を引き継ぎ、dev 依存 (pytest / pytest-asyncio / ruff) と spaCy モデル、tesseract を追加してから `uv run pytest tests/ -v` を実行します。どれか 1 本でもテストが落ちるとビルドが失敗するので、CI ゲートとしてそのまま使えます。通常の `make up` / `docker compose build` はこのステージをスキップします。

## ディレクトリ構成

```text
pii-guard/
├── browser-extension/          Chrome MV3 拡張 (dev ビルド)
│   ├── manifest.json           dev manifest (http://*/*, LLM engine files 全部入り)
│   ├── manifest.store.json     Web Store 配布用 manifest (LLM 関連なし)
│   ├── content.js              isolated-world bridge + LLM_FETCH ルーティング
│   ├── injected.js             main-world fetch/XHR/WebSocket フック
│   ├── sidebar.js              Shadow DOM サイドバー UI
│   ├── review-modal.js         Shadow DOM レビューモーダル UI
│   ├── background.js           service worker (badge + per-tab count + LLM proxy)
│   ├── options.html/css/js     設定ページ (allowlist, LLM 設定, UI モード)
│   ├── popup.html/css/js       ツールバー popup
│   └── engine/                 standalone JS engine
│       ├── engine.js             sweep-line overlap resolver + pipeline
│       ├── patterns.js           BUILTIN_PATTERNS (regex プリセット)
│       ├── classification.js     label → classification (contact / identifier / ...)
│       ├── categories.js         label → big category (PERSON / LOCATION / ...)
│       ├── severity.js           label → severity tier + surface-aware 昇格
│       ├── ts-sudachi.js         mini Sudachi-like 日本語形態素解析
│       ├── force-mask.js         force_mask_keywords ロック判定
│       ├── blocklist.js          DEFAULT_COMMON_NOUN_BLOCKLIST
│       ├── surrogates.js         (dev only) 型保存 fake values
│       ├── llm-prompts.js        (dev only) /no_think system prompt + few-shot
│       └── bundle.js             UMD bundle
├── src/
│   ├── app/
│   │   ├── config.py
│   │   ├── main.py
│   │   ├── models/schemas.py
│   │   ├── routes/               admin.py / proxy.py / sanitize.py
│   │   └── services/
│   │       ├── masking_service.py
│   │       ├── analyzers/        base.py / presidio.py / sudachi.py / regex.py / presets.py
│   │       ├── category_map.py
│   │       ├── classification.py
│   │       ├── severity.py
│   │       ├── aggregation.py
│   │       ├── force_mask.py
│   │       ├── language_detection.py
│   │       ├── document_service.py
│   │       ├── ocr_service.py
│   │       ├── proxy_service.py
│   │       └── repositories.py
│   └── mcp_server/server.py
├── scripts/
│   ├── build-store.sh          Web Store ビルドパイプライン
│   ├── install-autostart.sh    Linux/WSL2 gateway autostart
│   ├── install-autostart.ps1   Windows gateway autostart
│   ├── mcp-stdio.sh            MCP stdio ラッパー (Docker 経由起動)
│   └── generate-icons.py       拡張アイコン生成
├── tests/                      pytest スイート
├── docs/                       要件定義・設計ドキュメント
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── uv.lock                     依存ロック (repo にコミット)
├── CHANGELOG.md                ルート CHANGELOG (ゲートウェイ側)
├── TODO.md                     ロードマップ
└── README.md                   このファイル
```
