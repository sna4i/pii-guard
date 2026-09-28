# Privacy Policy — PII Guard (formerly Local Mask MCP)

**Last updated:** 2026-04-18 (updated for v0.5.0 local-LLM integration)

## Summary (English)

PII Guard is a browser extension that detects and masks personal
information (PII) in the text you send to AI chat services — Claude,
ChatGPT, Gemini, Manus — **before** that text leaves your browser.

By default we collect nothing and transmit nothing. Every byte of
processing happens on your own computer.

**Optional local-LLM augmentation (v0.5.0+)**: If *you* explicitly
enable it in the options page and enter a server URL, the extension
will POST text to **that user-configured server only** — typically an
Ollama / LM Studio / llama.cpp instance on your own machine or LAN.
This data still never reaches the extension author or any third
party, and the service worker enforces a host-lock so the URL
cannot be repurposed as a generic proxy.

---

## 要約 (日本語)

PII Guard は、Claude / ChatGPT / Gemini / Manus などの AI チャット
サービスに送信するテキストを、ブラウザから外部に出る**前**にブラウザ上で
検出・マスクする拡張機能です。

- **既定では送信データなし** — すべての処理はお客様のブラウザ内で完結。
- **v0.5.0+: ユーザーが自発的に有効化した場合のみ** — オプション画面で
  指定した**ローカル/LAN 上の LLM サーバー** (例: `http://localhost:11434`)
  にテキストを POST。拡張機能の開発者や第三者には届きません。
- **収集データなし** — 拡張機能は開発者が運営するサーバーに何も送りません。
- **保存データ: ローカルブラウザストレージのみ** — 設定だけを
  `chrome.storage.local` に保存。テキスト本文や検出結果は保存しません。

---

## 1. Data we collect

**None.**

Specifically:

- No text you type is sent to any server under our control.
- No browsing history, cookies, authentication tokens, or account
  information of any site you visit is read or transmitted.
- No analytics, telemetry, error reporting, or usage statistics are
  collected.

## 2. Data we store

Local Mask MCP persists a small number of user preferences to
`chrome.storage.local` so your choices survive browser restarts:

| Key | Purpose |
|---|---|
| `enabled` | Global on/off toggle for the extension |
| `interactive` | Whether the review UI appears before sending |
| `uiMode` | `"sidebar"` (default) or `"modal"` review experience |
| `maskAllowlist` | Strings the user has marked "never mask" |
| `mask_mcp_pref_hybrid` | `"auto"` (default) / `"standalone"` / `"gateway"` |
| `localLlmEnabled` *(v0.5.0+)* | `true` only if the user opted in to local-LLM augmentation. Default `false` |
| `localLlmUrl` *(v0.5.0+)* | The user-entered LLM server URL. Empty means no LLM traffic |
| `localLlmModel` *(v0.5.0+)* | Model name, e.g. `qwen3:4b` |
| `localLlmMode` *(v0.5.0+)* | `"detect"` (augment regex) or `"replace"` (tag-based rewrite) |
| `localLlmTimeoutMs` *(v0.5.0+)* | Timeout in ms (default 120000) |
| `localLlmKind` *(v0.5.0+)* | `"ollama"` or `"openai-compat"` API shape |

`chrome.storage.local` data stays in your browser profile; it is not
synced to Google or transmitted anywhere by the extension.

## 3. Data flow (what actually happens on the page)

When you type a message into a supported AI chat service and press Send:

1. The extension intercepts the outgoing network request in your browser.
2. The message text is scanned locally using the pure-JavaScript
   masking engine bundled with the extension (Phase 1) or optionally
   a locally-running gateway at `http://127.0.0.1:8081` that you
   start yourself (Hybrid mode).
3. Detected PII (emails, phone numbers, API keys, postal codes, etc.)
   is replaced with placeholders like `<EMAIL_ADDRESS_1>` before the
   request continues to the AI provider.
4. The AI provider receives the masked text. The extension itself
   never forwards anything to third parties on your behalf.

The **optional local gateway** is a separate Docker service you install
voluntarily on your own machine. It binds to the loopback address
`127.0.0.1:8081` only — it is not reachable from the internet. If you
choose not to run it, the extension uses its built-in JavaScript engine
instead.

## 4. Optional local-LLM augmentation (v0.5.0+)

From v0.5.0, the extension can talk to a **user-configured local
or LAN LLM server** (Ollama, LM Studio, llama.cpp, …) for
context-aware detection and tag-based replacement. This is the
**only** outbound traffic the extension ever initiates, and all of
the following conditions hold:

- **Opt-in.** `localLlmEnabled` is `false` by default. The feature
  is dormant until you enable the toggle on the options page.
- **User-specified destination.** The server URL comes from the
  `localLlmUrl` field you enter. No URL, no traffic.
- **Service-worker host-lock.** Every LLM fetch is routed through
  the extension's service worker (`background.js`), which compares
  the requested host + protocol against the stored `localLlmUrl`
  and rejects anything that doesn't match exactly. The SW cannot
  be repurposed as a generic HTTP proxy.
- **Sender-id validation.** The SW rejects any message whose
  `sender.id !== chrome.runtime.id`, so other Chrome extensions
  cannot smuggle their own URLs through PII Guard.
- **No extension-author involvement.** Your text goes to the
  server *you* pointed at. It does not pass through, copy to, or
  get logged by any infrastructure we operate.
- **Disable cleanly.** Flipping the options toggle off, clearing
  `localLlmUrl`, or uninstalling the extension all immediately
  stop any further LLM traffic.

What is sent: the text of the chat message you are about to send,
plus an internal system prompt instructing the LLM to return
`{entities: [...]}` (detect mode) or `{rewritten_text, replacements}`
(replace mode).

What is **not** sent: page URLs, cookies, tab information, your
account identifiers, or any content from other tabs.

## 5. Third-party sharing

None. We do not sell, share, license, rent, or otherwise disclose any
information to anyone.

## 6. Host permissions

The extension requests `host_permissions` only for the AI chat sites it
supports plus the user-configured local LLM endpoint:

- `https://claude.ai/*` / `https://*.claude.com/*`
- `https://chatgpt.com/*` / `https://*.openai.com/*`
- `https://gemini.google.com/*`
- `https://*.manus.im/*`
- `http://127.0.0.1:8081/*` (loopback only, for the optional local gateway)
- `http://*/*` *(v0.5.0-dev build only)* — needed because
  users can point `localLlmUrl` at any LAN address like
  `http://192.168.0.10:11434`. The service worker host-lock
  described in §4 restricts actual traffic to the user's saved URL
  at runtime.

The extension does not request `<all_urls>` or any broader access
than the above.

## 7. Your rights and choices

- **Disable any time.** Toggle the extension off from the popup, or
  uninstall it from `chrome://extensions`.
- **Data deletion.** Uninstalling the extension removes all its
  `chrome.storage.local` data automatically.
- **Inspect the code.** The extension is open source; you can audit
  exactly what it does at
  [`github.com/…/local-mask-mcp`](https://github.com/) (replace with
  your actual repo URL before publishing to the Chrome Web Store).
- **No account.** There is no registration, no login, no account to
  create or delete.

## 8. Children's privacy

The extension does not intentionally collect or process data from
users under 13. Because we collect no data at all, there is no child-
specific data flow to address.

## 9. Changes to this policy

If this policy changes, the updated version will be published in the
same repository. The "Last updated" date at the top reflects the most
recent revision. Because there is no data to collect, changes will
generally be clarifications rather than scope expansions.

## 10. Contact

Questions, concerns, or false-positive reports:

- GitHub Issues: https://github.com/ (update to your actual repo URL)
- Or the email address on your Chrome Web Store listing.

---

## Publishing this policy on GitHub Pages

The Chrome Web Store requires a public URL for the privacy policy.
The steps to host this file via GitHub Pages:

1. In your GitHub repo settings → **Pages**, set the source branch to
   `main` (or whatever you use for releases) and the folder to
   `/docs`.
2. Click **Save**. GitHub will build a Pages site at
   `https://<user>.github.io/<repo>/privacy-policy` (the `.md`
   extension is stripped by Jekyll).
3. Verify the URL returns HTTP 200 with the rendered policy before
   submitting to the Chrome Web Store.
4. Paste that URL into the **Privacy policy URL** field of the
   Developer Dashboard submission form.

Optional: add a `docs/_config.yml` with a theme (`theme: jekyll-theme-cayman`)
so the rendered page looks less like raw Markdown.
