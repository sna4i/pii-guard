"""Built-in pattern set for Japanese PII detection.

This module defines a comprehensive, categorized set of regex patterns
for detecting sensitive information in Japanese text (and some universal
patterns like IP addresses, URLs, API keys, etc.).  The patterns load
automatically into :class:`RegexAnalyzer` when
``RuntimeConfig.enable_preset_patterns`` is ``True`` (the default), so
operators get broad PII coverage out of the box without configuring
``regex_patterns`` by hand.

Each pattern is a ``(entity_type, regex_string)`` pair — the same shape
the :class:`RegexAnalyzer` constructor expects.  Categories can be
disabled individually via ``RuntimeConfig.disabled_pattern_categories``.

The preset set is **expected to grow**. Every bug report that surfaces
a new leak category (Milestone 8 Wave A added 15 business-document
categories in one round, and the user has explicitly asked for
``順次拡張`` — incremental expansion) results in another entry or two
in :data:`BUILTIN_PATTERNS`. Operators who want a tighter baseline can
disable categories via ``RuntimeConfig.disabled_pattern_categories``;
the default configuration deliberately errs on the side of flagging
more rather than less so the interactive review modal can let the
user untick false positives per request.

Design decisions
~~~~~~~~~~~~~~~~

* **No new dependencies.** Every pattern is a pure Python ``re`` regex.
* **No catastrophic backtracking.** Character-class ranges are bounded
  (e.g. ``{0,20}`` instead of ``*``), and alternations use fixed
  literals or short character classes — no nested quantifiers.
* **Preset patterns merge *before* user patterns.** If a user supplies
  ``regex_patterns`` in ``RuntimeConfig``, those are appended after the
  presets so they can shadow or extend built-in entity types.
* **Pragmatic scope.** A pattern that produces catastrophic false
  positives is narrowed or dropped; otherwise we keep it because the
  interactive review modal already exposes a per-detection "untick"
  control.  See the ``BLOOD_TYPE`` entry for an example of a pattern
  that is intentionally anchored to reduce noise.
"""

from __future__ import annotations

from app.services.analyzers.dictionaries import (
    JP_DESIGNATED_CITY_PATTERN,
    JP_PREFECTURE_PATTERN,
    JP_SURNAME_PATTERN,
    WESTERN_FIRST_NAME_PATTERN,
    WORLD_COUNTRY_EN_PATTERN,
    WORLD_COUNTRY_JP_PATTERN,
)


BUILTIN_PATTERNS: dict[str, list[tuple[str, str]]] = {
    # --- 都道府県 + 市区町村単体 (兵庫県明石市 / 東京都渋谷区 等) ---
    # 中間 char class は [市区町村郡] を除外することで "最初の suffix"
    # で止まる。除外がないと「明石市大久保町」のように町名まで
    # 貪欲に飲み込まれる。街区番地まで続くフル住所は ADDRESS が
    # longer span を取るため衝突しない。
    "PREFECTURE_CITY": [
        (
            "PREFECTURE_CITY",
            r"(?:北海道|(?:東京|京都|大阪)(?:都|府)|.{2,3}県)"
            r"(?:[^\s、。,市区町村郡]{1,6}[市区町村郡])",
        ),
    ],
    # --- 住所 (Japanese addresses — prefecture + city + street) ---
    "ADDRESS": [
        (
            "ADDRESS",
            r"(?:北海道|(?:東京|京都|大阪)(?:都|府)|.{2,3}県)"
            r"(?:[^\s、。,]{1,6}[市区町村郡])[^\s、。,]{0,20}",
        ),
    ],
    # --- 年齢 ---
    "AGE": [
        ("AGE", r"\d{1,3}\s*(?:歳|才)"),
    ],
    # --- 性別 ---
    "GENDER": [
        ("GENDER", r"(?:男性|女性|その他)"),
    ],
    # --- 金額 (Monetary amounts) ---
    "MONETARY_AMOUNT": [
        ("MONETARY_AMOUNT", r"[¥￥]\s*[\d,]+(?:\.\d+)?(?:\s*円)?"),
        ("MONETARY_AMOUNT", r"\d[\d,]*\s*(?:円|ドル|万円|億円)"),
        ("MONETARY_AMOUNT", r"\$\s*[\d,]+(?:\.\d+)?"),
    ],
    # --- 日付 (Dates — potential DOB) ---
    "DATE": [
        ("DATE", r"\d{4}[/\-年]\d{1,2}[/\-月]\d{1,2}日?"),
        (
            "DATE",
            r"(?:令和|平成|昭和|大正)\s*\d{1,2}\s*年"
            r"(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?",
        ),
    ],
    # --- 会社名 (Company names) ---
    # char class を [カタカナ + CJK 漢字 + 半角英数 + 社名記号] に限定し、
    # ひらがな助詞 (の / から / で …) で必ず break させる。
    # "株式会社アクメの田中部長から連絡" が "株式会社アクメ" で止まる。
    # Unicode ranges:
    #   \u30A0-\u30FF : カタカナ (含む 小書き・ー)
    #   \u4E00-\u9FFF : CJK 統合漢字
    #   \uFF66-\uFF9F : 半角カタカナ
    "COMPANY": [
        (
            "COMPANY",
            r"(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人"
            r"|NPO法人|学校法人|医療法人)\s*"
            r"[\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9FA-Za-z0-9\u30FB\uFF65\-＆&]{1,20}",
        ),
        (
            "COMPANY",
            r"[\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9FA-Za-z0-9\u30FB\uFF65\-＆&]{1,20}"
            r"(?:株式会社|有限会社|合同会社|㈱|㈲|Inc\.|Corp\.|Ltd\.|LLC|Co\.,?\s*Ltd\.)",
        ),
    ],
    # --- IP アドレス ---
    "IP_ADDRESS": [
        ("IP_ADDRESS", r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
    ],
    # --- URL ---
    "URL": [
        ("URL", r"https?://[^\s<>\"'、。）]+"),
    ],
    # --- マイナンバー (My Number) ---
    "MY_NUMBER": [
        ("MY_NUMBER", r"\b\d{4}\s*\d{4}\s*\d{4}\b"),
    ],
    # --- 口座番号 (Bank account) ---
    "BANK_ACCOUNT": [
        (
            "BANK_ACCOUNT",
            r"(?:普通|当座|貯蓄)\s*(?:口座)?\s*(?:番号)?\s*[:：]?\s*\d{6,8}",
        ),
    ],
    # --- 免許証番号 ---
    "DRIVERS_LICENSE": [
        ("DRIVERS_LICENSE", r"\b\d{2}\s*-?\s*\d{2}\s*-?\s*\d{6}\s*-?\s*\d{2}\b"),
    ],
    # --- パスポート番号 ---
    "PASSPORT": [
        ("PASSPORT", r"\b[A-Z]{2}\d{7}\b"),
    ],
    # --- データベース接続情報 ---
    "DB_CONNECTION": [
        (
            "DB_CONNECTION",
            r"(?:mysql|postgresql|postgres|mongodb|redis|sqlite)://[^\s]+",
        ),
        (
            "DB_CONNECTION",
            r"(?:database|db_name|dbname|DB_HOST|DB_NAME)\s*[=:]\s*[^\s,;]+",
        ),
    ],
    # --- API キー / シークレット ---
    # Keep the generic catch-alls at the top for back-compat, then layer
    # on ~25 vendor-specific well-known token prefixes. Mirror of
    # ``browser-extension/engine/patterns.js`` — MUST be kept in sync.
    "API_KEY": [
        # Generic catch-alls
        ("API_KEY", r"(?:sk|pk|api[_\-]?key|access[_\-]?key)[_\-][\w\-]{20,}"),
        (
            "SECRET",
            r"(?:password|secret|token|api_key|apikey|access_token)\s*[=:]\s*\S{8,}",
        ),
        # OpenAI — classic / project / service-account / legacy-null
        ("API_KEY", r"\bsk-(?:proj|svcacct|None)-[A-Za-z0-9_\-]{20,}"),
        ("API_KEY", r"\bsk-[A-Za-z0-9]{32,}\b"),
        # Anthropic
        ("API_KEY", r"\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_\-]{80,}"),
        # Notion — new ntn_ integration tokens + legacy secret_
        ("API_KEY", r"\bntn_[A-Za-z0-9]{40,}\b"),
        ("API_KEY", r"\bsecret_[A-Za-z0-9]{43}\b"),
        # GitHub — classic PAT family + fine-grained PAT
        ("API_KEY", r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b"),
        ("API_KEY", r"\bgithub_pat_[A-Za-z0-9_]{80,}\b"),
        # Slack — bot / user / app / admin / refresh
        ("API_KEY", r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
        # Google Cloud / Firebase
        ("API_KEY", r"\bAIza[A-Za-z0-9_\-]{35}\b"),
        ("API_KEY", r"\bya29\.[A-Za-z0-9_\-]{40,}"),
        # AWS — access key IDs
        ("API_KEY", r"\b(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|APKA|ABIA|ACCA)[A-Z0-9]{16}\b"),
        # Hugging Face
        ("API_KEY", r"\bhf_[A-Za-z0-9]{34,}\b"),
        # Stripe — secret / publishable / restricted + webhook secret
        ("API_KEY", r"\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b"),
        ("API_KEY", r"\bwhsec_[A-Za-z0-9]{32,}\b"),
        # Twilio — Account SID (AC) + API Key SID (SK)
        ("API_KEY", r"\b(?:AC|SK)[a-f0-9]{32}\b"),
        # SendGrid
        ("API_KEY", r"\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b"),
        # Groq
        ("API_KEY", r"\bgsk_[A-Za-z0-9]{40,}\b"),
        # Replicate
        ("API_KEY", r"\br8_[A-Za-z0-9]{37,}\b"),
        # Tavily
        ("API_KEY", r"\btvly-[A-Za-z0-9]{16,}\b"),
        # GitLab — personal access token / runner token
        ("API_KEY", r"\b(?:glpat|glrt)-[A-Za-z0-9_\-]{20,}"),
        # Mailgun
        ("API_KEY", r"\bkey-[a-f0-9]{32}\b"),
        # npm
        ("API_KEY", r"\bnpm_[A-Za-z0-9]{36}\b"),
        # Fireworks AI
        ("API_KEY", r"\bfw_[A-Za-z0-9]{24,}\b"),
        # Airtable — personal access tokens
        ("API_KEY", r"\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b"),
        # Linear
        ("API_KEY", r"\blin_(?:api|oauth)_[A-Za-z0-9]{32,}\b"),
        # Figma
        ("API_KEY", r"\bfigd_[A-Za-z0-9_\-]{40,}"),
        # Perplexity
        ("API_KEY", r"\bpplx-[A-Za-z0-9]{32,}\b"),
        # OpenRouter
        ("API_KEY", r"\bsk-or-v1-[A-Za-z0-9]{40,}\b"),
        # Discord bot token
        ("API_KEY", r"\b[MN][A-Za-z\d]{23}\.[\w\-]{6}\.[\w\-]{27,}\b"),
        # Cloudflare tokens
        ("API_KEY", r"\bcf-[A-Za-z0-9_\-]{40,}"),
        # JWT (three base64url segments)
        ("API_KEY", r"\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
        # Authorization: Bearer <token>
        ("API_KEY", r"\bBearer\s+[A-Za-z0-9\-_.~+/]{16,}=*"),
        # Generic Authorization / X-Api-Key header value
        ("API_KEY", r"(?i)(?:Authorization|X-Api-Key)\s*:\s*\S{16,}"),
        # PEM private keys (RSA / EC / OpenSSH / generic)
        (
            "SECRET",
            r"-----BEGIN(?:\s[A-Z]+)?\s(?:RSA|EC|OPENSSH|DSA|PGP)?\s?PRIVATE KEY-----[\s\S]*?-----END(?:\s[A-Z]+)?\s(?:RSA|EC|OPENSSH|DSA|PGP)?\s?PRIVATE KEY-----",
        ),
    ],
    # --- プロジェクト名 / 内部識別子 ---
    "INTERNAL_ID": [
        ("INTERNAL_ID", r"\b(?:PRJ|PJ|PROJ|PROJECT)[_\-][\w\-]{3,20}\b"),
        ("INTERNAL_ID", r"\b(?:EMP|STAFF)[_\-]\d{4,10}\b"),
        ("INTERNAL_ID", r"\b(?:TICKET|ISSUE|TASK)[_\-]\d{3,10}\b"),
    ],
    # --- 電話番号 (Japanese phone — supplement Presidio) ---
    "PHONE_NUMBER_JP": [
        ("PHONE_NUMBER", r"0\d{1,4}[-(]\d{1,4}[-)]\d{3,4}"),
        ("PHONE_NUMBER", r"\b0[789]0\d{8}\b"),
    ],
    # --- EMAIL_ADDRESS (permissive — catches uncommon TLDs) ---
    # Permissive RFC-5322-ish pattern: anything with an @, dot, and
    # letters for TLD. Intentionally broader than Presidio's built-in
    # EMAIL_ADDRESS recognizer so uncommon TLDs like ``.fizz`` / ``.xyz``
    # / ``.dev`` / ``.lgbt`` are caught. Presidio's recognizer relies on
    # a hardcoded TLD whitelist and misses newer gTLDs; this preset
    # deliberately falls back to the structural ``user@domain.tld``
    # shape so anything syntactically an email is flagged.
    "EMAIL_ADDRESS": [
        ("EMAIL_ADDRESS", r"\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,63}\b"),
    ],
    # --- KATAKANA_NAME (heuristic Japanese personal name) ---
    # Heuristic for Japanese personal names written in katakana
    # (タカハシユウヤ, ヤマダハナコ). ``sudachidict_core`` misses many
    # katakana name spellings, so this regex catches long katakana runs
    # as a safety net. KNOWN FALSE POSITIVES: brand names, product
    # names, and borrowed terms in katakana. The interactive review
    # modal (browser extension) lets the user untick them per request.
    # Default: ENABLED (aggressive). Disable via
    # ``disabled_pattern_categories: ["KATAKANA_NAME"]`` for legacy
    # deployments that prefer the pre-heuristic behaviour.
    "KATAKANA_NAME": [
        ("KATAKANA_NAME", r"[ァ-ヶー]{4,}"),
    ],
    # =====================================================================
    # Milestone 8 Wave A — business-document PII preset expansion.
    # Fifteen categories covering everyday work documents: employee IDs,
    # contract/invoice/PO numbers, 郵便番号, 血液型, 年収 etc. Patterns
    # are conservative and anchored where possible to keep false
    # positives low; operators with stricter needs can disable a
    # category via ``disabled_pattern_categories``.
    # =====================================================================
    # --- 郵便番号 ---
    # Japanese postal code.  ``〒`` prefix is optional so the pattern
    # catches both ``〒651-0087`` (formal) and ``651-0087`` (bare).
    # Known FP: any ``NNN-NNNN`` sequence (e.g. a part number).  We
    # accept this — the review modal lets the user untick if needed.
    "POSTAL_CODE": [
        ("POSTAL_CODE", r"〒?\d{3}-\d{4}"),
    ],
    # --- 部署コード / 部門コード ---
    "DEPARTMENT": [
        ("DEPARTMENT", r"\b(?:DEPT|DIV|DIVISION)[_\-]\d{2,6}\b"),
        ("DEPARTMENT", r"(?:部署コード|部門コード)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- 契約番号 ---
    "CONTRACT_NUMBER": [
        ("CONTRACT_NUMBER", r"\b(?:CONTRACT|CNTR|AGR)[_\-][\w\-]{3,20}\b"),
        ("CONTRACT_NUMBER", r"契約(?:番号|No\.?)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- 発注番号 / PO ---
    "PURCHASE_ORDER": [
        ("PURCHASE_ORDER", r"\b(?:PO|P\.O\.|ORDER)[_\-]\d{4,10}\b"),
        ("PURCHASE_ORDER", r"発注(?:番号|No\.?)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- 顧客ID ---
    "CUSTOMER_ID": [
        ("CUSTOMER_ID", r"\b(?:CUST|CUSTOMER|CLT)[_\-]\d{4,10}\b"),
        ("CUSTOMER_ID", r"顧客(?:番号|ID|コード)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- 請求書番号 ---
    "INVOICE_NUMBER": [
        ("INVOICE_NUMBER", r"\b(?:INV|INVOICE)[_\-]\d{4,10}\b"),
        ("INVOICE_NUMBER", r"請求(?:書)?(?:番号|No\.?)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- 従業員ID (既存 INTERNAL_ID を補強) ---
    "EMPLOYEE_ID": [
        (
            "EMPLOYEE_ID",
            r"(?:社員|従業員|スタッフ)(?:番号|ID|コード)\s*[:：=]\s*[\w\-]+",
        ),
        ("EMPLOYEE_ID", r"\b(?:STAFF|WORKER)[_\-]\d{3,10}\b"),
    ],
    # --- 会員ID ---
    "MEMBER_ID": [
        ("MEMBER_ID", r"会員(?:番号|ID|コード)\s*[:：=]\s*[\w\-]+"),
        ("MEMBER_ID", r"\bMEMBER[_\-]\d{4,10}\b"),
    ],
    # --- 患者ID / 医療記録番号 ---
    "PATIENT_ID": [
        ("PATIENT_ID", r"\b(?:PATIENT|MRN)[_\-]\d{4,10}\b"),
        ("PATIENT_ID", r"(?:患者|診療)(?:番号|ID)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- 製品コード / SKU ---
    "SKU": [
        ("SKU", r"\bSKU[_\-][\w\-]{3,20}\b"),
        ("SKU", r"(?:製品|商品)(?:コード|番号)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- 血液型 ---
    # ``AB`` comes first in the alternation so the regex engine prefers
    # the two-letter match over ``A`` / ``B`` alone. ``O型`` and ``O``
    # ambiguity is accepted — a false positive on ``OK型`` is not
    # currently mitigated.
    "BLOOD_TYPE": [
        ("BLOOD_TYPE", r"(?:AB|A|B|O)型"),
    ],
    # --- 年収 / 月収 ---
    # ``\s*`` is a bounded zero-or-more — the surrounding literal
    # keyword ``年収`` / ``月収`` bounds the total span length. The
    # trailing ``万?円?`` covers both ``年収1200万円`` and ``年収1200000``.
    "ANNUAL_INCOME": [
        ("ANNUAL_INCOME", r"年収\s*[\d,]+\s*万?円?"),
        ("ANNUAL_INCOME", r"月収\s*[\d,]+\s*万?円?"),
    ],
    # --- 特許番号 ---
    # Accepts both the Japanese-office prefixes (特許/特願/特公/特開) and
    # the ISO country-prefixed format (JP/US/EP/WO).
    "PATENT_NUMBER": [
        ("PATENT_NUMBER", r"(?:特許|特願|特公|特開)\s*\d{4}-?\d{6,}"),
        ("PATENT_NUMBER", r"\b(?:JP|US|EP|WO)\s*\d{7,}\b"),
    ],
    # --- 資産番号 ---
    "ASSET_NUMBER": [
        ("ASSET_NUMBER", r"\b(?:ASSET|FA)[_\-]\d{4,10}\b"),
        ("ASSET_NUMBER", r"資産(?:番号|コード)\s*[:：=]\s*[\w\-]+"),
    ],
    # --- ライセンス / 免許番号 (DRIVERS_LICENSE 以外) ---
    "LICENSE_NUMBER": [
        ("LICENSE_NUMBER", r"\b(?:LIC|LICENSE)[_\-][\w\-]{4,20}\b"),
    ],
    # --- 辞書ベース fallback カテゴリ ---
    # Sudachi / Presidio が無効な standalone 状態でも、主要な日本の
    # 苗字・都道府県・政令指定都市・主要国名・Western 名を確実に検出。
    # 辞書本体は app.services.analyzers.dictionaries に定義。
    "JP_SURNAME": [("JP_SURNAME", JP_SURNAME_PATTERN)],
    "JP_PREFECTURE_DICT": [("JP_PREFECTURE_DICT", JP_PREFECTURE_PATTERN)],
    "JP_DESIGNATED_CITY": [("JP_DESIGNATED_CITY", JP_DESIGNATED_CITY_PATTERN)],
    "WORLD_COUNTRY": [
        ("WORLD_COUNTRY", WORLD_COUNTRY_JP_PATTERN),
        ("WORLD_COUNTRY", WORLD_COUNTRY_EN_PATTERN),
    ],
    "WESTERN_FIRST_NAME": [("WESTERN_FIRST_NAME", WESTERN_FIRST_NAME_PATTERN)],
}


def get_preset_patterns(
    disabled_categories: list[str] | None = None,
) -> list[tuple[str, str]]:
    """Return a flat list of ``(entity_type, pattern)`` for all enabled categories.

    Parameters
    ----------
    disabled_categories:
        Category keys (must match keys of :data:`BUILTIN_PATTERNS`) to
        exclude.  ``None`` or empty list means "everything enabled".
    """
    disabled = set(disabled_categories or [])
    result: list[tuple[str, str]] = []
    for category, patterns in BUILTIN_PATTERNS.items():
        if category not in disabled:
            result.extend(patterns)
    return result


#: Human-readable checklist for documentation / introspection.
CATEGORY_DESCRIPTIONS: dict[str, str] = {
    "PREFECTURE_CITY": "都道府県+市区町村単体 (例: 兵庫県明石市, 東京都渋谷区)",
    "ADDRESS": "日本語住所 (都道府県+市区町村+番地)",
    "AGE": "年齢 (〇〇歳/才)",
    "GENDER": "性別 (男性/女性)",
    "MONETARY_AMOUNT": "金額 (円/ドル/$¥)",
    "DATE": "日付 (YYYY/MM/DD, 令和〇年〇月〇日)",
    "COMPANY": "会社名 (株式会社〇〇 等)",
    "IP_ADDRESS": "IPアドレス",
    "URL": "URL (http/https)",
    "MY_NUMBER": "マイナンバー (12桁)",
    "BANK_ACCOUNT": "口座番号",
    "DRIVERS_LICENSE": "免許証番号",
    "PASSPORT": "パスポート番号",
    "DB_CONNECTION": "データベース接続文字列 / DB名",
    "API_KEY": "APIキー / シークレット / トークン",
    "INTERNAL_ID": "プロジェクトID / 従業員ID / チケット番号",
    "PHONE_NUMBER_JP": "日本語電話番号 (090-, 03-, etc.)",
    "EMAIL_ADDRESS": "メールアドレス (Presidio 非依存 / 新規 gTLD 対応)",
    "KATAKANA_NAME": "カタカナ名 (4文字以上のカナ連続 — ブランド名等の誤検知あり)",
    # --- Milestone 8 Wave A: business-document categories ---
    "POSTAL_CODE": "郵便番号 (NNN-NNNN, 〒任意)",
    "DEPARTMENT": "部署コード / 部門コード",
    "CONTRACT_NUMBER": "契約番号",
    "PURCHASE_ORDER": "発注番号 / PO 番号",
    "CUSTOMER_ID": "顧客ID / 顧客コード",
    "INVOICE_NUMBER": "請求書番号",
    "EMPLOYEE_ID": "社員ID / 従業員ID",
    "MEMBER_ID": "会員ID",
    "PATIENT_ID": "患者ID / 医療記録番号 (MRN)",
    "SKU": "製品コード / SKU",
    "BLOOD_TYPE": "血液型 (A/B/O/AB型)",
    "ANNUAL_INCOME": "年収 / 月収 (万円 等)",
    "PATENT_NUMBER": "特許番号 (特許/特願/特公/特開, JP/US/EP/WO)",
    "ASSET_NUMBER": "資産番号 / 資産コード",
    "LICENSE_NUMBER": "ライセンス番号 (免許証以外)",
    # --- 辞書ベース fallback カテゴリ ---
    "JP_SURNAME": "日本人苗字 (curated top 50、多字のみ)",
    "JP_PREFECTURE_DICT": "日本の都道府県 (47 完全収録、単体検出用)",
    "JP_DESIGNATED_CITY": "政令指定都市 (20 完全収録、単体検出用)",
    "WORLD_COUNTRY": "主要国名 (JP + EN 表記、G20 + 主要アジア諸国)",
    "WESTERN_FIRST_NAME": "Western first names (business-common, curated)",
}
