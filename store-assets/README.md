# Chrome Web Store asset checklist

Inventory of the graphic, copy, and legal assets the Chrome Web Store
submission form requires. Phase 1 commits this checklist and the
already-existing icons; the actual promotional graphics and listing
copy are produced in Phase 5 of the serverless-engine plan.

## Icons (already in repo)

| Size | Path | Required? |
|---|---|---|
| 16×16 | `../browser-extension/icons/icon16.png` | Yes |
| 48×48 | `../browser-extension/icons/icon48.png` | Yes |
| 128×128 | `../browser-extension/icons/icon128.png` | Yes |

These are shipped inside the extension package (`manifest.json` → `icons`)
and re-used for the Chrome Web Store listing thumbnail.

## Promotional tiles (to produce in Phase 5)

The Chrome Web Store has two optional promotional tiles; neither is
required for initial submission but the **small tile** dramatically
improves listing visibility.

| Asset | Dimensions | Required? | Notes |
|---|---|---|---|
| Small promotional tile | 440×280 PNG | Recommended | Used in the store's search grid |
| Marquee promotional tile | 1400×560 PNG | Only for Featured placement | Not needed for initial launch |

## Screenshots (to produce in Phase 5)

Minimum 1, recommended 3-5. Max 5.

| Count | Dimensions | Notes |
|---|---|---|
| 1 | 1280×800 PNG | "Before" — sensitive text in a chat input |
| 2 | 1280×800 PNG | "After" — sidebar showing detected PII with placeholders |
| 3 | 1280×800 PNG | Popup settings panel — interactive toggle + mode picker |

Optional:

| 4 | 1280×800 PNG | Critical-severity long-press confirmation |
| 5 | 1280×800 PNG | Hybrid mode — "Docker gateway optional" explainer |

## Listing copy (to produce in Phase 5)

Submit both Japanese and English versions via the localization tab.

### Short description (max 132 chars)

**English**

> Masks personal info in AI chat inputs before it leaves your browser.
> 100% local. No data collected. Claude / ChatGPT / Gemini / Manus.

(≤ 132 chars — verify with `wc -m`)

**日本語**

> 生成 AI への入力を送信前にブラウザ上でマスク。全処理ローカル完結。
> Claude / ChatGPT / Gemini / Manus 対応。データ収集ゼロ。

(≤ 132 文字で要確認)

### Detailed description (500-1000 chars per language)

Draft in Phase 5 after user-testing copy for the shortform. Structure:

1. 1-sentence tagline.
2. Problem statement (3-4 sentences).
3. What it does (bullets).
4. What it does NOT do (privacy commitments, 3-4 lines).
5. Supported sites (list).
6. Optional: screenshot captions when rendered inline.

## Privacy policy URL

Published at `../docs/privacy-policy.md`. Host via GitHub Pages;
instructions are at the bottom of that file. The rendered URL must be
pasted into the Developer Dashboard's **Privacy policy URL** field.

## Permissions justification

The store requires a justification string for `storage` and `activeTab`
(and the 4 host-permission domains). Drafts:

| Permission | Justification |
|---|---|
| `storage` | Save user preferences (on/off toggle, review-UI mode) locally. No data is synced or transmitted. |
| `activeTab` | Inject the masking engine only into the currently-active supported site. |
| `https://claude.ai/*` | Intercept prompts to Anthropic's Claude so PII is masked before it leaves the browser. |
| `https://*.claude.com/*` | Same, for Claude's alternate domain. |
| `https://chatgpt.com/*` | Intercept prompts to OpenAI's ChatGPT. |
| `https://*.openai.com/*` | Same, for OpenAI's API subdomains when reached from the web client. |
| `https://gemini.google.com/*` | Intercept prompts to Google Gemini. |
| `https://*.manus.im/*` | Intercept prompts to Manus.im. |
| `http://127.0.0.1:8081/*` | Loopback connection to the optional local Docker gateway. Not reachable from the internet. |

## Submission workflow (Phase 5 — reference only)

1. Produce all screenshots / tiles above.
2. Final-pass `manifest.json`: version bump, verify `host_permissions`,
   verify no `<all_urls>`.
3. Zip the `browser-extension/` directory, **excluding** `.DS_Store`,
   backup files, and any files not listed in `manifest.json`.
4. Upload the zip to the Chrome Web Store Developer Dashboard.
5. Fill in the metadata (short / detailed descriptions, categories,
   screenshots, support URL, privacy policy URL).
6. Select the distribution region (start with `Japan` + `United States`
   to gather early feedback, expand later).
7. Submit for review. Typical turnaround is 1-3 days for a first-time
   author, 1-24 hours for updates.

## Chrome Web Store one-time fees (as of 2026-04)

| Item | Cost |
|---|---|
| Developer Dashboard registration | USD 5.00 one-time |
| Subsequent updates | Free |
