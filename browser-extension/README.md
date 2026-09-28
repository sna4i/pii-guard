# PII Guard — Browser Extension

Root README: [日本語](../README.md) / [English](../README.en.md). This file is English-only and covers extension-internal detail; the root READMEs cover the same material with gateway and MCP context.

Chrome MV3 extension that masks PII in outbound AI-service traffic
before it leaves the browser. Targets Claude.ai, ChatGPT, Gemini,
and Manus.

Runs in **three operation modes** depending on what back-ends you
point it at:

| Mode | Detection source | Extra infra |
|---|---|---|
| Standalone | In-browser regex + 形態素 (ts-sudachi) | None |
| Gateway | standalone + FastAPI gateway (Presidio / Sudachi) | `make up` (`127.0.0.1:8081`) |
| Local-LLM (v0.5.0+) | standalone + Ollama / LM Studio / llama.cpp | Ollama daemon on `127.0.0.1:11434` (LAN OK) |

**Current releases**:

| Channel | Version | Source |
|---|---|---|
| Chrome Web Store (public) | `v1.1.0 / PII Guard` — standalone-only (dictionaries + drag-drop force-mask) | `dist/browser-extension-store/` (produced by `scripts/build-store.sh`) |
| Dev build (local LLM) | `v1.4.0 / 0.8.0-dev` — includes local-LLM proxy + `http://*/*` host permission | `browser-extension/` (this directory, unpacked load) |

The dev build is *not* what ships to the Store — see [Building the Chrome Web Store variant](#building-the-chrome-web-store-variant) below. Local-LLM mode is opt-in and experimental.

## Install (developer mode)

1. Start the gateway so the extension has something to talk to:

   ```bash
   cd /path/to/mask-mcp
   make up
   ```

   Wait for `ok (<N>s)` — this means `/health` is up.

2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave:
   `brave://extensions`).

3. Enable **Developer mode** (top-right toggle).

4. Click **Load unpacked** and pick this directory
   (`browser-extension/`). The extension icon should appear in the
   toolbar with a blue `M` glyph.

5. Visit <https://claude.ai/> (or a supported service below). Open
   the browser devtools console and look for:

   ```
   [pii-guard] content script installed on claude.ai
   [pii-guard] injected hooks installed on claude.ai
   ```

6. Type a message containing PII (e.g. `田中太郎に連絡`). The
   extension icon badge should increment; the masked payload is what
   actually leaves your browser.

## Building the Chrome Web Store variant

The `browser-extension/` tree is the **dev build** — it includes the
local-LLM proxy, `http://*/*` host permission, and the options-page
LLM config card. None of that ships to the Web Store. Instead a
single repo-root script produces a Store-only distributable from the
same source tree.

```bash
./scripts/build-store.sh
# → dist/browser-extension-store/         (unpacked, ready to Load unpacked)
# → dist/browser-extension-store.zip      (upload to Developer Dashboard)
```

The script:

1. copies `browser-extension/` → `dist/browser-extension-store/`
2. replaces `manifest.json` with `manifest.store.json`
   (no `http://*/*`, 6 chat-provider hosts only, no LLM engine files
   in `web_accessible_resources`)
3. deletes `engine/surrogates.js` and `engine/llm-prompts.js`
4. strips every `STORE-STRIP:START … STORE-STRIP:END` block
   (HTML `<!-- -->` and JS `//` comment forms both supported) —
   currently one block in `content.js` (2 `ENGINE_FILES` entries)
   and one in `options.html` (the entire **ローカル LLM 連携** card)
5. validates the result: no `http://*/*` in manifest, no markers
   leftover, no references to deleted files, manifest parses as
   JSON, every `.js` passes `node --check`
6. zips the dist for Web-Store upload

If validation fails the script aborts loudly. To add a new dev-only
code block to either tree, wrap it in `STORE-STRIP` markers and add
one more entry to the "delete" step if it's a whole file.

## Supported services

| Service | URL pattern | Status |
|---|---|---|
| Claude.ai | `claude.ai`, `*.claude.com` | **working** (v0.5.1+; covers `completion` / `send_message` / `messages` / projects paths; relative URLs resolved) |
| ChatGPT | `chatgpt.com`, `chat.openai.com` | working — POST `/backend-api/conversation` |
| Gemini | `gemini.google.com` | partial — `f.req` form is read-only |
| Manus | `manus.im`, `*.manus.im` + `*.butterfly-effect.dev` | working — fetch + Socket.IO WebSocket |

If you hit a missed case, the `console.debug` logs in devtools
will show `[pii-guard]` entries tagged with the adapter name.
Specifically useful for triage:

    [pii-guard] provider POST (adapter matched):        <url>
    [pii-guard] provider POST (NO adapter match):       <url>
    [pii-guard] <adapter>: adapter matched but body had no user text —
        keys: <top-level-keys>                         <url>

Paste any of those (deduped per URL) into an issue and we can
patch the matcher or extractor.

## Local-LLM proxy (v0.5.0+, experimental)

With a local Ollama / LM Studio / llama.cpp server you can add
**context-aware PII detection** on top of regex + Sudachi. The LLM
never leaves your machine (or LAN), and when enabled its output
takes authority over the heuristic detectors for any surface text
both paths surface — regex becomes a safety net for structured PII
(email / credit card / phone) the LLM missed.

### Enable

`options.html` → **ローカル LLM 連携** section:

| Field | Default | Notes |
|---|---|---|
| LLM 補助検出を有効化 | off | master switch |
| エンドポイント URL | — | e.g. `http://localhost:11434` (Ollama) or `http://192.168.0.10:1234` (LM Studio) |
| 使用モデル | — | auto-populated from `/api/tags` or `/v1/models` after 接続確認 |
| 動作モード | `検出補助 (regex + LLM)` | `AI 置換 (実験的)` rewrites the full text into `<tag_N>` placeholders |
| タイムアウト (ms) | `120000` | 9B thinking models need ≥60s; max `240000` |

### Model management panel (v0.5.0+)

The options page lists 7 curated models as a table with:
- on-disk size + VRAM chip (`2.5 GB / VRAM ~3 GB`)
- qualitative badge — **軽量 / 推奨 / 高精度 / 最高精度 / 代替**
- **ダウンロード** button for uninstalled models (fires `POST /api/pull`
  with streaming NDJSON; shows live progress bar + `% (downloaded/total)`)
- **削除** button for installed models (fires `DELETE /api/delete`
  after `window.confirm`)
- `✓ インストール済` tag when the model is present

Curated catalog:

| Model | Size | VRAM | Badge |
|---|---|---|---|
| `qwen3:1.7b` | 1.1 GB | ~1.5 GB | 軽量 |
| `qwen3:4b` | 2.5 GB | ~3 GB | 推奨 |
| `qwen3:8b` | 4.7 GB | ~5 GB | 高精度 |
| `qwen3:14b` | 8.2 GB | ~9 GB | 最高精度 |
| `gemma3:4b` | 2.5 GB | ~3 GB | 代替 |
| `llama3.2:3b` | 2.0 GB | ~2 GB | 代替 |
| `phi3.5:3.8b` | 2.2 GB | ~2.5 GB | 代替 |

### Required Ollama configuration

Ollama rejects cross-origin requests by default and will return
**HTTP 403** to the extension. You must set `OLLAMA_ORIGINS='*'`
(or whitelist `chrome-extension://*`) before the extension can
connect. The options-page 接続確認 button detects this and shows
the exact remediation command.

```bash
# Docker
docker run -d --name ollama --gpus all \
  -e OLLAMA_HOST='0.0.0.0:11434' \
  -e OLLAMA_ORIGINS='*' \
  -p 11434:11434 \
  -v ollama:/root/.ollama \
  --restart unless-stopped \
  ollama/ollama:latest

# systemd
sudo systemctl edit ollama
# [Service]
# Environment="OLLAMA_ORIGINS=*"
sudo systemctl restart ollama

# Plain binary
OLLAMA_ORIGINS='*' ollama serve
```

### Architecture — why the service worker?

Content scripts run inside the host page (e.g. `https://claude.ai`)
and Chrome's **Private Network Access** policy blocks HTTPS pages
from fetching `http://localhost` / LAN IPs. The service worker is
privileged and PNA-exempt, so every LLM call is routed:

```text
page world (injected.js)
  → window.postMessage → content.js
  → chrome.runtime.sendMessage({type:"LLM_FETCH", url, method, body, timeoutMs})
  → background.js (service worker)
     ├─ validate sender.id === chrome.runtime.id   (no foreign extensions)
     ├─ validate url.host === storage.localLlmUrl  (host-lock)
     └─ fetch(url, …)
  → response → chrome.runtime message → content.js → postMessage → injected.js
```

The SW will **refuse** any host that does not match the saved
`localLlmUrl` — it cannot be repurposed as a general proxy.

### Detection flow when LLM is enabled

1. `sanitize/aggregated` returns regex + Sudachi entities.
2. Regardless of regex count, the sidebar opens **immediately** with
   a ModePill ("検出補助 (Regex + AI)" / "AI 置換 (実験的)") and a
   centered overlay (`✨ AI 分析中…` or `✨ AI 置換中…` depending
   on mode). Rows don't paint yet.
3. `mergeLlmDetect()` (detect) or the replace rewrite runs in
   parallel. Ollama body includes:
     think: false          — suppresses Qwen3's internal reasoning
     format: "json"        — grammar-constrains output
     num_predict: 2048     — generation cap
   `<think>` regex fallback strip still runs for models that ignore
   `think:false`.
4. LLM output passes the denylist (job titles, credential
   type-names, polite particles, short hiragana) to kill common
   false positives.
5. Entities get **unique numbered tags** via `applyUniqueTagsToReplace`:
     田中          → <surname_1>
     中村          → <surname_2>
     株式会社…     → <company_1>
     駒込病院      → <hospital_1>
   Same surface text → same tag; every distinct value → its own
   number. Foundation for future response-restore feature.
6. Rows fade in with an 80 ms-per-row stagger; overlay dismisses
   after the last row finishes animating.
7. On LLM failure (timeout / 403 / network) the overlay switches to
   an error style and auto-hides after 4s; regex-only detections
   stay in place — **fail-open on augmentation**, not on masking.

### Replace mode (`AI 置換`)

The LLM rewrites the whole input into `<tag_N>` placeholders
(NOT realistic fakes). Output example:
```
原文: 株式会社アクメの田中副社長と佐藤課長にエスカレーション。
         年収 1,450 万円ラインを超える昇給者リストは HRIS へ。
置換: <company_1>の<name_1>と<surname_1>にエスカレーション。
         年収 <income_1>ラインを超える昇給者リストは <pjcode_1> へ。
```

Tag catalog covers all 7 categories:
- PERSON          → `<name>` / `<surname>`
- COMPANY         → `<company>`
- LOCATION        → `<location>` / `<office>` / `<building>` / `<room>` / `<hospital>`
- DEPARTMENT      → `<department>` / `<team>`
- PROJECT_CODE    → `<project>` / `<pjcode>` / `<slack_channel>`
- CREDENTIAL      → `<credential>` / `<apikey>` / `<password>` / `<cloud_resource>` / `<role_arn>`
- SENSITIVE_FACT  → `<income>` / `<salary>` / `<stock>` / `<bonus>` / `<age>` / `<family>` / `<illness>` / `<join_date>` / `<schedule>` / `<url>` / `<rank>`

`applyUniqueTagsToReplace()` post-processes the LLM output to
guarantee unique numbered tags per distinct value — same surface
gets the same tag, distinct values get distinct numbers. This
makes the mapping 1:1 restorable (groundwork for the future
"restore tags in AI response" feature).

**Fail-closed loop**: if *any* input fails validation, the
entire outbound request is aborted rather than leaking partial
content.

### Row interaction rules (v0.5.0 final)

| Row state | Tap | Long-press |
|---|---|---|
| critical + masked | no-op (safety) | **unmask** |
| critical + unmasked | **re-mask** | n/a (not required) |
| locked (force-masked) + masked | **unlock + unmask** | n/a |
| locked + unmasked (already解除) | **re-mask** | n/a |
| high / medium / low | **toggle** | n/a |

Long-press is the ONLY gesture that requires hold — and only on
critical rows that are currently masked. Everything else responds
to a single tap. Critical-unmasked rows use `pointerup` to
distinguish tap from cancelled hold; no click listener is
attached to them to avoid dual-listener interference.

## Interactive review mode

Interactive mode is **ON by default**. Before an intercepted fetch
leaves the browser, a Shadow-DOM-isolated panel shows every
detection the gateway returned and lets you un-tick false
positives. Press `Enter` (or click the primary button) to send the
masked payload; press `Esc` (or the secondary button) to abort the
request entirely.

There are now **two UI modes** to pick between in the popup
(`UI モード`):

- **サイドバー (推奨)** — Milestone 8 Wave B default. Right-side
  fixed panel with category-grouped, aggregated rows.
- **モーダル (従来)** — Phase 2 modal, one row per occurrence.

Both modes call the same gateway under the hood; only the rendering
and the request endpoint differ:

| | サイドバーモード | モーダルモード |
|---|---|---|
| Endpoint | `POST /v1/extension/sanitize/aggregated` | `POST /v1/extension/sanitize` |
| Per-row granularity | One row per unique `(category, value)` pair (e.g. `田中太郎 (2件)`) | One row per occurrence |
| Category grouping | ▾ collapsible section per big category with a tri-state parent toggle | flat list |
| Force-mask lock | 🔒 icon + disabled checkbox for categories the gateway forced via `force_mask_keywords` | n/a |
| Bulk actions | すべて選択 / すべて解除 | n/a |
| Live preview | ✓ updates client-side on every checkbox change | n/a |

### サイドバーモード

```
┌───────────────────────────────────────────────────────────┐
│ マスク対象の確認                                       ×  │
│───────────────────────────────────────────────────────────│
│ [すべて選択]  [すべて解除]                                │
│                                                           │
│ ▼ PERSON 🔒 (3件)                              [■]       │
│     ☑ 田中太郎 (2件) [PROPER_NOUN_PERSON] 🔒              │
│     ☑ 山田花子 (1件) [KATAKANA_NAME]      🔒              │
│                                                           │
│ ▼ CONTACT (2件)                                [■]       │
│     ☑ foo@example.com (1件) [EMAIL_ADDRESS]              │
│     ☑ 〒651-0087 (1件)      [POSTAL_CODE]                │
│                                                           │
│ ▼ FINANCIAL 🔒 (1件)                           [■]       │
│     ☑ 年収1200万円 (1件) [ANNUAL_INCOME]  🔒              │
│                                                           │
│ ──────────────────────────────────────────────            │
│ プレビュー                                                │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ <PROPER_NOUN_PERSON>は<EMAIL_ADDRESS>まで連絡。       │ │
│ │ <ANNUAL_INCOME>。〒<POSTAL_CODE>                      │ │
│ └───────────────────────────────────────────────────────┘ │
│                                                           │
│ [キャンセル (Esc)]  [選択したものをマスクして送信 (Enter)]│
└───────────────────────────────────────────────────────────┘
```

* **Aggregated rows** — `田中太郎 (2件)` is one row, not two. Only
  one toggle per unique `(category, value)` pair.
* **Category-level toggle** — tri-state checkbox flips every row
  beneath it.
* **🔒 Lock icon** — categories listed in
  `force_masked_categories` (gateway-side
  `RuntimeConfig.force_mask_keywords` triggered by 機密 / 未公開 /
  リーク / `confidential` / `leak`) cannot be unchecked.
* **Live preview** at the bottom shows the final `<TAG>`-style
  output as you toggle. Pure client-side, no extra fetches.
* **LLM 分析中 banner** (v0.5.0+) — when local-LLM augmentation is
  enabled and regex returned ≥1 entity, the sidebar opens
  instantly with the regex snapshot and shows a gradient banner
  at the top while the LLM thinks. When the LLM resolves, rows
  are re-rendered with LLM-authoritative labels and any new
  entities LLM found. Your mask/unmask choices on the regex rows
  are preserved across the re-render. On timeout or 403 the
  banner flips to an error style and auto-hides after 4s —
  regex-only detections stay in place.
* **Top-right spinner pill** — a small always-on-top pill
  (`✨ LLM 分析中…`) pinned outside the sidebar frame. Appears
  even if the sidebar isn't open yet (regex returned 0 entities,
  waiting for the LLM to decide whether anything needs masking).

### モーダルモード (従来)

```
+---------------------------------------------------+
| マスク対象の確認                                  |
| 以下の項目がマスクされます…                       |
|---------------------------------------------------|
| [x] [EMAIL]    hogehoge@fugafuga.fizz  → <EMAIL>  |
|     …連絡先 [hogehoge@fugafuga.fizz] まで…        |
| [x] [PERSON]   タカハシユウヤ       → <PERSON>    |
|     [タカハシユウヤ]と申します…                   |
| [ ] [COMPANY]  プロジェクト        → <COMPANY>    |
|     …開発中の[プロジェクト]名は…                  |
|---------------------------------------------------|
|       [キャンセル (Esc)]  [マスクして送信 (Enter)]|
+---------------------------------------------------+
```

Both surfaces attach to `document.body` via a throwaway `<div>` with
`attachShadow({mode: 'open'})` and `z-index: 2147483647`, so the
host page's DOM and CSS are unaffected. When dismissed the overlay
is removed completely.

Toggle from the popup:

- **Masking enabled** — master on/off (same as before).
- **送信前に確認する (インタラクティブ・モード)** — when off the
  review UI is skipped and the gateway-sanitised payload is sent
  automatically (Phase 1 behaviour).
- **UI モード** — radio between サイドバー and モーダル. Default
  サイドバー.

Colour-coded badges per entity category:

| Colour | Categories |
|---|---|
| red | API_KEY, SECRET, EMAIL_ADDRESS, CREDIT_CARD, MY_NUMBER, PASSPORT, DRIVERS_LICENSE, BANK_ACCOUNT, DB_CONNECTION, PHONE_NUMBER |
| orange | PERSON, PROPER_NOUN*, KATAKANA_NAME |
| blue | LOCATION, PROPER_NOUN_LOCATION, PROPER_NOUN_ORG, ADDRESS, COMPANY |
| grey | anything else (future analyzer entity types) |

## 重要度カラー (severity)

Milestone 7/8 で追加。各行は `severity` 値に従って **左ボーダー色** と **severity ピル** (`[critical|high|medium|low]`) が塗り分けられます。カテゴリヘッダーは配下行の最悪 severity を表示します。

| Severity | ボーダー / ピル色 | 対象 (抜粋) | 操作 |
|---|---|---|---|
| critical | 赤 `#dc2626` / 背景 `#fee2e2` | API_KEY, SECRET, MY_NUMBER, PASSPORT, DRIVERS_LICENSE, CREDIT_CARD, BANK_ACCOUNT, DB_CONNECTION | **800ms 長押し** で解除。通常クリックでは外せない |
| high | オレンジ `#f97316` / 背景 `#ffedd5` | PERSON, PROPER_NOUN_PERSON, EMAIL_ADDRESS, PHONE_NUMBER, ADDRESS, PATIENT_ID | 通常チェックボックス |
| medium | アンバー `#eab308` / 背景 `#fef3c7` | LOCATION, COMPANY, ORGANIZATION, EMPLOYEE_ID, MEMBER_ID, CUSTOMER_ID, CONTRACT_NUMBER, MONETARY_AMOUNT, URL, IP_ADDRESS 他 | 通常チェックボックス |
| low | グレー `#6b7280` / 背景 `#f3f4f6` | AGE, GENDER, DATE, BLOOD_TYPE, POSTAL_CODE, SKU, KATAKANA_NAME, 未マップラベル | 通常チェックボックス |

### Critical 行の長押し操作

```
┌─────────────────────────────────────────┐
│ ⚪ API_KEY sk-proj-ABC… [critical] 🔒   │
│ └─ 円を 800ms 押し続けるとリングが      │
│    0→100%に満ちた瞬間にチェックが外れる │
│    指を離すとリセット (キャンセル扱い)  │
│                                         │
│ Pulse: 外した直後にボーダーが赤に光る   │
└─────────────────────────────────────────┘
```

- `pointerdown` → SVG の `<circle stroke-dashoffset>` をアニメーション。50ms 毎に進捗更新
- `pointerup` / `pointerleave` / `pointercancel` が 800ms 経過前に発火すると **トグルされない**
- 800ms 到達で `change` イベント発火、プレビューペインが再描画
- Space / Enter をホールドしても同じ挙動 (キーボード操作対応)
- タッチ環境でも `pointer*` で動作

`force_masked_categories` に含まれる critical 行は長押し UI が無効化され、🔒 アイコンの disabled 表示になります (= 何をしても外せない)。

### バルク操作と Critical ガード

- **すべて選択** — critical / force-mask に関わらず全部チェック
- **すべて解除** — critical 行が存在する場合、ネイティブ `window.confirm` で「Critical な N 件は長押しで個別に解除してください。それ以外だけ解除しますか？」と確認し、Yes なら **critical 以外** のみクリア。キャンセルなら何もしない
- **カテゴリヘッダーのトグル** — 同様のガードが働く

### レビューモーダル (従来モード) の挙動

`uiMode === "modal"` でもサイドバーと同じ severity カラーと長押しゲートが有効になります。行は severity 降順 (critical → low) でソートされ、リスクの高い検出が先頭に浮上します。

Keyboard:

- `Enter` — confirm with the currently-ticked selection
- `Esc` — cancel, abort the send
- `Tab` / `Shift-Tab` — cycle focus through checkboxes + buttons
- `Space` — toggle the focused checkbox

## Known limitations

- Non-JSON request bodies (FormData, multipart) are passed through
  untouched. Every supported service uses `application/json` for
  user-text today, but this will need extending if a future service
  uses protobuf/gRPC.
- Streaming responses are not intercepted in either direction. The
  hook only rewrites the outbound request body, not the assistant's
  reply. This is the intended Phase 1 scope (Q3 = 送信のみ).
- Gemini's Bard-frontend `f.req` parameter is complex nested JSON
  inside form-encoding; we extract the user text for the mask-count
  badge but do not rewrite it back, so Gemini submissions are
  detected-only until the Bard framing is safe to round-trip.
- No TLS interception. All masking happens in-browser.
- **LLM cold start** — first query after daemon start can take
  20–40s on 4B+ models. The 60s default timeout covers this; bump
  to 120–180s on slower hardware (CPU inference).
- **Qwen3 think blocks** — models in the Qwen3 family wrap output
  in `<think>…</think>`. The parser strips these and extracts the
  first `{…}`-bounded JSON object; non-JSON replies are dropped.
- **No TLS interception of LLM traffic** — Ollama is expected to
  run on `http://` (loopback / LAN). Pointing the extension at
  `https://` with a self-signed cert is unsupported.
- **Replace mode is experimental** — failures are fail-closed
  (request aborted) rather than fail-open. If you get repeated
  "LLM 置換失敗" errors in the popup, switch back to `検出補助`.

## Uninstall

`chrome://extensions` → find "PII Guard" (or "PII Guard (dev —
local LLM)" for the v0.5.0-dev build) → Remove.

## Files

```
browser-extension/
  manifest.json      MV3 manifest (host_permissions, scripts, icons,
                     web_accessible_resources for engine/*.js)
  content.js         Isolated-world bridge (chrome.* access + postMessage relay;
                     also routes LLM_FETCH to service worker)
  injected.js        Main-world fetch/XHR/WebSocket hooks + per-service adapters
                     + dispatch by uiMode (sidebar | modal) + LLM merge logic
                     (mergeLlmDetect, processBody replace-mode fail-closed loop)
  review-modal.js    Main-world Shadow-DOM modal for per-detection review
                     (used when uiMode === "modal")
  sidebar.js         Main-world Shadow-DOM sidebar for aggregated review
                     (used when uiMode === "sidebar", default).
                     v0.5.0+ adds opts.llmPending Promise → open-before-LLM
                     with inline "LLM 分析中…" banner and top-right spinner pill
  background.js      Service worker — badge + per-tab counts + storage seed
                     (seeds enabled / interactive / uiMode / localLlmEnabled /
                     localLlmMode / localLlmTimeoutMs). Also hosts LLM_FETCH
                     proxy with sender-id and host-lock validation.
  options.html/css/js Full-page settings — allowlist DB, local-LLM config,
                     CORS remediation alert for Ollama 403
  popup.html/css/js  Toolbar popup (enabled toggle, interactive toggle,
                     UI mode radio, gateway health, count)
  engine/
    engine.js         Standalone in-browser regex + 形態素 detector
    ts-sudachi.js     Mini Sudachi-like Japanese morphological analyzer
    surrogates.js     Type-preserving fake values (RFC 5737 IPs,
                      @example.com, xorshift32, djb2-seeded)
    llm-prompts.js    /no_think system prompt + few-shot examples +
                      HARD NEGATIVE LIST for detect and replace modes
  icons/             16/48/128 px RGBA PNGs (generated from scripts/)
  scripts/
    generate-icons.py Regenerate icons inside local-mask-mcp:latest container
```
