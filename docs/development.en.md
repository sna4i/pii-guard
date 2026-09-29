# PII Guard — developer guide

[日本語](./development.md) / **English (this page)**

If you only want to use the extension, see the [README](../README.en.md) at the repository root. This guide covers the gateway, the MCP server, the detection engine and the development workflow.

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

A lightweight gateway and Chrome extension that detect and mask PII on the local machine before it is sent to generative AI services. The browser extension (Chrome MV3) intercepts outbound traffic on Claude.ai, ChatGPT, Gemini, and Manus and detects PII. Optionally, a FastAPI gateway (Docker) can be used for multi-stage analyzers based on Presidio, SudachiPy, and preset regular expressions; connecting a local LLM (Ollama, LM Studio, or llama.cpp) adds context-aware detection and an AI-replace mode (v0.5.0+). Detections are surfaced in a sidebar right before the send fires, and only confirmed items are transmitted as a masked payload. Nothing is sent to a third-party server.(This does not guarantee 100% detection. Please use it solely as a supplementary tool.)

The extension is distributed on the Chrome Web Store, and there is a separate development build. See the [CHANGELOG](../browser-extension/CHANGELOG.md) for what changed in each version and [TODO.md](../TODO.md) for the roadmap.

Every push is checked for machine-specific paths, personal data and secrets; see [prepush-check.md](./prepush-check.md) (Japanese). After cloning, run `git config core.hooksPath .githooks` once.

## Table of contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Detection catalog](#detection-catalog)
- [Vendor-specific API key detection (v0.5.0+)](#vendor-specific-api-key-detection-v050)
- [Severity tiers](#severity-tiers)
- [Common-noun blocklist](#common-noun-blocklist)
- [Setup](#setup)
- [Usage (Gateway API)](#usage-gateway-api)
- [Browser extension](#browser-extension)
- [Local LLM proxy (v0.5.0)](#local-llm-proxy-v050)
- [Claude Code / Claude Desktop integration](#claude-code--claude-desktop-integration)
- [Chrome Web Store build](#chrome-web-store-build)
- [Tests](#tests)
- [Directory layout](#directory-layout)

## Overview

| Layer | Stack | Responsibility |
|---|---|---|
| Browser extension | Chrome MV3 / Shadow DOM / Service Worker | Send interception, sidebar UI, LLM proxy |
| Gateway (optional) | FastAPI + Pydantic v2 + uv on Docker | Presidio / Sudachi / regex analyzer chain |
| MCP server (optional) | FastMCP (stdio) | Exposes `sanitize_text` etc. to Claude Desktop |
| Local LLM (optional) | Ollama / LM Studio / llama.cpp | Context-aware PII detection + AI-replace mode |

The extension runs without the gateway (standalone mode). If the gateway responds at `127.0.0.1:8081`, the extension uses it automatically (hybrid mode). Enabling a local LLM routes every call through the extension's service worker directly to Ollama. Neither the gateway nor the LLM leaves the host machine or LAN.

## Architecture

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

Analyzer mix (all implemented):

| Analyzer | Language | Role |
|---|---|---|
| Presidio | English-first | `PERSON` / `EMAIL_ADDRESS` / `CREDIT_CARD` and fixed entity types |
| SudachiPy | Japanese | Morphological analysis — only `名詞,固有名詞` (proper nouns) are kept, general nouns are skipped |
| RegexAnalyzer | Both | Org-internal IDs, API keys, addresses — 40+ preset categories |
| Local LLM | Both | Context-aware PII detection (regex is always kept as a safety net) |

The three concrete analyzers implement an `Analyzer` Protocol (`src/app/services/analyzers/base.py`), so adding a new one (for example, GiNZA) is a single-file change.

## Detection catalog

Presets are enabled by default (`enable_preset_patterns: true`). Disable a category by adding its key to `disabled_pattern_categories`.

| Category | entity_type | Example | Source |
|---|---|---|---|
| Person | `PERSON` / `PROPER_NOUN_PERSON` | 田中太郎, Tanaka | Presidio NER / Sudachi |
| Email | `EMAIL_ADDRESS` | user@example.com | Presidio |
| Phone | `PHONE_NUMBER` | 090-1234-5678, 03-1234-5678 | Presidio / preset |
| Prefecture + city | `PREFECTURE_CITY` | 兵庫県明石市 / 東京都渋谷区 | Preset regex |
| Full address | `ADDRESS` | 兵庫県明石市大久保町1丁目2番3号 | Preset regex |
| Prefecture (bare) | `JP_PREFECTURE_DICT` | 兵庫県 / 東京都 (all 47 prefectures) | Static dictionary |
| Designated city (bare) | `JP_DESIGNATED_CITY` | 札幌市 / 横浜市 / 大阪市 (20 cities) | Static dictionary |
| World country | `WORLD_COUNTRY` | 日本 / Japan / 米国 / USA / France (G20 + major Asian) | Static dictionary |
| Japanese surname | `JP_SURNAME` | 佐藤 / 鈴木 / 高橋 / 田中 … (top 50) | Static dictionary |
| Western first name | `WESTERN_FIRST_NAME` | John / Mary / David (curated) | Static dictionary |
| Age | `AGE` | 35歳 | Preset regex |
| Gender | `GENDER` | 男性 / 女性 | Preset regex |
| Company | `COMPANY` | 株式会社マスクテスト | Preset regex |
| Money | `MONETARY_AMOUNT` | ¥15,000 / 100万円 | Preset regex |
| Date | `DATE` | 2024/01/15, 令和6年1月 | Preset regex |
| IP | `IP_ADDRESS` | 192.168.1.1 | Preset regex |
| URL | `URL` | https://example.com | Preset regex |
| My Number (JP) | `MY_NUMBER` | 1234 5678 9012 | Preset regex |
| Bank account | `BANK_ACCOUNT` | 普通 1234567 | Preset regex |
| Driver's license | `DRIVERS_LICENSE` | 12-34-567890-12 | Preset regex |
| Passport | `PASSPORT` | AB1234567 | Preset regex |
| DB connection | `DB_CONNECTION` | `postgresql://...` | Preset regex |
| API key | `API_KEY` / `SECRET` | `sk-xxx`, `password=xxx` | [vendor table](#vendor-specific-api-key-detection-v050) |
| Internal ID | `INTERNAL_ID` | PRJ-001, EMP-12345 | Preset regex |
| Credit card | `CREDIT_CARD` | 4111-1111-1111-1111 | Presidio |
| Location | `LOCATION` / `PROPER_NOUN_LOCATION` | 東京, 大阪 | Presidio / Sudachi |
| Organization | `PROPER_NOUN_ORG` | グーグル | Sudachi |

`PREFECTURE_CITY` vs `ADDRESS`: the "prefecture + city" form alone (for example, `兵庫県明石市`) is detected as `PREFECTURE_CITY`. When a street suffix follows (for example, `兵庫県明石市大久保町1丁目2番3号`), `ADDRESS` wins via longer-span resolution in the sweep-line overlap resolver.

**Dictionary-based fallback categories** (`JP_SURNAME` / `JP_PREFECTURE_DICT` / `JP_DESIGNATED_CITY` / `WORLD_COUNTRY` / `WESTERN_FIRST_NAME`): a static dictionary layer that catches common Japanese surnames, all 47 prefectures, the 20 designated cities, major country names, and curated Western first names — even when Sudachi / Presidio are disabled (standalone mode). Dictionaries live in `browser-extension/engine/dictionaries.js` and `src/app/services/analyzers/dictionaries.py`; both must be updated together when adding entries.

### Business-doc presets (Milestone 8 Wave A — 15 extra categories)

| Category | entity_type | Matches |
|---|---|---|
| Postal code | `POSTAL_CODE` | `〒651-0087`, `123-4567` |
| Department code | `DEPARTMENT` | `DIV-101`, `部署コード: D-001` |
| Contract number | `CONTRACT_NUMBER` | `CONTRACT-ABC-001`, `契約番号: CT-2024-01` |
| PO / purchase order | `PURCHASE_ORDER` | `PO-1234567`, `発注番号: PO-9999` |
| Customer ID | `CUSTOMER_ID` | `CUST-0001`, `顧客ID: C-999` |
| Invoice number | `INVOICE_NUMBER` | `INV-20240415`, `請求番号: INV-12` |
| Employee ID | `EMPLOYEE_ID` | `STAFF-00123`, `社員番号: E-0042` |
| Member ID | `MEMBER_ID` | `MEMBER-123456`, `会員ID: M-555` |
| Patient ID | `PATIENT_ID` | `PATIENT-12345`, `患者ID: P-77` |
| SKU | `SKU` | `SKU-ABC-123`, `商品コード: X-77` |
| Blood type | `BLOOD_TYPE` | `AB型`, `A型` |
| Annual / monthly income | `ANNUAL_INCOME` | `年収1200万円`, `月収 40 万円` |
| Patent number | `PATENT_NUMBER` | `特許2024-123456`, `JP 1234567` |
| Asset number | `ASSET_NUMBER` | `ASSET-12345`, `資産番号: FA-999` |
| License number | `LICENSE_NUMBER` | `LIC-ABC-2024` |

Presets are defined in `src/app/services/analyzers/presets.py` and extended as new leak-prone categories surface. Disable false positives via `disabled_pattern_categories` or per-row in the review sidebar.

## Vendor-specific API key detection (v0.5.0+)

Beyond generic `sk-*` / `pk_*` / `access_key_*` rules, the `API_KEY` category directly recognises fixed-prefix tokens from major SaaS vendors. The same table lives in both `browser-extension/engine/patterns.js` and `src/app/services/analyzers/presets.py` — always update both together.

| Vendor | Prefix / format | Purpose |
|---|---|---|
| OpenAI | `sk-<32+>` / `sk-proj-...` / `sk-svcacct-...` / `sk-None-...` | project / service / legacy |
| Anthropic | `sk-ant-api03-<80+>` / `sk-ant-admin01-<80+>` | Claude API / Admin |
| Notion | `ntn_<40+>` / `secret_<43>` | Integration token (new/old) |
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
| JWT | `eyJ...·eyJ...·...` | 3-segment base64url (Supabase etc.) |
| HTTP header | `Bearer <16+>` / `X-Api-Key: ...` | Request headers |
| Certificate | `-----BEGIN … PRIVATE KEY-----` | RSA / EC / OpenSSH / PGP / DSA |

All of these emit `entity_type = API_KEY` (PEM keys become `SECRET`) and are treated as critical by the [severity table](#severity-tiers). The sidebar locks them with a red border and requires explicit user confirmation before send.

With a local LLM enabled, structured tokens are still caught by regex as a safety net — even if the LLM misses or misclassifies them.

## Severity tiers

Each detection carries `category` (display bucket), `classification` (linguistic class), and `severity` (leak-time risk). `src/app/services/severity.py` defines the base map; `severity_for_surface(label, surface)` escalates tiers based on the actual matched text. The UI uses this value to set left-border colours, category header colours, and long-press gates.

| Severity | Labels (excerpt) | UI colour | UI behaviour |
|---|---|---|---|
| critical | `MY_NUMBER`, `PASSPORT`, `DRIVERS_LICENSE`, `CREDIT_CARD`, `BANK_ACCOUNT`, `API_KEY`, `SECRET`, `DB_CONNECTION`, + dynamic escalation | rose `#e11d48` | Long-press (0–1.5 s) required only on locked rows from `force_masked_categories` |
| high | `PHONE_NUMBER`, `ADDRESS`, `PATIENT_ID`, `JP_SURNAME`, `WESTERN_FIRST_NAME` | orange `#ea580c` | Click to toggle |
| medium | `LOCATION`, `PREFECTURE_CITY`, `JP_PREFECTURE_DICT`, `JP_DESIGNATED_CITY`, `WORLD_COUNTRY`, `EMPLOYEE_ID`, `MEMBER_ID`, `CUSTOMER_ID`, `CONTRACT_NUMBER`, `MONETARY_AMOUNT`, `URL`, `IP_ADDRESS`, etc. | yellow `#ca8a04` | Click to toggle |
| low | `AGE`, `GENDER`, `DATE`, `BLOOD_TYPE`, `POSTAL_CODE`, `SKU`, `KATAKANA_NAME` | slate `#64748b` | Click to toggle |

### Surface-aware escalation

`severity_for_surface(label, value)` promotes the base severity to critical in these cases (shared regex across Python and JS engines):

| Label | Trigger | Example |
|---|---|---|
| `PERSON` / `PROPER_NOUN_PERSON` | Always critical | "田中太郎" |
| `ORGANIZATION` / `COMPANY` / `PROPER_NOUN_ORG` | Surface contains `株式会社`, `㈱`, `有限会社`, `㈲`, `合同会社`, `合資会社` | "株式会社アクメ", "アクメ㈱" |
| `EMAIL_ADDRESS` | Surface in `user@host.tld` shape | `tanaka@acme.com` |

### PERSON false-positive filter

Sudachi and Presidio sometimes mis-tag polite phrases (for example, "ご注意くださいますようお願いいたします") as `PROPER_NOUN_PERSON`. `is_false_positive_person(surface)` drops the detection when:

- Surface length > 6 chars (real names are 2–6).
- Surface contains one of: `ます` `ません` `ください` `いたします` `願い` `注意` `確認` `ご了承` `申し訳` `よろしく` `とおり` `ように` `については` `ところ` `ため` `こと` etc.

Category headers render the worst severity among their children (for example, a `PERSON` category bucket containing an `API_KEY` shows the critical colour). `RuntimeConfig.default_uncheck_below` sets the threshold below which rows start unchecked (default `"low"` = every row masked).

## Common-noun blocklist

Sudachi's `sudachidict_core` occasionally tags generic business katakana (`プロジェクト` / `メンバー` / `チーム`) as proper nouns. `RuntimeConfig.common_noun_blocklist` is a list of surface strings that are dropped before any other filter — exact match, case-sensitive.

Default 26 entries:

```
プロジェクト, メンバー, チーム, マネージャー, リーダー, ユーザー,
クライアント, サーバー, システム, データ, ファイル, フォルダ,
フォルダー, レポート, ミーティング, タスク, チケット, スケジュール,
ドキュメント, アカウント, パスワード, メッセージ, スタッフ,
カスタマー, オフィス, ミーティングルーム
```

The blocklist runs before `min_score` / `enabled_pii_classes` / `allow_entity_types`, so even a high-confidence detection from another analyzer is dropped. Useful for:

- Suppressing false positives — "プロジェクトαの進捗" stays un-tagged.
- Safety net — add "東京" to force-block location leaks regardless of the detection label.

## Setup

Prerequisite: `docker` and `docker compose`. No host-side Python or uv install is required.

### Start the gateway

```bash
cd /path/to/pii-guard
make up                        # build + start + /health wait + admin_token print
make config                    # authed pretty-print of /admin/config
make logs                      # tail container logs
make down                      # stop (keeps data/)
make help                      # full target list
```

`make up` runs `mkdir -p data && docker compose up -d --build` and polls `/health` up to 60 s. `.env` is optional — `ADMIN_TOKEN` is auto-generated on first request and saved to `data/admin_token` (mode 0600).

```bash
TOKEN=$(cat data/admin_token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/config
```

The first build downloads spaCy `en_core_web_lg` (~400 MB), so it takes a few minutes. Subsequent builds are layer-cached. For OCR of Japanese, add `tesseract-ocr-jpn` next to `tesseract-ocr-eng` in the Dockerfile and rebuild.

Dependencies are fully locked by `uv.lock`, which is committed. `docker compose build` runs `uv sync --frozen` against the lock for reproducible installs. Update the lockfile only via a throwaway container:

```bash
docker run --rm -it -v "$PWD:/app" -w /app \
    ghcr.io/astral-sh/uv:0.11-python3.11-bookworm-slim \
    sh -c 'uv add <package> && cat uv.lock > /dev/null'
```

### Autostart (launch the gateway on OS login)

Chrome extensions cannot start Docker themselves due to sandbox restrictions. The autostart scripts wire up OS-login autostart so you only run them once.

Linux / WSL2:

```bash
cd /path/to/pii-guard
bash scripts/install-autostart.sh
```

This installs a systemd user service (`~/.config/systemd/user/mask-mcp-gateway.service`). It falls back to a `~/.bashrc` hook when systemd is not available (WSL without `systemd=true` in `/etc/wsl.conf`). Subsequent logins auto-run `docker compose up -d`. The container itself is `restart: unless-stopped`, so it survives Docker daemon restarts. Verify with `systemctl --user status mask-mcp-gateway`; uninstall with `bash scripts/install-autostart.sh --uninstall`.

Windows (requires WSL and Docker Desktop), from PowerShell without admin:

```powershell
cd C:\Users\<you>\workspace\pii-guard
powershell -File scripts\install-autostart.ps1
```

This registers `MaskMcpGatewayAutostart` in Windows Task Scheduler. On login it runs `wsl -d <distro> -- bash -c "cd <repo> && docker compose up -d"`. Uninstall with `powershell -File scripts\install-autostart.ps1 -Uninstall`.

After installing the extension, if you open the popup while the gateway is unreachable, it shows a "Gateway not found" card with a copy-pasteable install command for your OS.

### Standalone mode (no Docker)

Since `feat/serverless-engine-phase1`, the extension ships with a pure-JavaScript PII detector. You can run the regex presets (EMAIL / PHONE_NUMBER / POSTAL_CODE / MY_NUMBER / API_KEY / BLOOD_TYPE / ANNUAL_INCOME and 40+ other categories) entirely in-browser without the gateway.

Accuracy approximation:

| Category | Standalone (Phase 1) | Gateway (Phase 2 + Presidio) |
|---|---|---|
| Structured PII (email / phone / postal / My Number / API key / …) | ≒ parity | Parity |
| Japanese proper nouns (田中太郎, 株式会社…) | Partial (COMPANY + KATAKANA_NAME only) | High (Sudachi morphological) |
| English PERSON / LOCATION / ORGANIZATION | Not supported | High (Presidio NER) |

By default the extension runs in hybrid mode — use the gateway when it responds at `127.0.0.1:8081`, fall back to standalone when it does not.

## Usage (Gateway API)

Assuming the gateway is running. The `curl` examples below talk to the running container at `127.0.0.1:8081` from the host.

### Mask a single text

```bash
curl -X POST http://127.0.0.1:8081/sanitize/text \
  -H "Authorization: Bearer $(cat data/admin_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text": "John Doe lives at 1 Main St. Email john@example.com"}'
```

The `detections[]` field in `sanitize/text` and `sanitize/file` responses has columns ready for any UI:

| Column | Meaning |
|---|---|
| `entity_type` | Label from Presidio / Sudachi / preset |
| `start` / `end` | Char offsets in the original text |
| `line` / `column` | 1-based line and column (useful for PDF or log referencing) |
| `text` | Matched substring |
| `context_before` / `context_after` | ~20 chars of surrounding context |
| `score` | Presidio confidence (0.0–1.0) |
| `action` | `masked` (replaced) or `allowed` (pass-through) |

### Forward to OpenAI or Anthropic (MITM pass-through)

The gateway is a pure MITM — the client attaches its own provider auth header (`Authorization: Bearer ...` for OpenAI, `x-api-key: ...` for Anthropic). The gateway holds no API keys.

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

### Japanese proper-noun masking (Sudachi)

Set `RuntimeConfig.morphological_analyzer` to `"sudachi"` to add SudachiPy's morphological analyzer on top of Presidio. Only `("名詞","固有名詞",...)` tokens become mask targets (general nouns are skipped).

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

Expected response (excerpt):

```jsonc
{
  "sanitized_text": "<PROPER_NOUN_PERSON>は<PROPER_NOUN_LOCATION>本社にいる",
  "detections": [
    { "entity_type": "PROPER_NOUN_PERSON", "text": "田中太郎", "action": "masked" },
    { "entity_type": "PROPER_NOUN_LOCATION", "text": "東京", "action": "masked" }
  ]
}
```

Both `sudachi_split_mode` and `proper_noun_pos_patterns` are optional with defaults `"C"` (compound proper nouns fused as a single token) and `[["名詞", "固有名詞"]]`. Use `"A"` to split to the smallest unit (e.g. `東京スカイツリー` → `東京` + `スカイツリー`), `"B"` for intermediate granularity, and `"C"` for the longest compounds.

### Language-aware dispatch + custom regex

For mixed-language workloads, `RuntimeConfig.analyzers_by_language` dispatches analyzers by CJK ratio. `RegexAnalyzer` adds org-internal regex patterns that neither Presidio's fixed categories nor Sudachi's proper-noun extractor catch.

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

Each entry in `regex_patterns` is a `[entity_type, regex]` pair, with JSON-escaped backslashes (`\\d`). If `analyzers_by_language` is not set (`null`), the legacy behaviour (Presidio always, Sudachi optional) is preserved so existing deployments are unaffected.

### Aggregated endpoint

`POST /v1/extension/sanitize/aggregated` collapses repeated occurrences of the same surface into one row so the sidebar can render `田中太郎 (2件)` instead of two rows. The original `POST /v1/extension/sanitize` is kept per-occurrence for backward compatibility.

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

`force_masked_categories` is populated when `RuntimeConfig.force_mask_keywords` (default `["リーク","未公開","機密","confidential","leak"]`) is matched as a noun in the source text by Sudachi.

## Browser extension

`ANTHROPIC_BASE_URL` routing only covers Claude Code / SDK callers. The browser-based UIs (Claude.ai, ChatGPT, Gemini, Manus) talk `fetch` directly from the page, so they need a different entry point. That is what `browser-extension/` provides.

| | `ANTHROPIC_BASE_URL` approach | Browser-extension approach |
|---|---|---|
| Scope | Claude Code / Anthropic SDK processes | Browser AI chat UIs |
| Coverage | Anthropic (1 provider) | Claude.ai / ChatGPT / Gemini / Manus |
| Mechanism | HTTP proxy (MITM) | `window.fetch` / `XHR.send` monkey-patch |
| Auth | None (passthrough) | None (loopback trust model) |
| New endpoint | Existing `/proxy/*` | New `POST /v1/extension/sanitize` |

To install: `make up`, then `chrome://extensions` → Developer mode → Load unpacked → pick `browser-extension/`. See [browser-extension/README.md](../browser-extension/README.md) for the full walkthrough, supported services, and known limits.

### Interactive review (default ON)

Detections appear in a Shadow DOM panel right before the send fires. Un-tick false positives (for example, "プロジェクト" or "会社" swept up by the katakana heuristic) to send the original text instead. Enter confirms; Esc cancels the whole send. Turning off "Confirm before send" in the popup reverts to auto-mask (Phase 1 behaviour). The panel is a `z-index: 2147483647` fixed element attached to `document.body` as a Shadow DOM host, so it does not interfere with page DOM or CSS.

### UI modes

| Mode | Behaviour | Endpoint |
|---|---|---|
| Sidebar (default) | Right-side fixed panel. Repeated surfaces collapse into a single `田中太郎 (2件)` row with category folding, bulk ON/OFF, select-all / deselect-all, and live preview. Categories in `force_mask_categories` (default `PERSON` / `ORGANIZATION` / `FINANCIAL`) are locked with a lock icon when keywords like `機密` / `未公開` / `リーク` / `confidential` / `leak` are present; locked rows unlock only via the long-press gate. | `POST /v1/extension/sanitize/aggregated` |
| Modal (legacy) | Same Phase 2 centre modal. One detection per row (per-occurrence). | `POST /v1/extension/sanitize` |

### Sidebar UX

| Feature | Description |
|---|---|
| Push + shrink layout | Sidebar sits as a flex sibling of the chat under `<body>` — never overlaps. Wrapper uses `transform: translateZ(0)` + `contain: layout` so chat's `position: fixed` composer and header stay within the wrapper. `min(400px, 50vw)` responsive width. |
| Independent stacking | `position: relative` + `z-index: 2147483647` + `isolation: isolate`. Host-page sticky/fixed elements never leak onto the panel. |
| Mode pill (header right) | Colour-coded pill shows `AI 置換 (実験的)` / `検出補助 (Regex + AI)` / `Regex のみ`. |
| Theme sync | Reads host background via `getComputedStyle`; luminance < 0.5 applies the dark palette. |
| Severity filter tabs | `All` / `Critical` / `High` / `Medium` / `Low` segment control. |
| Interaction rules (v0.5.0 final) | Long-press is required only for masked critical rows. Everything else (critical-unmasked, locked, high, medium, low) is a single tap. Long-press duration is adjustable 0–1.5 s via a slider. |
| Before/after grid | 4-column grid `[icon] [original] [→] [masked]`. Long values use `text-overflow: ellipsis` with full text stored in `title`. |
| Green bar (right edge) | On unmasked rows — visual cue that "this value will be sent as is". |
| Exclude button | Per-row `✖ 除外` writes to `chrome.storage.local.maskAllowlist` and auto-unmasks that value on future detections. |
| Occurrence count | Second line shows `出現回数 N回` (N occurrences in the input). |
| AI analysis overlay | While the LLM thinks, a centred double-ring spinner with `AI 分析中…` / `AI 置換中…` overlays the sidebar. `pointer-events: none` lets the regex rows beneath stay operable. Rows stagger-in (80 ms × index) once the LLM resolves; the overlay fades out afterwards. |
| AI detection badge | LLM rows show a `✨` icon (purple pulse drop-shadow) and a purple gradient `● AI 検出` pill on the second line. |
| Unique numbered tags (replace mode) | Same surface → same tag; different surface → different number (`<name_1>`, `<name_2>`, `<company_1>`, …). 1:1 restorable mapping keeps downstream AI services from reconstructing the original. |
| Category-header-only lock | Force-masked lock icons sit on the category row, not on each individual row (visual noise reduction). |

### Allowlist database

Manage via `chrome://extensions` → right-click icon → Options, or the `⚙ 詳細設定` button in the popup:

- Add / remove / clear entries.
- JSON export (timestamped) / JSON import (deduped merge).
- Master enable/disable, interactive toggle, UI mode radio, gateway health badge.
- Dark-mode aware.

Cross-tab live sync: adding an entry in one tab fires `chrome.storage.onChanged` → `content.js` → `injected.js` → `mask-mcp:settings-updated` CustomEvent. All open tabs unmask the row without reload.

### Socket.IO (WebSocket) support

manus.im uses Socket.IO over WebSocket, which does not pass through `fetch` or `XHR`. A dedicated hook handles it:

1. `injected.js` wraps `WebSocket.prototype.send`.
2. Parses Engine.IO v4 EVENT frames (`42[...]` / `4213[...]`).
3. Masks only the `value` field inside `["message", {type:"user_message", contents:[{type:"text", value:"..."}]}]`.
4. ping / pong / CONNECT / DISCONNECT / ACK pass through unchanged.
5. On user cancel, only that frame is silently dropped (the WebSocket stays open, so the chat session is preserved).

The manus WebSocket URL carries a JWT via `?token=...`. Diagnostic logs redact `token` / `auth` / `key` / `sentry_key` query params to `REDACTED`, so session credentials do not leak from diagnostic output.

## Local LLM proxy (v0.5.0)

No gateway required — browser extension + local Ollama (or LM Studio / llama.cpp) gives you context-aware PII detection. Three modes selectable from the options page:

- `Regex only` — legacy behaviour, no LLM.
- `Augmented detect (Regex + AI)` — LLM adds contextual PII; shared surfaces are overwritten with LLM labels; regex remains the safety net for structured PII (email, credit card, phone).
- `AI replace (experimental)` — LLM rewrites the whole input into `<tag_N>` placeholders before send. `applyUniqueTagsToReplace()` guarantees same surface → same tag and different surface → different numbers.

### Minimal setup

```bash
# 1) Run Ollama with CORS allowed (the extension uses a chrome-extension:// origin)
docker run -d --name ollama --gpus all \
  -e OLLAMA_HOST='0.0.0.0:11434' \
  -e OLLAMA_ORIGINS='*' \
  -p 11434:11434 \
  -v ollama:/root/.ollama \
  --restart unless-stopped \
  ollama/ollama:latest

# 2) Pull a model (light: qwen3:1.7b; balanced: qwen3:4b)
docker exec -it ollama ollama pull qwen3:4b

# 3) From the extension options page
#    - enable local LLM integration
#    - set URL to http://localhost:11434
#    - 接続確認 and pick a model
```

### Architecture notes

- Service worker proxy: Chrome's Private Network Access (PNA) policy blocks HTTPS pages from fetching `http://localhost`. All LLM calls are relayed through the privileged service worker via an `LLM_FETCH` message.
- Host-lock: the service worker rejects any URL whose host or protocol does not match `chrome.storage.local.localLlmUrl`. It cannot be repurposed as a general HTTP proxy.
- Sender-ID check: foreign extensions relaying through the SW are rejected — `sender.id !== chrome.runtime.id` fails.
- `think: false` + `format: "json"`: three required params in every Ollama request — `think: false` (suppresses Qwen3 thinking tokens), `format: "json"` (JSON grammar constraint), `num_predict: 2048` (generation cap).
- Multi-stage retry: `500/503 "loading model"` → up to 6× with 3 s spacing; `AbortError` (inference stall) → up to 2× with 2 s spacing. Inner bridge budget = `timeoutMs × 3 + 30 s` covers all retries.
- Unique numbered tags: replace-mode output is normalised into a 1:1 map — `<name_1>`, `<company_2>`, `<hospital_1>` — same surface → same tag; different values → different numbers.
- Fail-closed on replace / fail-open on detect: any replace failure aborts the whole outbound request; detect failures leave regex/Sudachi results intact.

### Recommended models (v0.5.0+)

The system prompt for assist mode is the same for every input. It has examples in both Japanese and English, and one example shows that instructions written inside the input are ignored. The model returns only values and labels, without reasons. Tailoring the prompt to the model size or to the regex findings was tried and lowered accuracy, so it is not used. The design and the evaluation results are in [llm-prompt-optimization.md](./llm-prompt-optimization.md) (Japanese).

After changing the prompt, compare it with the current one on a real LLM:

```bash
node scripts/eval-llm-prompts.mjs --url http://127.0.0.1:11434 --models qwen3:4b,qwen3:1.7b --verbose
node tests/integration/e2e-llm-detect.mjs browser-extension http://127.0.0.1:11434 qwen3:1.7b
```

| Model | Size | VRAM | Badge |
|---|---|---|---|
| `qwen3:1.7b` | 1.1 GB | ~1.5 GB | light |
| `qwen3:4b` | 2.5 GB | ~3 GB | recommended |
| `qwen3:8b` | 4.7 GB | ~5 GB | high-accuracy |
| `qwen3:14b` | 8.2 GB | ~9 GB | top-accuracy |
| `gemma3:4b` | 2.5 GB | ~3 GB | alternative |
| `llama3.2:3b` | 2.0 GB | ~2 GB | alternative |
| `phi3.5:3.8b` | 2.2 GB | ~2.5 GB | alternative |

One-click download (`POST /api/pull` streaming NDJSON with progress bar) and delete (`DELETE /api/delete` with a confirmation dialog) are available from the options page. Deleting the currently-selected model also clears `localLlmModel`.

### Known limits

| Symptom | Cause | Fix |
|---|---|---|
| 403 (CORS) | `OLLAMA_ORIGINS` not set | Add `OLLAMA_ORIGINS: "*"` to the compose env; the options page's 接続確認 detects this and shows the remediation command. |
| Slow first call | 4B+ models take 20–40 s cold; 9B+ thinking models 60–90 s | Bump the timeout from 120 000 ms (default) to 240 000 ms. |
| LLM flags generic words (`エンジニア`, `アクセスキー`) | Model over-detection | Prompt `HARD NEGATIVE LIST` plus client-side `LLM_DENYLIST` / `LLM_DENY_REGEX`. |
| No result on Qwen3 | Old `think: true` default consumed the token budget | Current code forces `think: false`. Reload the extension. |

See [browser-extension/README.md#local-llm-proxy-v050-experimental](../browser-extension/README.md#local-llm-proxy-v050-experimental) for full config, log samples, and the security model.

## Claude Code / Claude Desktop integration

Combining the gateway with Claude Code or Claude Desktop lets you mask PII automatically on every outbound request to Anthropic.

### Option 1: Claude Code — `ANTHROPIC_BASE_URL` (streaming supported)

The Anthropic SDK inside Claude Code honours the `ANTHROPIC_BASE_URL` environment variable. Pointing it at the gateway's `/proxy/anthropic` routes every API call through the gateway; user-text PII is masked before Anthropic receives it.

```bash
make up
ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude

alias claude-safe='ANTHROPIC_BASE_URL=http://127.0.0.1:8081/proxy/anthropic claude'
```

Data flow:

```
your input (Enter)
  → Claude Code SDK → http://127.0.0.1:8081/proxy/anthropic/v1/messages
  → gateway masks PII inside messages[]
  → masked payload → https://api.anthropic.com/v1/messages
  → streaming response flows back as-is
```

`stream: true` requests (the default in Claude Code) are relayed frame-by-frame, so tokens appear at the same pace as a direct call. `x-api-key` is the client's; the gateway does not need one.

### Option 2: Claude Desktop — MCP server

Claude Desktop can register servers that expose MCP (Model Context Protocol) tools. This project's MCP server publishes the following:

| Tool | Description |
|---|---|
| `sanitize_text(text, mask_strategy)` | Detect and mask PII in a text. |
| `detect_language(text)` | Return ja / en / mixed. |
| `set_analyzer_config(...)` | Update analyzer chain. |
| `set_provider(provider_id)` | Switch default upstream provider. |
| `toggle_filter(enabled)` | Master on/off. |
| `get_runtime_config()` | Dump current config. |

Setup:

1. Make the wrapper executable (first time only):

   ```bash
   chmod +x scripts/mcp-stdio.sh
   ```

2. Edit `claude_desktop_config.json`:
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`

   WSL (Claude Desktop runs on Windows and reaches into WSL via `wsl`):

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

   Mac / native Linux (direct):

   ```json
   {
     "mcpServers": {
       "pii-guard": {
         "command": "/absolute/path/to/pii-guard/scripts/mcp-stdio.sh"
       }
     }
   }
   ```

3. Restart Claude Desktop. `sanitize_text` and the other tools appear in the tool list.

Option 1 (Base URL) masks every request automatically, whereas MCP masks only when Claude calls the tool. Pick option 1 for "always safe", option 2 for "on demand".

## Chrome Web Store build

`browser-extension/` is the dev build — it includes the local-LLM proxy, `http://*/*` host permission, and the options-page LLM config card. None of that is shipped to the Store.

Produce the Store distributable with:

```bash
./scripts/build-store.sh
# → dist/browser-extension-store/         (unpacked, Load unpacked OK)
# → dist/browser-extension-store.zip      (upload to Developer Dashboard)
```

The script:

1. Copies `browser-extension/` → `dist/browser-extension-store/`.
2. Replaces `manifest.json` with `manifest.store.json` (no `http://*/*`, 6 chat-provider hosts only).
3. Deletes `engine/surrogates.js` and `engine/llm-prompts.js`.
4. Strips every `STORE-STRIP:START … STORE-STRIP:END` block with `sed` (both HTML and JS comment forms supported).
5. Validates: no `http://*/*` in manifest, no stray markers, no references to deleted files, valid JSON, every `.js` passes `node --check`.
6. Zips for Developer Dashboard upload.

See [browser-extension/README.md#building-the-chrome-web-store-variant](../browser-extension/README.md#building-the-chrome-web-store-variant) for details.

## Tests

Tests run inside a Docker build stage — the host installs nothing.

```bash
make test
# internally: docker build --target test --progress=plain -t local-mask-mcp:test .
```

The `test` stage extends `builder`, adds dev deps (pytest / pytest-asyncio / ruff) plus the spaCy model and tesseract, then runs `uv run pytest tests/ -v`. Any failing test fails the build, so it works as-is for a CI gate. `make up` and `docker compose build` skip this stage.

## Directory layout

```text
pii-guard/
├── browser-extension/          Chrome MV3 extension (dev build)
│   ├── manifest.json           dev manifest (http://*/*, full LLM engine)
│   ├── manifest.store.json     Web-Store manifest (LLM stripped)
│   ├── content.js              isolated-world bridge + LLM_FETCH routing
│   ├── injected.js             main-world fetch/XHR/WebSocket hooks
│   ├── sidebar.js              Shadow DOM sidebar UI
│   ├── review-modal.js         Shadow DOM review modal UI
│   ├── background.js           service worker (badge + per-tab count + LLM proxy)
│   ├── options.html/css/js     options page (allowlist, LLM config, UI mode)
│   ├── popup.html/css/js       toolbar popup
│   └── engine/                 standalone JS engine
│       ├── engine.js             sweep-line overlap resolver + pipeline
│       ├── patterns.js           BUILTIN_PATTERNS (regex presets)
│       ├── classification.js     label → classification
│       ├── categories.js         label → big category
│       ├── severity.js           label → severity tier + surface escalation
│       ├── ts-sudachi.js         mini Sudachi-like JP morphological analyzer
│       ├── force-mask.js         force_mask_keywords lock decider
│       ├── blocklist.js          DEFAULT_COMMON_NOUN_BLOCKLIST
│       ├── surrogates.js         (dev only) type-preserving fake values
│       ├── llm-prompts.js        (dev only) /no_think prompt + few-shot
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
│   ├── build-store.sh          Web-Store build pipeline
│   ├── install-autostart.sh    Linux/WSL2 gateway autostart
│   ├── install-autostart.ps1   Windows gateway autostart
│   ├── mcp-stdio.sh            MCP stdio wrapper (Docker-backed)
│   └── generate-icons.py       extension icon generator
├── tests/                      pytest suite
├── docs/                       requirements and design docs
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── uv.lock                     dependency lockfile (committed)
├── CHANGELOG.md                root CHANGELOG (gateway side)
├── TODO.md                     roadmap
└── README.md                   this file
```
