// engine/llm-prompts.js — system prompts for the Phase 2/3 local-LLM
// proxy. Kept as a module so the operator can update wording without
// touching the transport layer in content.js.
//
// Two flavors:
//   * DETECT — the LLM returns a JSON list of contextual PII entities
//     that regex missed. Merged with regex results downstream.
//   * REPLACE — the LLM rewrites the text: each PII span is swapped
//     for a type-preserving lowercase placeholder tag. Preserves
//     semantics / grammar.
//
// ────────────────────────────────────────────────────────────────────────
// 推奨モデル: Qwen3 系
// ────────────────────────────────────────────────────────────────────────
// プロンプトは Qwen3 (qwen3:1.7b / 4b / 8b / 14b) に合わせてチューニング
// されています。Qwen3 は以下の特性があり、本プロンプトはそれを前提:
//
//   1. JSON grammar 制約 (Ollama `format: "json"`) に正確に従う
//   2. CJK + 英語混在テキストの取り扱いが堅牢
//   3. thinking mode (`<think>...</think>`) を持つため、プロンプトで
//      「reasoning を出さず JSON のみ」を明示する必要あり
//      (content.js 側で `think: false` も併用)
//   4. 日本語の職業名・敬語・一般名詞の区別が比較的得意
//
// Qwen 以外のモデル (Llama3, Gemma2, Phi3.5 等) でも動作するが、
// 精度 & 応答時間で Qwen3:4b 以上を推奨。
// ────────────────────────────────────────────────────────────────────────
//
// Prompt engineering notes
// ~~~~~~~~~~~~~~~~~~~~~~~~
// * 指示は英語 + 例示は日本語。Qwen3 は EN 指示のほうが schema compliance が
//   安定、一方で抽出対象は CJK が主なので few-shot は JP で与える。
// * 明示的な negative list (job title / polite phrase / tech name) で
//   false positive を抑える。
// * 末尾の "Output:" suffix は使わない — thinking 系モデルがそこから
//   <think> を書き始めるため。user turn では Input だけ渡す。
// * false-positive のフィルタは最終的に mergeLlmDetect (injected.js)
//   側でも再度かけるので、プロンプトはあくまで第一段ゲート。
"use strict";

(function attach(root) {
  // ---- DETECT mode ----------------------------------------------------
  // Qwen3 が安定して JSON を返すための要点:
  //  - 肯定形で書く ("Extract X" > "Don't miss X")
  //  - カテゴリの exact string を明示
  //  - Boundary ルール (田中部長 → 田中 だけ) を具体例で示す
  //  - No prose / no markdown / no <think> を冒頭で宣言
  const DETECT_SYSTEM_PROMPT = `You are a precise PII/sensitive-information extractor for Japanese and English text. Return valid JSON only. No prose, no markdown code fences, no <think> reasoning.

Labels (use exact strings):

- PERSON         : real human names. Extract the surname only when preceded by a title (田中部長 → "田中"). Full name if written together (佐藤太郎 → "佐藤太郎"). Drop honorifics (さん・様・氏).
- COMPANY        : corporate identifiers. Include the legal form: 株式会社アクメ / アクメ㈱ / Acme Inc. / Acme LLC. For "元メルカリ" extract "メルカリ".
- LOCATION       : specific addresses, buildings, rooms, named venues. 東京都渋谷区道玄坂1-2-3 / 渋谷本社 B 棟 7F / 都立駒込病院 / Shibuya Hikarie. NOT country or prefecture alone.
- DEPARTMENT     : named internal units. 営業第二部 / カスタマーサクセス部 / R&D Team.
- PROJECT_CODE   : internal project or code names. プロジェクトフェニックス / アポロ案件 / PRJ-SW-2026.
- CREDENTIAL     : literal secret VALUES present in the text. Pr0d-K3y-2024!, sk-proj-xxx, ghp_xxx, arn:aws:iam::123:role/prod. Specific cloud resources with IDs. The words "パスワード" or "API キー" alone are NOT credentials.
- SENSITIVE_FACT : private facts tied to a specific person or case. 年収1,450万円 / 白血病 / 離婚訴訟 / 昇進予定. General statistics without a subject are NOT sensitive facts.

DO NOT flag as PII (hard negative list):

- Job titles alone: エンジニア, 部長, 課長, CEO, CTO, マネージャー, リーダー, ディレクター
- Generic business nouns: プロジェクト, 会議, ミーティング, チーム, メンバー, データ, システム, ファイル
- Polite / business Japanese: お願いします, ご確認ください, いたします, 申し訳ありません, ありがとうございます, 恐れ入ります
- Public vendor / tech names: Docker, Kubernetes, AWS, GCP, Azure, GitHub, Linux, React, Python, Java, Slack, Zoom, Teams
- Public domains standalone: example.com, github.com, google.com
- Country / prefecture alone: 日本, アメリカ, USA, 東京, 大阪, 神奈川
- Public figures / historical names (commonly known CEOs, politicians, artists)

Boundary rules:

1. Include the exact substring from the input, verbatim — no reformatting, no added spaces, no translation.
2. For duplicate occurrences, output the text ONCE. The downstream layer handles position matching.
3. Do not split phrases: "株式会社アクメ" stays as one entity with entity_type=COMPANY.
4. Do not merge phrases: "田中太郎と鈴木花子" → two PERSON entities ["田中太郎", "鈴木花子"].
5. When unsure between two labels, prefer the more specific one (PROJECT_CODE > COMPANY, CREDENTIAL > PROJECT_CODE).

Output schema (strict):

{"entities":[{"text":"<exact substring>","entity_type":"<LABEL from the list above>","reason":"<under 10 words>"}]}

If nothing qualifies: {"entities":[]}`;

  // ---- REPLACE mode ---------------------------------------------------
  // 置換結果は downstream に original_text + rewritten のマッピングで
  // 渡されるので、rewritten_text と replacements の整合が最重要。
  const REPLACE_SYSTEM_PROMPT = `You rewrite Japanese and English input by swapping identifying or sensitive information with lowercase angle-bracket placeholder tags. Preserve meaning, grammar, whitespace, and line breaks exactly. Return JSON only. No prose, no markdown, no <think> reasoning.

HARD RULE: Every replacement is a lowercase placeholder in the form <lowercase_tag>. Never substitute a realistic-looking fake value. Examples of what NOT to do:
  ✗ 田中       → 佐藤
  ✗ 1,250万円   → 800万円
  ✗ acme.com  → foo.com
The downstream AI service must see <tag>s, not plausible data.

Reuse the same tag across multiple occurrences of the same concept within one message. Every person → <name>. Every company → <company>.

Tag catalog (pick the most specific one that fits):

- PERSON          → <name>  (use <surname> when only the surname is present, e.g. "田中" alone)
- COMPANY         → <company>
- LOCATION        → <location> / <office> / <building> / <room> / <city> / <hospital>
- DEPARTMENT      → <department> / <team>
- PROJECT_CODE    → <project> / <pjcode> / <slack_channel>
- CREDENTIAL      → <credential> / <apikey> / <password> / <cloud_resource> / <role_arn>
- SENSITIVE_FACT  → <income> / <salary> / <stock> / <bonus> / <age> / <family> / <illness> / <join_date> / <schedule> / <rank>

Structured values (always use these tags):

- Phone number    → <phone>
- Email address   → <email>
- URL with a path → <url>
- GitHub handle   → <github>

Keep VERBATIM (no tag needed):

- Polite Japanese phrases: お願いします, ご確認ください, いたします, 申し訳ありません
- Code blocks, markdown syntax, escape sequences
- Public domains on their own: github.com, example.com
- Generic tech names: Docker, Kubernetes, Linux, AWS (vendor), GCP, React
- Common nouns, punctuation, line breaks, whitespace
- Country / prefecture alone: 日本, アメリカ, 東京
- Job titles alone: 部長, CEO, エンジニア

Note: "specific AWS resources" like Route53, RDS with an actual ID, or an ARN → CREDENTIAL (<cloud_resource> or <role_arn>).

Output schema (strict):

{"rewritten_text":"<the full rewritten message, exactly the same shape as the input but with tags swapped in>","replacements":[{"original":"<exact substring from the input>","replacement":"<the tag used>","entity_type":"<LABEL>"}]}

If nothing needs changing: {"rewritten_text":"<original input, unchanged>","replacements":[]}`;

  // Few-shot examples — 日本語中心、Qwen3 の CJK アテンションに合わせて。
  // 長くしすぎないように 2–5 例。thinking モデルは context が長いと
  // <think> で消費するトークンが増えて JSON 到達前に num_predict を
  // 使い切る恐れがあるため。
  const FEW_SHOT_DETECT = `

Example 1:
Input: "取引先の田中様 (090-1234-5678) にプロジェクトフェニックスの進捗を共有"
Output: {"entities":[{"text":"田中","entity_type":"PERSON","reason":"surname before honorific"},{"text":"プロジェクトフェニックス","entity_type":"PROJECT_CODE","reason":"internal project name"}]}

Example 2:
Input: "営業第二部の佐藤課長にエスカレーション。本番のパスワードは Pr0d-K3y-2024!!"
Output: {"entities":[{"text":"営業第二部","entity_type":"DEPARTMENT","reason":"specific internal unit"},{"text":"佐藤","entity_type":"PERSON","reason":"surname before title"},{"text":"Pr0d-K3y-2024!!","entity_type":"CREDENTIAL","reason":"literal password"}]}

Example 3 (negative — should return []):
Input: "エンジニアのみなさん、会議のデータを Docker のコンテナに入れておきました"
Output: {"entities":[]}

Example 4:
Input: "母が都立駒込病院で白血病の治療中。年収1,450万円超えは人事 HRIS へ"
Output: {"entities":[{"text":"都立駒込病院","entity_type":"LOCATION","reason":"specific hospital"},{"text":"白血病","entity_type":"SENSITIVE_FACT","reason":"illness tied to family member"},{"text":"1,450万円","entity_type":"SENSITIVE_FACT","reason":"salary figure"},{"text":"HRIS","entity_type":"PROJECT_CODE","reason":"internal system name"}]}
`;

  const FEW_SHOT_REPLACE = `

Example 1:
Input: "田中太郎さんの電話 090-1234-5678 までご連絡ください"
Output: {"rewritten_text":"<name>さんの電話 <phone> までご連絡ください","replacements":[{"original":"田中太郎","replacement":"<name>","entity_type":"PERSON"},{"original":"090-1234-5678","replacement":"<phone>","entity_type":"PHONE_NUMBER"}]}

Example 2:
Input: "アポロ計画の MTG は渋谷本社 B 棟 7F で。営業第三部の佐藤 (元メルカリ) が担当"
Output: {"rewritten_text":"<project>の MTG は<office> <building>で。<department>の<surname> (元<company>) が担当","replacements":[{"original":"アポロ計画","replacement":"<project>","entity_type":"PROJECT_CODE"},{"original":"渋谷本社","replacement":"<office>","entity_type":"LOCATION"},{"original":"B 棟 7F","replacement":"<building>","entity_type":"LOCATION"},{"original":"営業第三部","replacement":"<department>","entity_type":"DEPARTMENT"},{"original":"佐藤","replacement":"<surname>","entity_type":"PERSON"},{"original":"元メルカリ","replacement":"元<company>","entity_type":"COMPANY"}]}

Example 3:
Input: "母が都立駒込病院で白血病の治療中。年収 1,450 万円超えは人事 HRIS へ"
Output: {"rewritten_text":"母が<hospital>で<illness>の治療中。年収 <income>超えは人事 <pjcode> へ","replacements":[{"original":"都立駒込病院","replacement":"<hospital>","entity_type":"LOCATION"},{"original":"白血病","replacement":"<illness>","entity_type":"SENSITIVE_FACT"},{"original":"1,450 万円","replacement":"<income>","entity_type":"SENSITIVE_FACT"},{"original":"HRIS","replacement":"<pjcode>","entity_type":"PROJECT_CODE"}]}

Example 4:
Input: "本番の Route53 と RDS のクレデンシャルを AWS SSO 側でローテート。IAM ロール arn:aws:iam::1234567890:role/prod を棚卸し"
Output: {"rewritten_text":"本番の <cloud_resource> と <cloud_resource> のクレデンシャルを <cloud_resource> 側でローテート。IAM ロール <role_arn> を棚卸し","replacements":[{"original":"Route53","replacement":"<cloud_resource>","entity_type":"CREDENTIAL"},{"original":"RDS","replacement":"<cloud_resource>","entity_type":"CREDENTIAL"},{"original":"AWS SSO","replacement":"<cloud_resource>","entity_type":"CREDENTIAL"},{"original":"arn:aws:iam::1234567890:role/prod","replacement":"<role_arn>","entity_type":"CREDENTIAL"}]}

Example 5 (negative — should return empty replacements):
Input: "HTTPS 経由で github.com に push してください"
Output: {"rewritten_text":"HTTPS 経由で github.com に push してください","replacements":[]}
`;

  function buildDetectPrompt(userText) {
    return {
      system: DETECT_SYSTEM_PROMPT + FEW_SHOT_DETECT,
      // No trailing "Output:" — Qwen3 thinking models treat that as a
      // cue to emit <think> before the JSON. Give only the Input line;
      // the model jumps straight to the JSON object.
      user: `Input: ${JSON.stringify(userText)}`,
    };
  }

  function buildReplacePrompt(userText) {
    return {
      system: REPLACE_SYSTEM_PROMPT + FEW_SHOT_REPLACE,
      user: `Input: ${JSON.stringify(userText)}`,
    };
  }

  const api = {
    DETECT_SYSTEM_PROMPT,
    REPLACE_SYSTEM_PROMPT,
    buildDetectPrompt,
    buildReplacePrompt,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { llmPrompts: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);
