# TODO / Roadmap

This file tracks the roadmap for `local-mask-mcp` — a local PII-masking
gateway with MCP adapter and pass-through LLM proxy.

## Vision

Turn the gateway from a **Presidio-only (English-oriented, fixed-category)
masker** into an extensible, **language-aware**, **multi-analyzer** system.

The flagship addition is **Japanese proper-noun masking via morphological
analysis** (SudachiPy / GiNZA / Fugashi). Every 固有名詞 (proper noun)
detected by the analyzer becomes a mask target, regardless of whether it
matches one of Presidio's predefined entity categories. 一般名詞 (common
nouns) are intentionally excluded, matching the user's stated requirement:

> テキスト、ドキュメント、中に含まれる一般名詞を除く固有名詞などを形態素解析
> によって抽出されたデータをマスクする手法

In other words: run `text` → morphological analyzer → filter tokens where
POS starts with `名詞,固有名詞` → mask those spans.

## Status legend

- `[ ]` open — not yet started
- `[~]` in progress — feature branch exists, work in flight
- `[x]` done — merged to `main`

## Working agreement

- Each feature lives on its own branch, named after the bullet below
  (`feat/...`, `refactor/...`, `docs/...`, `chore/...`).
- Every feature branch is implemented by a dedicated **Agent Team**,
  spawned with `Agent(... isolation: "worktree")` so parallel work does
  not step on each other.
- A feature branch is merged back into `main` only after the Docker
  `test` target (`make test`) is green inside the worktree.
- `uv.lock` is the single source of truth for the dependency set. New
  dependencies are added via a throwaway uv container so the host does
  not need uv installed:
  ```bash
  docker run --rm -it -v "$PWD:/app" -w /app \
      ghcr.io/astral-sh/uv:0.11-python3.11-bookworm-slim \
      uv add <package>
  ```
- Every PR / merge must keep `make test` passing and the documented
  `entity_types` / `allow_entity_types` / `mask_strategy` contract
  backward compatible.

---

## Milestone 1 — Japanese proper-noun masking (MVP)

Goal: a user can POST Japanese text containing person/place/organization
names through `/sanitize/text` and see them masked, without touching the
existing Presidio English path.

- [x] **feat/sudachi-analyzer** — merged in `7614b83`, 5 commits, 15/15 tests green.
  Follow-ups discovered during implementation are tracked in Milestone 4 below
  (split-mode config, overlap resolver optimization, surname/placename
  ambiguity, conftest extraction).
  - Add `sudachipy` + `sudachidict_core` as runtime dependencies via
    `uv add`; commit both `pyproject.toml` and the regenerated
    `uv.lock`.
  - New module `src/app/services/sudachi_analyzer.py` with a
    `SudachiProperNounAnalyzer` class that:
    - Instantiates a `sudachipy.Dictionary().create()` tokenizer once
      at `__init__` time (analogous to `AnalyzerEngine()` for Presidio).
    - Exposes `analyze(text: str) -> list[PresidioLikeDetection]` where
      each detection has `entity_type="PROPER_NOUN"` (or the finer
      subcategory — 人名 / 地名 / 組織名), `start` / `end` byte offsets,
      and `score=1.0`.
    - Filters tokens whose POS tuple's first two fields are
      `("名詞", "固有名詞")`; 一般名詞 and non-nouns are discarded.
  - Integrate into `MaskingService.sanitize_text` as a secondary
    analyzer that runs in addition to Presidio. Detections are merged
    before the masking strategy is applied, with overlapping spans
    resolved by taking the higher-confidence entry.
  - New runtime config field `morphological_analyzer: Literal["sudachi", "none"] = "none"`
    so existing deployments do not change behaviour until they opt in.
  - Japanese unit tests in `tests/test_sudachi_analyzer.py` covering:
    - 人名 detection (`田中太郎`, `山田`, `SATO`)
    - 地名 detection (`東京`, `大阪府`, `渋谷区`)
    - 組織名 detection (`グーグル`, `株式会社マスクテスト`)
    - 一般名詞 non-detection (`会社`, `今日`, `りんご`)
    - Overlap handling when Presidio and Sudachi both fire on the
      same span.
  - Dockerfile: bake the Sudachi dictionary into the builder stage's
    `/opt/venv` exactly the way spaCy `en_core_web_lg` is baked today.
    Must NOT re-download the dict at container start.
  - Update `README.md` and `docker-compose.yml` comments with a
    Japanese example.
  - Acceptance: `make test` green with the new tests, `make up` +
    curl round-trip shows `田中太郎` masked in `sanitized_text`.
  - Depends on: nothing.

- [x] **feat/pos-filter-config** — merged in `1c47adc` alongside
  `feat/sudachi-split-mode-config` on the shared
  `feat/sudachi-config-pack` branch, 18/18 tests green.
  - Expose the set of POS prefixes that count as "proper noun" as
    `RuntimeConfig.proper_noun_pos_patterns: list[list[str]]`.
  - Default value: `[["名詞", "固有名詞"]]`.
  - Allow users to broaden (e.g. add `["名詞", "一般", "人名"]` for
    IPAdic variants) or tighten (e.g. exclude 地名).
  - Depends on: `feat/sudachi-analyzer`.

---

## Milestone 2 — Analyzer abstraction

Goal: `MaskingService` stops talking to Presidio/Sudachi directly and
instead composes a list of `Analyzer` implementations, so adding a new
backend (GiNZA, Fugashi, custom regex) is a one-file change.

- [x] **refactor/analyzer-protocol** — merged in `8dd1261`. Introduces
  `src/app/services/analyzers/{base,presidio,sudachi}.py` with an
  `Analyzer` Protocol + `AnalyzerRequest` dataclass. `MaskingService`
  now holds `self._analyzers: dict[str, Analyzer]` and constructs on
  demand. 15/15 tests still green, byte-for-byte behavioral identity.
  - Introduce `Analyzer` `Protocol` in `src/app/services/analyzers/base.py`
    with `analyze(text: str, config: RuntimeConfig) -> list[Detection]`.
  - Extract the existing Presidio calls into
    `src/app/services/analyzers/presidio.py` (`PresidioAnalyzer`).
  - Move `SudachiProperNounAnalyzer` under the same package.
  - `MaskingService` holds `analyzers: list[Analyzer]` and concatenates
    their results before running the masking strategy.
  - No behaviour change for existing clients.
  - Depends on: `feat/sudachi-analyzer`.

- [x] **feat/custom-regex-recognizer** — landed on the shared
  `feat/language-and-regex` branch (combined with Milestone 3 below
  because the three features all touch the Analyzer protocol +
  MaskingService and would conflict if done separately). 29/29 tests
  green. Merge SHA `6ee2001`.
  - `RegexAnalyzer` — pattern list in config, first-class analyzer.
  - Useful for employee IDs, internal project codes, free-text
    passwords that slip past both Presidio and Sudachi.
  - Depends on: `refactor/analyzer-protocol`.

---

## Milestone 3 — Language-aware routing

Goal: detect the text's language with a cheap heuristic and run only
the analyzers relevant to it, avoiding Presidio's English NER running
against Japanese (or vice versa).

- [x] **feat/language-detection** — landed on the shared
  `feat/language-and-regex` branch together with
  `feat/language-aware-dispatch` and `feat/custom-regex-recognizer`.
  29/29 tests green. Merge SHA `6ee2001`.
  - Simple CJK-ratio detector returning `"ja"` / `"en"` / `"mixed"`.
  - Pure-Python, no new dependency.

- [x] **feat/language-aware-dispatch** — landed on the shared
  `feat/language-and-regex` branch alongside `feat/language-detection`
  and `feat/custom-regex-recognizer`. Opt-in via
  `RuntimeConfig.analyzers_by_language`; legacy path is byte-for-byte
  preserved. 29/29 tests green. Merge SHA `6ee2001`.
  - `MaskingService` selects analyzer subset by detected language.
  - Config: `analyzers_by_language: dict[str, list[str]]`.
  - Depends on: `refactor/analyzer-protocol` + `feat/language-detection`.

---

## Milestone 4 — Observability & polish

- [x] **feat/score-threshold** — merged on `feat/polish-pack`. Adds
  `RuntimeConfig.min_score: float = 0.0` and applies it once on the
  merged analyzer result set in `MaskingService.sanitize_text`, before
  the allow-list filter. Default 0.0 is a no-op so existing deployments
  are unaffected; raise it to silence Presidio false positives like
  `Reach → PERSON`. 30/30 tests green.

- [x] **feat/audit-query-endpoint** — merged on `feat/final-wave`
  (SHA pending). `/admin/audits` now accepts optional `since=<iso>`,
  `entity_type=<str>`, `action=masked|allowed`, and `limit=<int>`
  query params. Zero-param call is byte-for-byte compatible with the
  legacy "last 100" behaviour; the four filters layer on top and
  `limit` applies after filtering so narrow queries still return up
  to N matches.

- [x] **docs/architecture-diagram** — merged on `feat/final-wave`
  (SHA pending). Added a 37-line ASCII diagram to the
  アーキテクチャ概要 section in `README.md` covering the analyzer
  chain, language dispatch, MITM proxy flow, and audit log.

- [x] **feat/sudachi-split-mode-config** — merged in `1c47adc`
  alongside `feat/pos-filter-config` on the shared
  `feat/sudachi-config-pack` branch, 18/18 tests green.
  Exposes `sudachi_split_mode: Literal["A", "B", "C"] = "C"` in
  `RuntimeConfig` so operators who prefer finer-grained tokenization
  (e.g. to mask morpheme-level components of compound names) can opt
  in. `MaskingService` rebuilds the cached Sudachi analyzer whenever
  the configured split mode changes between requests.

- [x] **chore/sudachi-overlap-sweep-line** — merged on
  `feat/final-wave` (SHA pending). Rewrote `_resolve_overlaps` in
  `masking_service.py` as a single linear sweep over results sorted
  by `(start, -end)` with a running "envelope" of the strongest
  dominator. Final complexity is O(n log n) from the sort plus O(n)
  walk; semantics are preserved exactly (identical spans still
  survive each other, ties deterministic). Pinned correctness with
  one 50-detection synthetic test.

- [x] **feat/sudachi-surname-placename-disambiguation** — merged on
  `feat/final-wave` (SHA pending). Added a `prefer_surname_for_ambiguous`
  bool to `RuntimeConfig` (default `False`). When set, the Sudachi
  analyzer relabels detections whose surface is in a hardcoded
  `{千葉, 神戸, 岡山, 福岡}` set from `PROPER_NOUN_LOCATION` to
  `PROPER_NOUN_PERSON`. Pragmatic hack, not ML — the docstring calls
  that out explicitly. Operators needing real disambiguation should
  reach for GiNZA / spaCy-ja or a custom NER, both out of scope.

- [x] **chore/tests-conftest** — merged on `feat/polish-pack`. The
  duplicated `DummyConfigRepository` / `DummyAuditRepository` helpers
  now live in `tests/conftest.py` and are exported both as importable
  classes (for tests that pass a custom `RuntimeConfig`) and as
  `dummy_config_repo` / `dummy_audit_repo` pytest fixtures. 30/30
  tests green.

---

## Milestone 5 — MCP surface

- [x] **feat/mcp-language-tool** — merged on `feat/final-wave`
  (SHA pending). Exposed `detect_language(text) -> {"language": ...}`
  as an MCP tool, thin wrapper over
  `app.services.language_detection.detect_language`.
- [x] **feat/mcp-analyzer-tool** — merged on `feat/final-wave`
  (SHA pending). Added
  `set_analyzer_config(morphological_analyzer, analyzers_by_language)`
  that updates RuntimeConfig via `config_repo.save()` and returns
  the new config. Tight scope: two fields only, Pydantic does the
  validation.

---

## Milestone 6 — Comprehensive PII detection presets

Goal: ship a built-in pattern set for Japanese PII detection so that
addresses, ages, gender, company names, monetary amounts, database
names, project identifiers, and other sensitive categories are masked
by default — not just what Presidio or Sudachi catch.

- [x] **feat/detection-checklist** — merged in `e4e3dc9`.
  Added `src/app/services/analyzers/presets.py` with 16 categorized
  regex pattern sets covering ADDRESS, AGE, GENDER, MONETARY_AMOUNT,
  DATE, COMPANY, IP_ADDRESS, URL, MY_NUMBER, BANK_ACCOUNT,
  DRIVERS_LICENSE, PASSPORT, DB_CONNECTION, API_KEY, INTERNAL_ID,
  and PHONE_NUMBER_JP. Patterns load automatically via
  `RuntimeConfig.enable_preset_patterns` (default True). Individual
  categories can be disabled via `disabled_pattern_categories`.
  MaskingService merges presets with user-supplied `regex_patterns`
  and ensures the regex analyzer runs in both legacy and language-
  aware dispatch modes. 40/40 tests green (8 new preset tests).

---

## Milestone 7 — Browser extension MITM (universal AI service coverage)

Goal: intercept outbound fetch/XHR from Chrome-family browsers on
sites like Claude.ai Web / chat.openai.com / gemini.google.com /
manus.im so the user's input is masked **before** it leaves the
browser. Detailed spec: see `plans/feat-universal-llm-masking-proxy-2026-04-15.md`.

Architecture decision (from plan Q1-Q8):
- Option B (browser extension + local gateway + rule-based) for MVP.
- Option A (Ollama local LLM analyzer) added in Phase 3.
- No system TLS interception, no per-service DOM hooking.

- [x] **feat/browser-extension-phase1** — shipped on
  `feat/browser-extension-phase1` (SHA `ceaad19`), 44/44 tests green.
  - `browser-extension/` directory at repo root: Chrome MV3 extension
    (Chromium-family only: Chrome / Edge / Brave).
  - Split into `content.js` (isolated-world bridge) + `injected.js`
    (page MAIN-world fetch / XHR monkey-patch). The split was
    load-bearing: MV3 content scripts can't patch the page's real
    `window.fetch` from the isolated world, so `injected.js` runs
    in `MAIN` and talks back to `content.js` via `postMessage` for
    the `chrome.*` operations (gateway call, storage read, badge).
  - `background.js` service worker — per-tab detection counts +
    badge text; resets on `tabs.onUpdated` URL change.
  - `popup.html` + `popup.js` + `popup.css` — enabled toggle, live
    gateway `/health` probe, per-tab detection count, deep-link to
    the gateway Swagger UI.
  - Per-service adapter registry with `match` / `extractInputs` /
    `replaceInputs` for Claude.ai, ChatGPT, Gemini, Manus. Claude.ai
    is the primary target; the others are best-effort and flagged in
    the extension README.
  - Gateway side: `src/app/routes/extension.py` exposes
    `POST /v1/extension/sanitize` (unauthenticated; loopback trust
    model). `src/app/main.py` gains `CORSMiddleware` with an
    `allow_origin_regex` of `chrome-extension://.*`.
  - `MaskingService.sanitize_text` grew two keyword-only audit
    annotations (`request_type` / `upstream_target`) with defaults
    that preserve byte-for-byte identity for every existing caller.
  - New audit tag `"extension"` in `AuditRecord.request_type`.
  - `tests/test_extension_route.py` covers the happy path, no-auth
    contract, audit-record tagging, and CORS preflight.
  - Icons: 16 / 48 / 128 px RGBA PNGs generated via Pillow inside
    the existing `local-mask-mcp:latest` image
    (`browser-extension/scripts/generate-icons.py`) — no host Pillow
    or font-file dependency required.
  - README.md gets a new "ブラウザ拡張 (全生成AIサービス対応)"
    section right after "Claude 連携".

  Follow-ups moved to `feat/browser-extension-phase2`:
  - Per-service adapter tuning against live traffic (ChatGPT's
    `/backend-api/f/conversation` variant and Gemini's `f.req` form
    are the two highest-risk heuristics).
  - FormData / multipart handling for services that start shipping
    attachments through the same endpoints.
  - Streaming-response path (Phase 1 scope was Q3 = 送信のみ).

- [x] **feat/interactive-review-ui** — merged on
  `feat/interactive-review-ui` (SHA `d602789`), 46/46 tests green.
  Closes two detection gaps + ships the interactive review modal
  that was the headline Phase 2 UX request:
  - `presets.py` gains `EMAIL_ADDRESS` (permissive pattern for new
    gTLDs like `.fizz` / `.xyz` that Presidio's built-in recognizer
    misses) and `KATAKANA_NAME` (heuristic for ≥ 4-char katakana
    runs that SudachiPy's default dict doesn't flag).
  - Browser extension gets `review-modal.js`, a Shadow-DOM-scoped
    overlay at `z-index: 2147483647` on `document.body` with
    per-detection checkboxes, colour-coded entity badges, and
    Enter/Esc keyboard control. Host page DOM/CSS is never
    touched; on dismissal the overlay is removed completely.
  - `injected.js` awaits the modal when interactive mode is on
    and rebuilds the masked payload client-side from the ticked
    indices (tag strategy only — partial/hash are gateway-only).
  - Popup gains a second checkbox "送信前に確認する
    (インタラクティブ・モード)" (default ON). Background worker
    seeds both `enabled` and `interactive` keys on install.

- [ ] **feat/browser-extension-phase2** — remaining Phase 2 items:
  popup UI for category toggles, per-service enable/disable, audit
  viewer (read-only). The interactive-review modal above counts as
  the first Phase 2 UX slice.
  Depends on: phase1.

---

## Milestone 8 — UI masking control layer

Goal: the browser extension's review panel shows one row per **unique
masked surface** (集約) instead of per-occurrence, buckets them by a
big display **category**, and force-locks sensitive categories when a
red-flag keyword like `リーク` / `未公開` / `機密` appears in the input.
Planning spec: `plans/feat-ui-masking-control-layer-2026-04-15.md`.

### Wave A — backend (this branch)

- [x] **feat/aggregation-and-business-patterns** — merged from
  `feat/aggregation-and-business-patterns` (SHA `10651e7`), 73/73
  tests green. Four additions landed together:
  - `src/app/services/category_map.py` — label→category table (7 big
    categories: PERSON / LOCATION / ORGANIZATION / CONTACT /
    FINANCIAL / CREDENTIAL / IDENTITY + INTERNAL_ID; unmapped labels
    fall back to `OTHER`).
  - `AggregatedEntity` + `AggregatedExtensionResponse` Pydantic models
    in `src/app/models/schemas.py`, plus
    `src/app/services/aggregation.py` with `aggregate_detections()`
    that collapses duplicate surfaces, first-occurrence wins the
    label, dedupes identical `(start, end)` spans that two analyzers
    legitimately flag.
  - `RuntimeConfig.force_mask_keywords` +
    `RuntimeConfig.force_mask_categories` with the new
    `src/app/services/force_mask.py` module: Japanese keywords are
    POS-checked via Sudachi (must be 名詞 head), ASCII keywords use
    case-insensitive substring match.
  - New endpoint `POST /v1/extension/sanitize/aggregated` returning
    the aggregated shape. Original `/v1/extension/sanitize` remains
    unchanged for backward compat.
  - `presets.py` + 15 new business-document categories: POSTAL_CODE,
    DEPARTMENT, CONTRACT_NUMBER, PURCHASE_ORDER, CUSTOMER_ID,
    INVOICE_NUMBER, EMPLOYEE_ID, MEMBER_ID, PATIENT_ID, SKU,
    BLOOD_TYPE, ANNUAL_INCOME, PATENT_NUMBER, ASSET_NUMBER,
    LICENSE_NUMBER.

### Wave B — frontend (next branch)

- [x] **feat/ui-masking-sidebar** — merged from
  `feat/ui-masking-sidebar` (SHA `ae97479`), 73/73 tests green
  (zero Python changes — frontend only). Ships the Shadow-DOM
  sidebar that consumes `POST /v1/extension/sanitize/aggregated`:
  - `browser-extension/sidebar.js` (new, ~920 LOC) — right-side
    fixed panel at `z-index: 2147483647` with one row per unique
    `(category, value)` pair, tri-state category toggles,
    すべて選択 / すべて解除 bulk actions, and a live preview pane
    that re-applies tag substitutions client-side on every
    checkbox change (no keystroke-triggered fetches). Categories
    listed in `force_masked_categories` show 🔒 and have their
    checkboxes `disabled` so neither row nor parent toggle nor
    bulk actions can ever uncheck them. Hand-rolled CSS
    variables: indigo `#4f46e5` primary, red `#dc2626` danger,
    gray `#f9fafb` background, rounded-xl `12px`, the spec'd
    `0 10px 25px rgba(0,0,0,0.12)` shadow. Slide-in via
    `transform: translateX(...)`. Focus trap wraps Tab through
    the panel; Enter confirms; Esc cancels.
  - `browser-extension/injected.js` — dispatch layer reads
    `window.__localMaskMCP.settings.uiMode` (default `"sidebar"`)
    and routes to the matching helper. Sidebar path uses the new
    aggregated endpoint and feeds `decision.maskedPositions` (a
    flat `[start, end, label]` triple list) into a new
    `applyTriples()` helper. Modal path is unchanged.
  - `browser-extension/content.js` — injects `sidebar.js` between
    `review-modal.js` and `injected.js`; new
    `handleSanitizeAggregated` bridge sharing a `callGateway()`
    helper with the legacy handler. Settings broadcast carries
    `uiMode` alongside `interactive`.
  - `browser-extension/popup.{html,css,js}` + `background.js` +
    `manifest.json` — new `UI モード` radio (default サイドバー);
    `onInstalled` seeds the `uiMode` storage key; `manifest.json`
    bumped to `0.2.0` and lists `sidebar.js` under
    `web_accessible_resources`.
  - Browser extension `README.md` + `CHANGELOG.md` updated with a
    サイドバーモード section and an ASCII layout sketch. Root
    `README.md` ブラウザ拡張 section gains a UI-mode comparison
    table.
  - Verified end-to-end against the running gateway via curl
    (`force_masked_categories: ["PERSON","ORGANIZATION","FINANCIAL"]`
    when `confidential` keyword is present).

- [x] **feat/severity-and-common-noun-blocklist** — Milestone 7/8
  Wave C (backend + frontend, `v0.3.0` extension). 102/102 tests
  green (87 existing + 15 new). Three linked changes:
  - `src/app/services/severity.py` (new) — `LABEL_TO_SEVERITY`
    map classifying every known analyzer label into one of four
    risk tiers: `critical` (identity-theft / credential vectors —
    MY_NUMBER, PASSPORT, DRIVERS_LICENSE, CREDIT_CARD,
    BANK_ACCOUNT, API_KEY, SECRET, DB_CONNECTION), `high`
    (directly identifying — PERSON / PROPER_NOUN_PERSON /
    EMAIL_ADDRESS / PHONE_NUMBER / ADDRESS / PATIENT_ID),
    `medium` (structured business / monetary / URL /
    organizational data), `low` (demographic attributes +
    noisy katakana heuristics). Unknown labels default to
    `low` so adding a new analyzer is purely additive.
    `SEVERITY_ORDER` + `severity_for()` + `max_severity()`
    helpers. `DetectionResult.severity` +
    `AggregatedEntity.severity` populated in
    `MaskingService._build_detection_results` /
    `aggregate_detections`. New `RuntimeConfig.default_uncheck_below`
    config surface (default `"low"` preserves mask-everything).
  - `RuntimeConfig.common_noun_blocklist` — configurable drop
    list with 26 default generic Japanese business loanwords
    (`プロジェクト`, `メンバー`, `チーム`, `マネージャー`,
    `システム`, `データ`, `ファイル` …). Applied BEFORE
    `min_score` / `enabled_pii_classes` / `allow_entity_types`
    so a blocked surface cannot survive via downstream
    re-classification. Operators can add a surface like `東京`
    to force-drop even real proper nouns (defensive knob).
  - `browser-extension/sidebar.js` — severity colour coding
    (left border + pill), category-header pills at worst-child
    severity, 800 ms long-press (`pointer*` events for touch,
    50 ms tick animating `stroke-dashoffset` on a `<svg>
    <circle>` ring) for `critical` rows. "すべて解除" and
    per-category toggles confirm via `window.confirm` when
    clearing would touch critical rows; on accept, only
    non-critical rows are cleared.
  - `browser-extension/review-modal.js` — mirrored severity
    palette + long-press guard. Rows sort severity-first so
    critical detections float to the top.
  - `browser-extension/manifest.json` bumped to `0.3.0`.
  - Docs: `README.md` 重要度 + 一般名詞ブロックリスト sections,
    `browser-extension/README.md` 重要度カラー section,
    `browser-extension/CHANGELOG.md` v0.3.0 entry.
  - Tests: `tests/test_severity.py` (10 tests — static map spot
    checks per tier, unknown-label fallback, SEVERITY_ORDER
    coverage, max_severity helper, end-to-end DetectionResult
    / AggregatedEntity wiring, API_KEY preset → critical).
    `tests/test_masking_service.py` (4 new tests —
    `プロジェクト` / `メンバー` default-blocklist drops, custom
    `東京` override, empty-blocklist regression).

- [x] **feat/ollama-analyzer** — superseded by **Milestone 9
  (feat/local-llm-proxy-v0.5.0, merged `c2f4ac7`)**. The gateway-
  side Analyzer Protocol implementation is no longer required
  because the v0.5.0 design moved LLM execution entirely into the
  browser extension (no gateway round-trip, users keep all text
  inside their own machine / LAN).

- [x] **chore/chrome-web-store-prep** — shipped as **v0.4.0 /
  manifest v1.0.0**. Icons, screenshots, privacy policy, store
  descriptions in `browser-extension/{PRIVACY,STORE,STORE_DESCRIPTION}.md`
  and `docs/privacy-policy.md`.

---

## Milestone 9 — Local-LLM proxy (v0.5.0)

Goal: **add context-aware PII detection and AI replacement without
ever leaving the user's device**. The browser extension talks
directly to a user-configured Ollama / LM Studio / llama.cpp
endpoint via the service worker, so only regex / Sudachi were not
enough alone.

Shipped in a single squash merge (main `c2f4ac7`) bundling 57
commits. Full changelog in `browser-extension/CHANGELOG.md` under
`## 0.5.0`.

- [x] **Phase 1 — options UI + storage defaults** (`60e555c`).
  `localLlmEnabled / localLlmUrl / localLlmMode / localLlmModel /
  localLlmTimeoutMs / localLlmKind` keys; options page: URL input
  + 接続確認 button probing `/api/tags` + `/v1/models`, mode
  select, timeout input, experimental badge.

- [x] **Phase 2 — surrogates + prompts + SW proxy** (`086ebf6`,
  `1d2d948`). `browser-extension/engine/surrogates.js` (RFC 5737
  IPs, xorshift32, djb2-seeded deterministic fakes).
  `browser-extension/engine/llm-prompts.js` (detect + replace
  system prompts, few-shot examples). `background.js` `LLM_FETCH`
  handler with sender-id + host-lock validation.

- [x] **Phase 3 — merge authority + denylist** (`c0f945c`,
  `6333819`, `6f77d2b`). `mergeLlmDetect()` in injected.js: LLM
  labels override regex on same surface, regex kept as safety
  net for structured PII the LLM missed. `LLM_DENYLIST` +
  `LLM_DENY_REGEX` post-filter removes job titles / credential
  type names / polite phrases / common tech.

- [x] **Phase 4 — cold-start + retry resilience** (`542e252`,
  `6e9429f`, `6c4b49c`, `ddd84c2`). `think: false` +
  `format: "json"` + `num_predict: 2048` in every Ollama
  request. Retry budget: 6× warming-up on `500/503 "loading
  model"` + 2× on `AbortError`. Inner bridge timeout =
  `cfg.timeoutMs × 3 + 30s`. `_llmStatus` field distinguishes
  "failed" / "ok_empty" / "ok_entities".

- [x] **Phase 5 — UX consolidation** (commits from `7584634`
  onwards). In-sidebar centered overlay, row stagger-in,
  ✨ AI-detected icon, purple `AI 検出` badge, mode pill in
  header, chat-pane shrink with `contain: layout`, final row
  interaction matrix (long-press only on critical+masked,
  everything else one-tap), 4-column grid alignment,
  `出現回数 N回` label, lock icons restricted to category
  headers.

- [x] **Phase 6 — model management UI** (`b9b626e`, `80f4747`,
  `a897cb0`, `d9918ca`). Recommended-models panel with
  on-disk + VRAM chips and badges. Streaming `POST /api/pull`
  with live progress bar. `DELETE /api/delete` with
  confirm dialog.

- [x] **Phase 7 — `<tag_N>` placeholder output** (`b54d98a`,
  `ed3b9d3`). Replace mode now emits lowercase angle-bracket
  tags (`<name_1>`, `<company_2>`, `<hospital_1>`) instead of
  realistic fakes. `applyUniqueTagsToReplace` guarantees 1:1
  restorable mapping.

- [x] **Phase 8 — detection coverage** (`b076485`). Vendor-
  specific API-key regex for ~25 services (OpenAI, Anthropic,
  Notion, GitHub, Slack, AWS, Stripe, etc.), PEM private key
  blocks, JWT, Bearer headers. Mirrored across
  `browser-extension/engine/patterns.js` and
  `src/app/services/analyzers/presets.py`.

- [x] **v0.5.1 — Claude.ai interception fix** (`bf3c12f`,
  `6c7d286`, `a537ce9`). Field-reported "sidebar never opens on
  claude.ai" traced to relative-URL vs. host-anchored regex
  mismatch. Fetch + XHR hooks now resolve `fetch("/api/…")` to
  absolute via `new URL(raw, location.href)` before adapter
  matching. Adapter allow-list broadened with `send_message` /
  `messages` / `send`; deny-list extended with
  `ratings` / `stream_events` / `usage` / `analytics` /
  `telemetry` / `count` / `render_status`. `extractInputs` +
  `replaceInputs` gained top-level `text` / `query` / `message`
  string fields and `content: [{type,text}]` array handling used
  by projects conversations. Added provider-host POST/XHR
  diagnostic logs (deduped per URL) for future triage. Verified
  on user's URL
  `/api/organizations/<uuid>/chat_conversations/<uuid>/completion`.

### Milestone 9 follow-ups (open)

- [ ] **feat/response-restore** — when the AI service replies, walk
  the streaming response and substitute `<name_1>` → `田中` etc.
  back from the in-session tag map. Would close the loop so users
  see the AI's output against their original data. Blocked on
  streaming SSE interception, which is explicitly Phase-N scope.
- [ ] **feat/llm-model-warmup** — auto-fire a lightweight
  `/api/generate` on options-page "接続確認" success so the first
  real query doesn't hit cold-start. Optional UX polish.
- [ ] **feat/store-v1.1** — graduate v0.5.0 into a Web Store
  release once the replace mode is out of "実験的" status. Requires
  Chrome Web Store reviewer guidance on how to declare user-
  configured local-LLM fetches in the privacy form.

---

## Out of scope (explicitly)

- Training a custom NER model. We compose off-the-shelf analyzers and
  rule-based filters; model training belongs in a separate project.
- Centralized secret management for upstream LLM API keys. The gateway
  is a pure MITM; clients send their own auth headers.
- Multi-tenant / remote deployment. This is a local, loopback-bound
  tool. Non-loopback binds are unsupported and deliberately undocumented.
