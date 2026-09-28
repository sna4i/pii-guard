# PII Guard v0.5.0 — ローカル LLM プロキシ連携機能 設計プラン

- **作成日**: 2026-04-16
- **対象ブランチ**: `feat/local-llm-proxy-v0.5.0` (from `main`)
- **拡張機能表示バージョン**: `0.5.0` (manifest.json の `version` フィールドは `1.1.0` へ bump ※後述)
- **ステータス**: 初版 — 実装前レビュー待ち

---

## 0. 背景と目的

現状の PII Guard は「regex + 形態素解析 (SudachiPy/Presidio) → プレースホルダー置換」という静的検出方式。  
本機能追加では **任意 URL で Ollama 互換 API に接続し、LLM による文脈考慮型検出・自然言語置換を重ね合わせる** モードを追加する。

- URL 未設定 / 接続失敗時は既存フローに完全フォールバック (後退互換保証)
- LLM URL を設定した瞬間から「形態素解析 + LLM ハイブリッド」に切り替わる
- 既存の `force_mask_keywords`, `maskAllowlist`, severity escalation は LLM パスでも尊重する

---

## 1. 要件一覧

### 1.1 機能要件

| ID | 要件 | 優先度 |
|---|---|---|
| F-001 | options.html に「ローカル LLM」セクションを追加。Ollama 互換エンドポイント URL を入力・保存できる | Must |
| F-002 | URL 入力直後にヘルスチェック (`/api/tags` または `/api/version`) を実行し、接続状態 (接続中 / 失敗 / 未設定) をリアルタイム表示する | Must |
| F-003 | `/api/tags` で取得したモデル一覧を dropdown に表示し、使用モデルを選択・保存できる。手動入力も許可する | Must |
| F-004 | LLM URL が設定済みかつ接続可能な場合、マスキングパイプラインに LLM 補助検出フェーズを追加する (Phase 2) | Must |
| F-005 | LLM 接続失敗・タイムアウト (デフォルト 8 秒) 時は既存 regex/Sudachi フローに自動フォールバックし、ユーザーに警告を表示する | Must |
| F-006 | LLM が検出した PII エンティティを既存 regex 検出結果とマージし、重複排除する | Must |
| F-007 | Phase 3 として「自然言語置換モード」を提供。LLM がプレースホルダーではなくフィクション値 (例: 「田中太郎」→「山田花子」) で書き換えたテキストを生成する | Should |
| F-008 | サイドバーに LLM 置換結果の diff ビュー (元テキスト / プレースホルダー / LLM 置換テキスト) を表示する (Phase 3) | Should |
| F-009 | popup.html に LLM 接続状態インジケーター (ドット + ラベル) を追加する | Should |
| F-010 | `chrome.storage.local` に保存するキー: `localLlmUrl`, `localLlmModel`, `localLlmEnabled`, `localLlmMode` (`"detect"` \| `"replace"`) | Must |
| F-011 | `maskAllowlist` に登録済みの値は LLM がマスク対象として返してきた場合でも除外する | Must |
| F-012 | `force_mask_keywords` でロックされたカテゴリは LLM 出力に関わらず強制マスクを維持する | Must |
| F-013 | background.js の `DETECTION_COUNT` メッセージに LLM 検出分を加算する | Must |

### 1.2 非機能要件

| ID | 要件 | 目標値 |
|---|---|---|
| NF-001 | LLM 検出フェーズのタイムアウト | ≤ 8 秒 (ユーザー設定可、デフォルト 8s) |
| NF-002 | LLM URL 未設定時のオーバーヘッド | 0 ms (コードパス分岐で完全スキップ) |
| NF-003 | ローカル LLM への通信はユーザー指定 URL のみ。外部サーバーへ自動送信しない | 必須 |
| NF-004 | Mixed-content 問題: HTTPS ページから HTTP Ollama への fetch を可能にする | Chrome MV3 `host_permissions` で解決 (後述) |
| NF-005 | `manifest.json` の `host_permissions` 変更は最小範囲に留める | `http://localhost/*`, `http://127.0.0.1/*` のみ追加 |
| NF-006 | プライバシーポリシーに「ローカル LLM サーバーへの送信はローカルネットワーク内通信であり第三者に共有されない」旨を追記 | リリース前 |
| NF-007 | LLM プロンプトにユーザー入力原文を含める。外部 API キーや認証情報が含まれている可能性があるためプロンプトをログ出力しない | 必須 |

---

## 2. 技術選定

### 2.1 Ollama API エンドポイント選択

| 用途 | エンドポイント | 備考 |
|---|---|---|
| ヘルスチェック / バージョン確認 | `GET /api/version` | 軽量。`/api/tags` より安定 |
| モデル一覧取得 | `GET /api/tags` | `models[].name` を dropdown に使用 |
| **PII 検出 (Phase 2)** | `POST /api/generate` | `stream: false`, JSON mode |
| **自然言語置換 (Phase 3)** | `POST /api/generate` | `stream: true` + サイドバー進捗表示 |

OpenAI 互換エンドポイント (`/v1/chat/completions`) を持つ llama.cpp server / vLLM / LM Studio の場合は同じ URL で動作する (フォールバック判定: `/api/version` 失敗 → `/v1/models` を試行)。

### 2.2 プロンプト構造 (Phase 2: 検出モード)

```
System:
あなたは PII (個人識別情報) 検出の専門家です。
ユーザーが入力したテキストから PII を JSON 形式で返してください。

出力 JSON スキーマ (必ずこの形式のみ):
{
  "entities": [
    {
      "text": "<検出したテキスト>",
      "entity_type": "<PERSON|EMAIL|PHONE|ADDRESS|COMPANY|CREDIT_CARD|IP_ADDRESS|DATE_OF_BIRTH|FINANCIAL|CREDENTIAL|CUSTOM>",
      "start": <文字オフセット>,
      "end": <文字オフセット>,
      "confidence": <0.0〜1.0>
    }
  ]
}

ルール:
- `maskAllowlist` に含まれる値は返さない (システムが注入)
- 存在しない PII は空配列で返す
- JSON 以外のテキストは一切出力しない

Few-shot 例:
Input: "田中太郎です。メールは tanaka@example.com です。"
Output: {"entities":[{"text":"田中太郎","entity_type":"PERSON","start":0,"end":4,"confidence":0.95},{"text":"tanaka@example.com","entity_type":"EMAIL","start":9,"end":27,"confidence":0.99}]}

User:
{ユーザー入力テキスト}
```

### 2.3 プロンプト構造 (Phase 3: 自然言語置換モード)

```
System:
あなたは PII を自然なフィクション値で書き換えるアシスタントです。
以下の PII を書き換えたテキストを返してください。

書き換えリスト (JSON):
{replacements: [{original:"田中太郎", type:"PERSON"}, ...]}

ルール:
- フィクション値は実在しない人物名・アドレス・電話番号を使う
- 文章の自然さを保つ
- 書き換え後のテキスト本文のみ出力する (JSON 不要)

User:
{元テキスト}
```

### 2.4 出力 JSON スキーマ (Phase 2)

```typescript
interface LlmDetectionResult {
  entities: Array<{
    text: string;
    entity_type: string;   // PERSON | EMAIL | ... (既存カテゴリと統一)
    start: number;
    end: number;
    confidence: number;    // 0.0–1.0
  }>;
}
```

### 2.5 Mixed-Content 解決策

**問題**: HTTPS ページ (claude.ai 等) から `http://localhost:11434` へのフェッチは Mixed Content としてブロックされる。

**解決策**: `manifest.json` の `host_permissions` に追加:

```json
"host_permissions": [
  "https://claude.ai/*",
  "https://*.claude.com/*",
  "https://chatgpt.com/*",
  "https://*.openai.com/*",
  "https://gemini.google.com/*",
  "https://*.manus.im/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
]
```

- `http://localhost/*` と `http://127.0.0.1/*` は Chrome Web Store のポリシー上「ローカルホストアクセス」として許可される (過度に広い `http://*/*` ではない)
- Ollama のデフォルト `11434` だけでなく任意ポートをカバーするため `/*` を使用
- content.js (isolated world) から `chrome.storage.local` に保存した URL を読み取り、`fetch()` は isolated world 側で実行する (MAIN world の injected.js は postMessage 経由でリクエスト)

**注意**: `host_permissions` を変更すると Chrome Web Store の再審査が発生する。本 PR で初回追加するため、以降は原則変更しない前提でスコープを設計する。

---

## 3. データフロー図

### 3.1 現状フロー (v0.4.0)

```
[AI サービス HTTPS ページ]
  |
  | (injected.js が window.fetch/XHR をフック)
  v
[サービス別アダプタ] ─── user input 抽出
  |
  |─── [standalone モード] ──────────────────────────────────┐
  |      engine/*.js (regex 30+ カテゴリ)                     |
  |      → プレースホルダー <EMAIL_1>, <PHONE_1> 置換           |
  |                                                           |
  |─── [gateway モード] ────────────────────────────────────┐ |
  |      POST http://127.0.0.1:8081/v1/extension/sanitize/   | |
  |      aggregated                                           | |
  |      ← { aggregated: [...], force_masked_categories }    | |
  |                                                           | |
  v                                                           v v
[sidebar.js] ─── レビュー UI (Shadow DOM)
  |
  | (ユーザー確認後)
  v
[元の AI サービス API] ─── マスク済みリクエスト送信
```

### 3.2 v0.5.0 追加フロー (LLM 分岐)

```
[AI サービス HTTPS ページ]
  |
  | (injected.js が window.fetch/XHR をフック)
  v
[サービス別アダプタ] ─── user input 抽出
  |
  | postMessage → content.js (isolated world)
  v
[content.js] ─── chrome.storage.local からモード判定
  |
  |─── localLlmUrl 未設定 / localLlmEnabled=false ──────────┐
  |       既存フロー (standalone / gateway) へ                |
  |                                                           |
  |─── localLlmUrl 設定済み && localLlmEnabled=true ────────┐|
  |                                                          ||
  |   [Phase 1] ヘルスチェック (キャッシュ済みなら省略)        ||
  |       失敗 → フォールバック + 警告メッセージ              ||
  |       成功 ↓                                             ||
  |                                                          ||
  |   [Phase 2] LLM 検出フェーズ                             ||
  |   POST {localLlmUrl}/api/generate                        ||
  |   body: { model, prompt: systemPrompt+userText,          ||
  |            format: "json", stream: false }               ||
  |   timeout: localLlmTimeoutMs (default 8000)              ||
  |       失敗/timeout → フォールバック + 警告               ||
  |       成功 ↓                                             ||
  |   LLM entities + regex entities をマージ                 ||
  |   → allowlist フィルタ適用                               ||
  |   → force_mask_keywords ロック適用                       ||
  |   → severity_for_surface escalation 適用                 ||
  |                                                          ||
  |   [Phase 3 / localLlmMode="replace"]                     ||
  |   POST {localLlmUrl}/api/generate                        ||
  |   body: { model, prompt: replacePrompt,                  ||
  |            stream: true }                                 ||
  |   → 自然言語置換テキストをストリーミング生成              ||
  |   → sidebar.js に diff ビュー用データとして渡す           ||
  |                                                          ||
  v                                                          vv
[sidebar.js] ─── レビュー UI (Shadow DOM)
  |              [Phase 2] 通常の aggregated ビュー (LLM 検出分にバッジ追加)
  |              [Phase 3] diff ビュー (元テキスト / プレースホルダー / LLM 置換)
  |
  | (ユーザー確認後)
  v
[元の AI サービス API] ─── マスク済みリクエスト送信
```

---

## 4. 段階実装プラン

### Phase 1: URL 設定 + ヘルスチェック + モデル選択 UI

**目標**: Ollama URL を設定し接続状態を確認できる状態にする。マスキングロジックはまだ変更しない。

**変更ファイル**:

| ファイル | 変更内容 |
|---|---|
| `browser-extension/manifest.json` | `version` を `1.1.0` に bump。`host_permissions` に `http://localhost/*`, `http://127.0.0.1/*` を追加 |
| `browser-extension/options.html` | 「ローカル LLM 連携」セクションを末尾に追加 (F-001, F-002, F-003) |
| `browser-extension/options.js` | `localLlmUrl`, `localLlmModel`, `localLlmEnabled`, `localLlmMode` の読み書き。`/api/version` ヘルスチェック関数。`/api/tags` モデル一覧取得関数 |
| `browser-extension/popup.html` | LLM 接続状態インジケーター追加 (F-009) |
| `browser-extension/popup.js` | `chrome.storage.local` から `localLlmUrl` / 接続状態を読み表示 |
| `browser-extension/background.js` | `chrome.runtime.onInstalled` で `localLlmEnabled: false`, `localLlmMode: "detect"` を初期化 |

**options.html 追加 UI 仕様** (F-001〜F-003):

```
<section class="card">
  <h2>ローカル LLM 連携 <span class="badge-new">v0.5.0</span></h2>
  <p class="hint">
    Ollama / llama.cpp / LM Studio など OpenAI 互換 API の URL を入力すると、
    形態素解析に加えて LLM による文脈考慮型 PII 検出が有効になります。
    URL 未設定の場合は従来のオフライン検出のみが動作します。
  </p>

  <!-- LLM 機能の有効/無効トグル -->
  <div class="form-row">
    <label class="form-label" for="opt-llm-enabled">LLM 補助検出</label>
    <label class="switch">
      <input type="checkbox" id="opt-llm-enabled" />
      <span class="slider"></span>
    </label>
  </div>

  <!-- エンドポイント URL -->
  <div class="form-row">
    <label class="form-label" for="llm-url">エンドポイント URL</label>
    <input type="url" id="llm-url"
           placeholder="http://localhost:11434"
           class="input-field" />
    <button id="llm-check-btn" class="btn-secondary">接続確認</button>
  </div>

  <!-- 接続状態 pill -->
  <div class="form-row" id="llm-status-row" style="display:none">
    <span class="form-label">接続状態</span>
    <span id="llm-status-pill" class="status-pill">確認中...</span>
    <span id="llm-version-label" class="hint"></span>
  </div>

  <!-- モデル選択 -->
  <div class="form-row" id="llm-model-row" style="display:none">
    <label class="form-label" for="llm-model">使用モデル</label>
    <select id="llm-model" class="input-field"></select>
    <input type="text" id="llm-model-manual"
           placeholder="モデル名を直接入力 (例: llama3:8b)"
           class="input-field" style="margin-top:4px" />
  </div>

  <!-- 動作モード -->
  <div class="form-row" id="llm-mode-row" style="display:none">
    <span class="form-label">動作モード</span>
    <fieldset class="radios">
      <label>
        <input type="radio" name="llm-mode" value="detect" />
        検出補助 (LLM がプレースホルダーを追加検出)
      </label>
      <label>
        <input type="radio" name="llm-mode" value="replace" />
        自然言語置換 (LLM がフィクション値で書き換え) <span class="badge-experimental">試験的</span>
      </label>
    </fieldset>
  </div>

  <!-- タイムアウト設定 -->
  <div class="form-row" id="llm-timeout-row" style="display:none">
    <label class="form-label" for="llm-timeout">LLM タイムアウト</label>
    <input type="number" id="llm-timeout" min="2" max="30" value="8"
           class="input-field" style="width:80px" />
    <span class="hint">秒 (2〜30)</span>
  </div>
</section>
```

**接続状態 pill の状態遷移**:

| 状態 | クラス | テキスト |
|---|---|---|
| 未設定 | `status-off` | 未設定 |
| 確認中 | `status-checking` | 接続確認中... |
| 接続済み | `status-ok` | 接続中 (Ollama v0.x.x) |
| 失敗 | `status-error` | 接続失敗 |

### Phase 2: LLM 補助検出 (ハイブリッドモード)

**目標**: URL 設定済み + `localLlmEnabled=true` のとき、regex 検出結果に LLM 検出結果をマージして sidebar に表示する。フォールバック必須。

**変更ファイル**:

| ファイル | 変更内容 |
|---|---|
| `browser-extension/content.js` | `callLocalLlm(text, settings)` 非同期関数を追加。タイムアウト + フォールバック制御 |
| `browser-extension/content.js` | `SANITIZE_REQUEST` ハンドラに LLM フェーズを挿入。結果を merged entities として返す |
| `browser-extension/engine/engine.js` | `mergeWithLlmEntities(baseEntities, llmEntities, allowlist)` 関数を追加 |
| `browser-extension/sidebar.js` | LLM 由来エンティティに `"source": "llm"` バッジを表示する UI 変更 |

**`callLocalLlm` 関数仕様** (content.js に追加):

```javascript
// content.js に追加
async function callLocalLlm(text, settings) {
  // settings: { localLlmUrl, localLlmModel, localLlmTimeoutMs, maskAllowlist }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.localLlmTimeoutMs || 8000);
  try {
    const prompt = buildDetectPrompt(text, settings.maskAllowlist || []);
    const resp = await fetch(`${settings.localLlmUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.localLlmModel,
        prompt,
        format: "json",
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
    const data = await resp.json();
    const parsed = JSON.parse(data.response || "{}");
    return (parsed.entities || []).map(e => ({ ...e, source: "llm" }));
  } catch (err) {
    console.warn("[mask-mcp] LLM fallback:", err.message);
    return null; // null = フォールバック
  } finally {
    clearTimeout(timer);
  }
}
```

**エンティティマージ戦略**:

1. regex/Sudachi 検出結果を base とする
2. LLM エンティティのうち、`text` が `maskAllowlist` に含まれるものを除外
3. オフセット重複チェック: base エンティティと 50% 以上重複するなら LLM エンティティを捨てる (既存検出優先)
4. 残った LLM エンティティを追加し `source: "llm"` フラグを付与
5. `force_mask_keywords` によるロックは全エンティティに適用

**sidebar.js での LLM バッジ表示**:

- `source === "llm"` のエンティティ行に `<span class="badge-llm">AI</span>` を追加
- スタイル: 紫系背景 (`#7c3aed`)、白文字、角丸 `2px`
- Critical long-press ガード・force-mask ロックは既存ロジックをそのまま流用

### Phase 3: 自然言語置換モード (試験的)

**目標**: LLM が生成したフィクション値でプレースホルダーを置換し、diff ビューをサイドバーに表示する。

**変更ファイル**:

| ファイル | 変更内容 |
|---|---|
| `browser-extension/content.js` | `callLocalLlmReplace(text, entities, settings)` 非同期関数を追加 |
| `browser-extension/sidebar.js` | diff ビューの実装。3 タブ (原文 / プレースホルダー / LLM 置換) を切り替え可能に |

**サイドバー diff ビュー仕様**:

```
┌─────────────────────────────────────────────┐
│  PII Guard — 送信前確認          [閉じる ×]  │
│─────────────────────────────────────────────│
│  [原文] [プレースホルダー] [AI 置換] ← タブ   │
│─────────────────────────────────────────────│
│  ▌ PERSON (critical)  🤖 AI                  │
│  田中太郎 → [PERSON_1] → 山田花子             │
│─────────────────────────────────────────────│
│  ▌ EMAIL (high)                              │
│  tanaka@example.com → [EMAIL_1] → ...        │
│─────────────────────────────────────────────│
│              [送信] [キャンセル]               │
└─────────────────────────────────────────────┘
```

- タブ「AI 置換」は `localLlmMode === "replace"` かつ LLM 応答が成功した場合のみ有効
- 「送信」ボタン押下時は選択中のタブに対応するテキストを使用
  - 「プレースホルダー」タブ: 従来の `<EMAIL_1>` 形式
  - 「AI 置換」タブ: LLM 生成テキスト

---

## 5. バージョニング戦略

### 5.1 manifest.json の `version` フィールド

Chrome 拡張の `version` フィールドは `major.minor.patch` で単調増加が必須。  
現在 `"version": "1.0.0"` のため `"0.5.0"` にはダウングレードできない。

**採用方針**: `manifest.json` の `version` を `"1.1.0"` にして、**options.html / popup.html の表示ラベル**を `"v0.5.0"` にする。

```json
// manifest.json
{
  "version": "1.1.0",
  ...
}
```

```html
<!-- options.html -->
<span class="version" id="version">v0.5.0</span>
```

```javascript
// options.js で動的に設定することも可
const DISPLAY_VERSION = "0.5.0";
```

これによりユーザー向けバージョンは `0.5.0` を名乗りつつ、Chrome Web Store の `version` 要件を満たす。

### 5.2 Chrome Web Store 再審査トリガー

| 変更 | 再審査 | 備考 |
|---|---|---|
| `host_permissions` に `http://localhost/*` 追加 | 発生 | 初回のため許容。審査期間 1〜7 日 |
| `web_accessible_resources` の変更 | 軽微 | 新規 JS ファイル追加時 |
| `version` bump | 通常 | 毎回発生 |

### 5.3 開発ブランチ

```
main
└── feat/local-llm-proxy-v0.5.0   ← 本 PR
    ├── Phase 1: URL 設定 UI
    ├── Phase 2: LLM ハイブリッド検出
    └── Phase 3: 自然言語置換 (試験的)
```

---

## 6. テスト観点

### 6.1 Unit テスト

| ID | テスト対象 | 観点 | 期待結果 |
|---|---|---|---|
| T-001 | `callLocalLlm` | LLM URL 未設定時 | 即座に `null` を返す (fetch 呼ばない) |
| T-002 | `callLocalLlm` | タイムアウト (8s) | `null` を返し、コンソールに fallback 警告 |
| T-003 | `callLocalLlm` | HTTP 500 応答 | `null` を返す |
| T-004 | `callLocalLlm` | 正常応答 | `entities[]` に `source: "llm"` が付与される |
| T-005 | `mergeWithLlmEntities` | base と LLM が同一テキストを検出 | 重複排除され 1 件のみ残る |
| T-006 | `mergeWithLlmEntities` | LLM が allowlist 内テキストを検出 | 除外される |
| T-007 | `mergeWithLlmEntities` | LLM が force_mask カテゴリを検出 | ロック状態で追加される |
| T-008 | `buildDetectPrompt` | allowlist に値がある場合 | プロンプト内に除外指示が含まれる |
| T-009 | options.js | URL 入力後の `/api/version` 呼び出し | status-pill が `status-ok` に変わる |
| T-010 | options.js | 接続失敗時 | status-pill が `status-error` に変わる |
| T-011 | options.js | `/api/tags` 成功時 | dropdown にモデル一覧が表示される |

### 6.2 統合テスト (手動)

| ID | シナリオ | 確認手順 | 期待結果 |
|---|---|---|---|
| T-020 | Phase 1: Ollama 未起動状態で URL 設定 | options で `http://localhost:11434` を入力 → 接続確認 | `status-error` pill、エラーメッセージ表示 |
| T-021 | Phase 1: Ollama 起動後 URL 設定 | `ollama serve` → options で URL 設定 → 接続確認 | `status-ok` pill、バージョン表示、モデル dropdown 表示 |
| T-022 | Phase 2: LLM 補助検出 | claude.ai で「田中太郎のメールは tanaka@example.com」を入力 | サイドバーに PERSON + EMAIL (AI バッジ付き) が表示 |
| T-023 | Phase 2: フォールバック | LLM タイムアウト状態で入力 | サイドバーに regex 検出結果のみ表示。警告トースト表示 |
| T-024 | Phase 2: allowlist 適用 | allowlist に「田中太郎」追加後に入力 | LLM が PERSON として検出しても表示されない |
| T-025 | Phase 3: 自然言語置換 | replace モードで入力 | サイドバーに「AI 置換」タブが表示され、フィクション値が確認できる |
| T-026 | フォールバック完全性 | `localLlmEnabled=false` 状態で入力 | 既存フローと同一結果。LLM への fetch なし |
| T-027 | Mixed-content | HTTPS claude.ai から HTTP localhost:11434 へ | fetch 成功 (host_permissions 追加後) |

### 6.3 プライバシー・セキュリティチェック

| ID | チェック項目 |
|---|---|
| T-030 | LLM への送信内容に認証情報 (chrome.storage の API キー等) が含まれないこと |
| T-031 | `localLlmUrl` に外部ドメイン (例: `https://api.openai.com`) を入力した場合に警告を表示すること |
| T-032 | プロンプトがコンソールにログ出力されないこと |
| T-033 | LLM 応答の JSON.parse 失敗時にスタックトレースがユーザーに露出しないこと |

---

## 7. 未解決 / トレードオフ一覧

| # | 論点 | 選択肢 A | 選択肢 B | 推奨 / 状態 |
|---|---|---|---|---|
| 1 | **外部 LLM URL の警告** | URL が非ローカルの場合は保存を拒否 | 警告を出して保存は許可 | B を採用。ユーザーが意図的に使う場合を排除しない。T-031 で確認 |
| 2 | **LLM 検出と regex の重み付け** | regex 優先 (LLM は追加のみ) | LLM 優先 (regex は fallback) | A を採用。既存フローの品質を保証済み。LLM は「追加検出のみ」とする |
| 3 | **Phase 3 の「送信」フロー** | AI 置換テキストをそのまま AI サービスに送信 | AI 置換テキスト + プレースホルダーマッピングを管理 | A (v0.5.0 スコープ)。復号マッピングは v0.6.0 課題 |
| 4 | **Ollama 以外 (OpenAI 互換) の検出** | `/api/version` 失敗時に `/v1/models` を試行 | ユーザーが手動で「互換モード」を選択 | A を採用。自動検出が UX を向上させる |
| 5 | **プロンプトのローカライズ** | 日本語のみ | 入力言語を検出して切り替え | 日本語固定 (v0.5.0)。多言語化は v0.6.0 課題 |
| 6 | **サイドバーのストリーミング表示** | Phase 3 で stream: true → 生成中テキストをリアルタイム表示 | stream: false → 完成後一括表示 | 未決定。UX としては A が望ましいが実装コスト大。v0.5.0 は B で行く |
| 7 | **プライバシーポリシーの更新** | ローカル LLM への送信はオフライン扱いと明記 | 「外部 URL 設定時はユーザー責任」と免責 | A + B 両方を記載する |
| 8 | **background.js でのヘルスキャッシュ** | Service worker に LLM 接続状態をキャッシュ (30s) | content.js が毎回チェック | A を推奨。Service worker が sleep するため揮発性に注意 |
| 9 | **manifest version** | `1.1.0` (本文採用) | `1.0.1` | `1.1.0` を推奨。本機能は minor feature 追加に相当 |
| 10 | **force_mask_keywords の LLM プロンプト注入** | システムプロンプトに keywords を渡す (原文に含まれる keywords が漏洩) | LLM 検出後にアプリ側でロック適用 | B を採用。原文の機密 keywords を LLM に渡さない |

---

## 8. キャッチボール — 回答待ち事項

以下はユーザーからの追加判断が必要な項目です:

| # | 質問 | 影響範囲 |
|---|---|---|
| Q-1 | Phase 3「自然言語置換モード」は v0.5.0 スコープに含めるか、v0.6.0 に後回しにするか? | 実装工数 (Phase 3 は Phase 1+2 の 2 倍程度) |
| Q-2 | `http://localhost/*` の他に、LAN 内の Ollama サーバー (`http://192.168.x.x/*`) も host_permissions に含めるか? | Chrome Web Store 審査リスク (IP レンジはより広い要求と見なされる可能性) |
| Q-3 | LLM モデルの推奨ラインナップを README / options.html に記載するか? (例: `llama3:8b`, `qwen2.5:7b`, `gemma3:4b`) | ドキュメント作業のみ |
| Q-4 | 既存の Python ゲートウェイ (`src/app/`) にも Ollama プロキシエンドポイントを追加するか? (拡張の代わりにゲートウェイが Ollama を呼ぶ形) | ゲートウェイ側の実装追加。MCP Gateway モードのユーザーに便益あり |
| Q-5 | サイドバーの diff ビューで「AI 置換」タブをデフォルト選択にするか、それとも「プレースホルダー」をデフォルトにするか? | UX / プライバシーバランス |

---

## 9. 実装チェックリスト

### Phase 1

- [ ] `feat/local-llm-proxy-v0.5.0` ブランチを `main` から作成
- [ ] `manifest.json`: `version` を `1.1.0` に bump
- [ ] `manifest.json`: `host_permissions` に `http://localhost/*`, `http://127.0.0.1/*` を追加
- [ ] `background.js`: `localLlmEnabled: false`, `localLlmMode: "detect"` の初期化を追加
- [ ] `options.html`: 「ローカル LLM 連携」セクションを追加
- [ ] `options.js`: URL 保存・ヘルスチェック・モデル一覧取得を実装
- [ ] `options.css`: `status-checking`, `status-error`, `.badge-llm`, `.badge-new`, `.badge-experimental` スタイルを追加
- [ ] `popup.html`: LLM 接続状態インジケーターを追加
- [ ] `popup.js`: `chrome.storage.local.localLlmUrl` から接続状態を読んで表示
- [ ] T-009〜T-011, T-020〜T-021 を手動確認

### Phase 2

- [ ] `content.js`: `callLocalLlm()` + `buildDetectPrompt()` を追加
- [ ] `engine/engine.js`: `mergeWithLlmEntities()` を追加
- [ ] `content.js`: `SANITIZE_REQUEST` ハンドラに LLM フェーズを挿入
- [ ] `sidebar.js`: LLM バッジ (`source === "llm"`) の表示を追加
- [ ] `sidebar.css` (インライン): `.badge-llm` スタイル追加
- [ ] T-001〜T-008, T-022〜T-027, T-030〜T-033 を確認

### Phase 3

- [ ] Q-1 の判断を待ってから着手
- [ ] `content.js`: `callLocalLlmReplace()` を追加
- [ ] `sidebar.js`: diff ビュー (3 タブ切り替え) を実装

---

*このドキュメントは初版設計プランです。Q-1〜Q-5 への回答を受けて更新します。*

---

## 10. 決定事項 (2026-04-16 追記)

### 10.1 Q-1〜Q-5 への回答

| # | 回答 | 確定事項 |
|---|---|---|
| Q-1 | 任せる | **Phase 3 も v0.5.0 に含める** ("experimental" badge 付き)。Q-5 が「AI置換 default」のため整合 |
| Q-2 | Web Store 公開は考えていない、切り分け | **`feat/local-llm-proxy-v0.5.0` は Web Store 非提出ブランチとする**。`host_permissions` に `http://*/*` を許可して LAN 内の Ollama サーバー等にも接続可能。manifest は別ビルドとし、Web Store 提出版は引き続き v1.0.0 (Phase A) を維持 |
| Q-3 | ネット公開スコアから推奨モデルを導出 | README に後述の推奨モデル表を追加。Qwen3 シリーズを primary、日本語特化 (Elyza / Shisa) を secondary |
| Q-4 | 任せる | **Python ゲートウェイ側に `/v1/ollama-proxy` エンドポイントを追加**。MCP ユーザーが gateway 経由で Ollama を使える。拡張機能からも gateway 経由オプションを提供 (二重中継オプション) |
| Q-5 | AI 置換 (diff ビューのデフォルトタブ) | `sidebar.js` の diff ビューで `"ai-replace"` タブをデフォルト選択。プレースホルダータブは fallback 表示 |

### 10.2 参考リポジトリ (LLM-anonymization) から採用する設計

https://github.com/zeroc00I/LLM-anonymization の設計思想は本プランと一致。以下を採用:

1. **Dual-layer detection**: regex (safety net) + LLM (contextual intelligence)。既存プランと同じ
2. **Deterministic surrogates**: プレースホルダー `<PHONE_1>` に加えて "realistic-looking" な代替値 (例: `090-0000-0000`, `example.com`, `山田花子`) も生成可能にする (Phase 3)
3. **Chunking at ~1500 chars**: 長文入力は分割して LLM に送る
4. **SQLite ↔ chrome.storage.session**: 復号マッピング vault。**v0.6.0 スコープ**として切り分け (今回は送信側のみ)
5. **LLM timeout は 8s → 15s に引き上げ**: NF-001 を更新。Qwen3:4b レベルなら 15s で十分

### 10.3 推奨モデル (README 掲載候補)

Ollama 互換でインストール・実行できる、日本語 PII 検出タスクで実用的なモデル:

| モデル | サイズ | Ollama tag | 推奨用途 | JP 性能 (Nejumi等) |
|---|---|---|---|---|
| **Qwen3:1.7b** | 1.7B | `qwen3:1.7b` | デフォルト推奨。レイテンシ < 3s | ★★★ |
| **Qwen3:4b** | 4B | `qwen3:4b` | 精度重視 (高速 GPU) | ★★★★ |
| **Qwen2.5:7b-instruct** | 7B | `qwen2.5:7b-instruct` | バランス型 | ★★★★ |
| **Gemma3:4b** | 4B | `gemma3:4b` | 軽量 (モバイル GPU) | ★★★ |
| **Llama3.1:8b** | 8B | `llama3.1:8b` | 英語混在テキスト | ★★★ |
| **Elyza-JP-Llama3:8b** | 8B | (HF) `elyza/Llama-3-ELYZA-JP-8B` | 日本語特化 | ★★★★★ |
| **Shisa-v2:7b** | 7B | (HF) `shisa-ai/shisa-v2-llama3.1-8b` | 日本語 + ビジネス文書 | ★★★★★ |

ベンチマーク出典:
- [Nejumi リーダーボード](https://wandb.ai/llm-jp-eval) (日本語 LLM 総合評価)
- [Open LLM Leaderboard](https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard) (多言語)

### 10.4 追加する新要件 (v0.5.0 スコープに組入れ)

| ID | 要件 | Phase |
|---|---|---|
| F-014 | 長文チャンク分割: 1500 文字を超える入力は分割して LLM に送信 | Phase 2 |
| F-015 | Python ゲートウェイに `POST /v1/ollama-proxy` エンドポイント追加 (MCP 用) | Phase 1b |
| F-016 | Deterministic surrogate 生成: `<PHONE_1>` 形式と「それっぽい」形式 (`090-0000-0000`) の切替 option | Phase 3 |
| NF-008 | LLM プロンプトは英語で統一 (多言語化は v0.6.0)。日本語入力テキストを英語システムプロンプトで解析させる方が Qwen3 の挙動が安定 | Phase 2 |

### 10.5 Web Store 戦略の明確化

- **main ブランチ / v1.0.0** = Web Store 提出版 (standalone のみ、gateway / LLM なし)
- **feat/local-llm-proxy-v0.5.0 ブランチ / v0.5.0 label** = 開発者向け unpacked 配布のみ。Web Store には出さない
- v0.5.0 の内容を v1.x.x に取り込む際は、`host_permissions` を `http://localhost/*` + `http://127.0.0.1/*` に絞り、Web Store 提出可能な形に整え直す (将来的な別タスク)

---

*v0.5.0 着手前の最終プラン。次は `feat/local-llm-proxy-v0.5.0` ブランチを作成し Phase 1 から実装開始。*
