# Privacy Policy — PII Guard (formerly Local Mask MCP)

**Last updated:** 2026-11-17 (Pro licensing via ExtensionPay, custom rules)

## Summary (English)

PII Guard is a browser extension that detects and masks personal
information (PII) in the text you send to AI chat services — Claude,
ChatGPT, Gemini, Manus — **before** that text leaves your browser.

By default we collect nothing and transmit nothing. Every byte of
processing happens on your own computer.

**Pro licensing (ExtensionPay)**: the paid tier is checked through
ExtensionPay. Nothing you type is involved — only the extension id and
an API key are sent, and only when you press the upgrade or login
button and when the purchase state is re-checked (see §10).

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
- **Pro 版の課金 (ExtensionPay)** — 課金の確認だけは拡張機能の外と通信します。
  送るのは拡張機能の ID と API キーだけで、入力した文章は通りません (§10)。
- **収集データなし** — 拡張機能は開発者が運営するサーバーに何も送りません。
- **保存データ: ローカルブラウザストレージのみ** — 設定と、v1.7.1 からの動作ログ
  (日時・出来事の種類・件数・ホスト名だけ。14 日で自動削除) を `chrome.storage.local` に保存。
  テキスト本文や検出した値は保存しません。

---

## 1. Data we collect

**None.**

Specifically:

- No text you type is sent to any server under our control.
- No browsing history, cookies, authentication tokens, or account
  information of any site you visit is read or transmitted.
- No analytics, telemetry, error reporting, or usage statistics are
  collected.
- Pro licensing sends no content: only the extension id and an API key
  go to ExtensionPay (§10). The purchaser email stays on ExtensionPay
  and in local storage.

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
| `diagLog:YYYY-MM-DD`, `diagLogDays` *(v1.7.1+)* | Activity log shown in the options page "ログ" tab: time, event type, counts, reason and host names only. Never the typed text, detected values, file names, request bodies, or URL paths and queries. Entries older than 14 days are deleted automatically |
| `licenseState` *(Pro)* | Last verified licence answer: paid flag, plan name, purchaser email, check time, trial end. Displayed in the popup and options page |
| `proCustomRules` *(Pro)* | Custom rules (`{ version, rules: [...] }`): regular expressions and word lists, evaluated locally and sent nowhere |

`chrome.storage.local` data stays in your browser profile; it is not
synced to Google or transmitted anywhere by the extension. From v1.7.1
the extension writes nothing to the browser console.

**Exception, Pro only:** ExtensionPay writes its own keys (API key,
purchaser record including email, install time) to `chrome.storage.sync`
so a purchase follows you across signed-in devices. Those keys are not
managed by the extension and are not among the settings above.

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

None, except for the Pro purchase: if you buy Pro, ExtensionPay (and
its payment processor, Stripe) handle the purchase record and the email
address you enter on the payment page. Card details are handled between
ExtensionPay and Stripe; the extension never receives them.

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
than the above. Pro licensing adds the `alarms` permission (one alarm,
run every 60 minutes to re-check the purchase state) and needs no host
permission for extensionpay.com: the payment and login pages open as a
separate window, and the licence queries go out from the service worker.

## 7. Your rights and choices

- **Disable any time.** Toggle the extension off from the popup, or
  uninstall it from `chrome://extensions`.
- **Data deletion.** Uninstalling the extension removes all its
  `chrome.storage.local` data automatically. ExtensionPay's own keys in
  `chrome.storage.sync` go with it; the purchase record stays on
  ExtensionPay and can be restored with the login button.
- **Inspect the code.** The extension is open source; you can audit
  exactly what it does at
  [`github.com/…/local-mask-mcp`](https://github.com/) (replace with
  your actual repo URL before publishing to the Chrome Web Store).
- **No account required.** The free tier has no registration, no
  login, no account. Pro uses an ExtensionPay purchase (identified by
  the email address you enter there); you can log in on another device
  to restore it, and deleting the extension's data only means pressing
  the login button again.

## 8. Children's privacy

The extension does not intentionally collect or process data from
users under 13. No content is collected at all; the only identifier
anywhere is the email address a Pro purchase leaves on ExtensionPay.

## 9. Changes to this policy

If this policy changes, the updated version will be published in the
same repository. The "Last updated" date at the top reflects the most
recent revision. Most changes are clarifications or additions (the Pro
licensing section was added this way); nothing already collected gets
used for a new purpose without a note here.

## 10. Pro licensing in detail (ExtensionPay)

This section is the prose counterpart of the summary above; it exists so
the store listing can link to one place.

**What triggers traffic.** Only two things:

1. Pressing *Upgrade to Pro* or *Already bought? Log in* in the popup or
   options page. The extension first calls `POST
   https://extensionpay.com/api/new-key` to obtain an API key, then opens
   the payment or login page in a separate window.
2. Re-checking the purchase state: `GET
   https://extensionpay.com/api/v2/user?api_key=…`, every 60 minutes,
   on install/update of the extension or of Chrome, on the background
   check done when the popup, the options page, a supported chat page or
   the protected composer is opened, and when *Refresh purchase state*
   is pressed.

**What is sent.** The extension id (in the path) and the API key. No
text you typed, no detected values, no page URLs. The email address
entered on the payment page is the purchase identifier ExtensionPay
keeps.

**What is stored where.** The extension keeps the last verified licence
answer (`licenseState`: paid flag, plan name, purchaser email, check
time, trial end) in `chrome.storage.local`. ExtensionPay itself writes
the API key, the purchaser record (including the email) and the install
time to `chrome.storage.sync`, which replicates through Chrome Sync to
other signed-in devices — so those devices re-check the purchase state
without you pressing anything. Uninstalling clears the extension's own
storage; the purchase record remains on ExtensionPay.

**Custom rules.** Pro rules (regular expressions and word lists) live
only in `chrome.storage.local` (`proCustomRules`) and are evaluated
locally. Nothing about them leaves the device, including to
ExtensionPay. They stay readable and exportable as JSON after Pro ends.

**No content script on extensionpay.com.** The window opens as a
separate page, so the install-time warning does not gain an
"extensionpay.com — read and change data" entry. The `alarms`
permission is the only manifest addition.

## 11. Contact

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
