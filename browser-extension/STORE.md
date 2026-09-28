# Chrome Web Store 提出用素材

v1.1.0 (standalone-only、辞書 fallback + ドラッグ追加機能) を Chrome Web Store に提出するための素材まとめ。

## ストア掲載情報

### 名前
PII Guard

### 短い説明 (132 文字以内)
個人情報(電話番号・メール・住所・名前・APIキー等)を AI チャット送信前に自動検出してマスキング。完全オフライン動作。

### 詳しい説明
ChatGPT / Claude / Gemini / Manus などの AI チャットに個人情報を送信する前に、ローカルで自動検出・マスキングするブラウザ拡張機能です。

**主な機能**
- 40+ カテゴリの PII を正規表現で検出 (電話、メール、住所、マイナンバー、API キー、銀行口座、クレカ、年収、血液型、契約番号 等)
- 静的辞書 fallback (v1.1.0 新): 日本人苗字 top 50 / 47 都道府県 / 政令指定都市 20 / 主要国名 / Western first names
- 30+ ベンダー固有 API キー (OpenAI / Anthropic / GitHub / AWS / Slack / Google / Stripe / Perplexity / OpenRouter 等)
- 都道府県+市区町村単体を別カテゴリで検出 (兵庫県明石市 等)
- **ドラッグ & ドロップで任意の文字列をマスク対象に追加** (v1.1.0 新): サイドバーへドラッグ → カテゴリを 9 種から選択 → リアルタイムで即反映。既検出値をドラッグすると該当行へスクロール + ハイライト
- カテゴリはデフォルト折りたたみ表示、一括展開トグルあり (v1.1.0 新)
- Claude.ai の相対 URL 送信にも対応 (v1.1.0 修正)
- 「機密」「リーク」等のキーワード自動ロック (会社名・人名・財務情報)
- 送信直前のレビューサイドバー (重要度別タブ + 個別 ON/OFF + プレビュー)
- マスキング除外リストの永続管理 (JSON エクスポート/インポート対応)
- ホストページの背景色に追従するテーマ自動切替
- WebSocket チャット (Socket.IO) も対応

**プライバシー**
- すべての処理はブラウザ内で完結 (オフライン動作)
- 入力テキスト・検出結果は外部送信されません
- 拡張機能は対象 5 サイト (claude.ai / chatgpt.com / openai.com / gemini.google.com / manus.im) でのみ動作

**対応サービス**
- Claude (claude.ai)
- ChatGPT (chatgpt.com)
- Gemini (gemini.google.com)
- Manus (manus.im)
- OpenAI 各サービス (\*.openai.com)

### カテゴリ
- メイン: 仕事効率化 (Productivity)
- サブ: ソーシャル&コミュニケーション

### 言語
日本語 (主要) / English (副次)

## スクリーンショット (1280×800 推奨、最大 5 枚)

撮影手順:
1. `chrome://extensions` で developer mode → Load unpacked → `browser-extension/`
2. 各サイトで「テスト 09012345678 taro@example.com 株式会社アクメ」を入力
3. インタラクティブモードで sidebar が開いた状態をキャプチャ
4. 解像度: 1280×800 もしくは 640×400

撮影候補:
- (1) sidebar 全体 (manus.im light theme)
- (2) sidebar 全体 (chatgpt.com dark theme) — テーマ自動追従の証拠
- (3) Critical タブ + ロック行 (🔒)
- (4) options ページ (除外リスト管理)
- (5) before/after の行表示クローズアップ

## アイコン

- 16×16 / 48×48 / 128×128 — `icons/` 既存
- ストア用 128×128 PNG: `icons/icon128.png` をそのまま使用可

## プライバシーポリシー URL

`PRIVACY.md` (リポジトリ同梱) もしくは GitHub Pages 等で公開した URL を提出。

## ビルド

```bash
cd browser-extension
zip -r ../pii-guard-v1.0.0.zip . -x "*.md" "test-*" "scripts/*"
```

`STORE.md`, `README.md`, `CHANGELOG.md` はバンドルに含めない。

## ストア審査対応メモ

- **Permission justification**:
  - `storage`: ユーザー設定 + 除外リスト永続化
  - `activeTab`: 検出件数バッジ更新
  - `host_permissions` (5 サイト): content script 注入対象
- **Single purpose**: AI チャット入力時の個人情報マスキング
- **Remote code**: 一切なし(完全 bundle、CDN 依存なし)
- **Data usage**:
  - 個人情報: 検出のみ、外部送信なし
  - chrome.storage に保存される: 設定・除外リスト・タブ毎カウンタ
