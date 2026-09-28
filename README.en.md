# PII Guard

[日本語](README.md) | **English**

PII Guard is a Chrome extension that finds personal data and business figures you would not want to share in a message to a generative AI chat, and replaces them with placeholders before the message is sent.

By default, everything is checked inside your browser. Nothing you type is sent to the developer or to any other third party.

The detection rules are tuned for Japanese text first. English names, email addresses, card numbers, API keys and similar formats are detected too.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/pii-guard/bkgalenjdoegfmomajjngbegpjmokejm)**

![When you send a message in ChatGPT, a review sidebar opens on the right. An email address, a phone number, a person's name and a company name are listed as items to mask](docs/store-screenshots/store-02-chatgpt-dark.png)

## Supported services

| Service | URLs where it runs |
|---|---|
| ChatGPT | `https://chatgpt.com/*`, `https://*.openai.com/*` |
| Claude | `https://claude.ai/*`, `https://*.claude.com/*` |
| Gemini | `https://gemini.google.com/*` |
| Manus | `https://*.manus.im/*` |

It does not run on any other site. It is tested on Google Chrome.

## How to use it

1. Install it from the Chrome Web Store. No setup is needed.
2. Type a message in a supported service and send it as usual.
3. A review sidebar opens on the right. Check the items to mask, then press "選択したものをマスクして送信" (mask the selected items and send).

To stop the message from being sent, press "キャンセル" (cancel). On the keyboard, Enter sends and Esc cancels.

The interface is in Japanese.

### What you can do in the sidebar

- Switch each item between masked and sent as is. Items sent as is get a green bar on the right edge.
- Filter items by severity with the Critical, High, Medium and Low tabs.
- Check the exact text that will be sent in the preview at the bottom.
- Press "✖ 除外" (exclude) on an item to stop masking that value from now on.
- Select text in the chat page and drag it onto the sidebar to always mask it. You pick a category, such as person or company, when you add it.

In sentences that contain words such as 機密 (confidential), 未公開 (unreleased) or "confidential", the items for people, companies and amounts are locked. Press and hold an item to unlock it. The slider at the top of the sidebar sets how long you need to hold.

## What it detects

| Kind | Examples |
|---|---|
| Contact details | Phone numbers, email addresses, postal addresses, postcodes |
| Names | Japanese family and given names with their kana readings, English names |
| Personal ID numbers | My Number, driver's licence numbers, passport numbers, social security numbers |
| Financial details | Credit card numbers, bank accounts, IBANs, crypto wallet addresses |
| Company and business details | Company names, corporate numbers, invoice registration numbers, employee, customer, contract, purchase order and invoice numbers |
| Credentials | API keys (more than 30 token formats), passwords, private keys, database connection strings, cookies |
| Internal network | IP addresses, MAC addresses, internal host names |
| Other | Dates of birth, ages, gender, names of schools and nurseries, device identifiers |

Numbers written in full-width digits and password settings written in capitals are detected as well.

### Business figures

Price change rates, quotes, budgets, discount rates and equity ratios are masked as well.

Percentages are judged by context. Only those near a business topic such as a price increase, gross margin or a fee are masked. Configuration values in code and published tax rates are left as they are.

### Sentences that are confidential by content

Some sentences are confidential because of what they say, not because of their format, such as "an unannounced price increase" or "acquisition talks in progress". When PII Guard finds one, it shows a warning in the sidebar.

- The sentence itself is not masked, because that would also remove what you want to ask.
- Company names, amounts and names in the same sentence are masked as usual.
- Rates, multipliers and amounts such as "500万" in such a sentence are masked whatever the topic.
- The warning shows why it was raised, such as the topic or a phrase that marks the information as unannounced.

Heavily reworded sentences can be missed. Judging by topic and phrasing works on Japanese sentences only. Sentences explicitly marked with words such as "confidential" or "internal use only" are flagged in English too.

## Settings

Click the PII Guard icon in the toolbar to open the popup. The popup has a link, "⚙ 詳細設定 / 除外リスト管理", to the settings page.

| Setting | Where | What it does |
|---|---|---|
| マスキングを有効化 (enable masking) | Popup | Pauses the extension |
| 送信前に確認 (review before sending) | Popup, settings page | When off, detected items are masked and sent without the sidebar |
| UI モード (UI mode) | Popup, settings page | Sidebar (recommended) or a dialog in the middle of the page |
| このタブのマスク件数 (masked in this tab) | Popup | How many items were masked in the current tab |
| マスキング除外リスト (exclusion list) | Settings page | Add or remove values that are never masked; export and import as JSON |
| ブラウザ内 ML 検出 (in-browser ML) | Settings page | See Optional features |
| ローカル LLM 連携 (local LLM) | Settings page | See Optional features |

## Optional features

Both are off by default. When you turn one on, the browser asks for permission to connect. If you do not allow it, no connection is made.

### Find names, places and organisations with an in-browser model

A small language model recognises names of people, places and organisations from context, including ones that the dictionaries and formats miss. The model runs inside your browser.

- When you turn it on, the model (about 135 MB) is downloaded once from Hugging Face.
- The model is stored in the browser and works offline after that.
- The download request only says which files to fetch. It contains nothing you typed.

### Connect a language model you run yourself

If you run an LLM on your own PC or on a server in your organisation, PII Guard can use it for context-aware detection. Anything with an OpenAI-compatible API works, such as Ollama, LM Studio or llama.cpp. Your text is sent only to the server you specify.

For example, to run Ollama with Docker:

```bash
docker run -d --name ollama -p 127.0.0.1:11434:11434 -v ollama:/root/.ollama \
  -e OLLAMA_ORIGINS=chrome-extension://bkgalenjdoegfmomajjngbegpjmokejm \
  ollama/ollama
docker exec ollama ollama pull qwen3:4b
```

`OLLAMA_ORIGINS` lets this extension call Ollama. It allows PII Guard and nothing else.

Then, in the "ローカル LLM 連携" section of the settings page:

1. Turn on "LLM 補助検出を有効化" (enable LLM-assisted detection).
2. Enter `http://localhost:11434` as the endpoint URL and press "接続確認" (test connection).
3. Choose a model. For Japanese text, `qwen3:4b` or larger is recommended.

There are two modes. "検出補助" (assist) adds the LLM's findings to the extension's own. "AI 置換 (実験的)" (AI replace, experimental) lets the LLM rewrite the whole message. If the LLM responds slowly, increase the timeout.

## Privacy

| Data | Where it goes |
|---|---|
| The text you type and the detection results | Processed only inside your browser. Sent to the server you specify only when the local LLM option is on |
| The text after masking | The AI service you are sending to, exactly as a normal message would |
| Settings, the exclusion list and values you always mask | Stored only in your browser, and removed with the extension |
| The model for in-browser ML | Downloaded from Hugging Face when you turn the option on |

There is no usage tracking and nothing is sent to the developer. See the [privacy policy](browser-extension/PRIVACY.md) for details.

## FAQ

**The sidebar does not open.**

Check that the page is one of the supported services. Right after installing or updating, reload the tabs that were already open. Also check that "マスキングを有効化" and "送信前に確認" are on in the popup.

**A value I do not want masked is selected every time.**

Press "✖ 除外" on that item in the sidebar, or add it to the exclusion list on the settings page. This suits company names, project names and your own name.

**A value I want masked is not found.**

Select it in the chat page and drag it onto the sidebar. It will be masked from then on. If many names are missed, try the in-browser ML option too.

**Does it mask personal data in the AI's replies?**

No. It only checks the messages you send.

**Does it find every piece of personal data?**

No. It can miss items and flag things that are not personal data. Always check the sidebar before sending.

## Known limitations

- Text inside images and attachments is not checked.
- The AI's replies are not checked.
- Japanese family names are found with a dictionary of the 50 most common ones. Other names are found when there is a cue, such as an honorific (様, さん) or a label like 氏名:, or when the in-browser ML option is on.
- Percentages are masked only near a business topic or inside a sentence that is confidential by content.

## Reporting problems and requests

Please use [Issues](https://github.com/sna4i/pii-guard/issues).

Issues are public. Do not paste a message that was not masked as it is. Replace names and numbers with made-up ones first.

## For developers

- [Developer guide](docs/development.en.md): the gateway, the MCP server, the detection engine, tests and builds
- [Extension development notes](browser-extension/README.md)
- [Changelog](browser-extension/CHANGELOG.md) (Japanese)
- [Pre-push check](docs/prepush-check.md) (Japanese): after cloning, run `git config core.hooksPath .githooks` first
