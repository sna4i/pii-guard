from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


ProviderType = Literal["openai", "anthropic", "manus", "generic"]
RouteMode = Literal["native", "openai_compat"]
MaskStrategy = Literal["tag", "partial", "hash"]
#: Per-detection action. ``masked`` entities are replaced in the sanitized
#: text; ``allowed`` entities are detected and reported but left unchanged.
#: Add new values here (e.g. ``"rejected"``) when introducing new policies.
DetectionAction = Literal["masked", "allowed"]


class ProviderConfig(BaseModel):
    provider_id: str
    provider_type: ProviderType
    base_url: str
    enabled: bool = True
    route_mode: RouteMode = "native"
    #: Extra headers the gateway always attaches on behalf of the client
    #: (e.g. a ``User-Agent``). Client-supplied auth headers override these.
    default_headers: dict[str, str] = Field(default_factory=dict)
    model_mapping: dict[str, str] = Field(default_factory=dict)


class RuntimeConfig(BaseModel):
    filter_enabled: bool = True
    fail_closed: bool = True
    #: Entity types Presidio will look for.
    entity_types: list[str] = Field(
        default_factory=lambda: [
            "PERSON",
            "PHONE_NUMBER",
            "EMAIL_ADDRESS",
            "CREDIT_CARD",
            "LOCATION",
        ]
    )
    #: Subset of ``entity_types`` that is *detected but not masked*. Useful
    #: when you want the audit trail to show that a category of PII was
    #: present but intentionally allowed through (e.g. LOCATION in a
    #: geography-aware assistant). Empty list = mask everything detected.
    allow_entity_types: list[str] = Field(default_factory=list)
    mask_strategy: MaskStrategy = "tag"
    #: Opt-in Japanese morphological analyzer. When set to ``"sudachi"``
    #: the masking pipeline runs text through SudachiPy and folds its
    #: proper-noun detections (``PROPER_NOUN_PERSON`` / ``_LOCATION`` /
    #: ``_ORG`` / fallback ``PROPER_NOUN``) into the Presidio result set
    #: before masking. The default ``"none"`` keeps the pre-existing
    #: English-only behaviour untouched, so this field is backward-
    #: compatible with every existing ``runtime_config.json`` on disk.
    morphological_analyzer: Literal["none", "sudachi"] = "none"
    #: Sudachi split granularity. C keeps multi-morpheme proper nouns
    #: fused (東京タワー as one token); A splits into minimum units; B is
    #: in between. Only consulted when ``morphological_analyzer == "sudachi"``.
    sudachi_split_mode: Literal["A", "B", "C"] = "C"
    #: POS prefix patterns that count as "proper noun" for the Sudachi
    #: analyzer. Each inner list is a prefix of the POS 6-tuple returned
    #: by ``morpheme.part_of_speech()``. A morpheme matches if its POS
    #: starts with any of the patterns. Default covers all 固有名詞;
    #: add entries like ``["名詞", "一般", "人名"]`` for IPAdic
    #: dialects, or remove geographic entries by overriding the list.
    proper_noun_pos_patterns: list[list[str]] = Field(
        default_factory=lambda: [["名詞", "固有名詞"]]
    )
    #: Per-language analyzer preference. Maps a detected-language code
    #: (``"ja"`` / ``"en"`` / ``"mixed"``) to the ordered list of
    #: analyzer names that should run on text classified as that
    #: language. Valid analyzer names are ``"presidio"``, ``"sudachi"``,
    #: and ``"regex"``. An empty list disables every analyzer for that
    #: language (useful for pass-through modes). When this field is
    #: ``None`` the dispatcher is disabled entirely and the legacy code
    #: path (Presidio always, Sudachi conditional on
    #: ``morphological_analyzer``) runs unchanged — existing deployments
    #: see byte-for-byte identical output until they opt in.
    analyzers_by_language: dict[str, list[str]] | None = None
    #: Regex recognizer patterns loaded into ``RegexAnalyzer``. Each
    #: entry is ``[entity_type, regex_pattern]`` (a two-element list is
    #: the JSON-friendly shape for ``runtime_config.json``). The
    #: analyzer is instantiated lazily on the first request that needs
    #: it; when ``analyzers_by_language`` is set, the analyzer is only
    #: built if ``"regex"`` appears in the chain for the detected
    #: language. An empty list is a no-op even if the analyzer is
    #: listed in the chain.
    regex_patterns: list[list[str]] = Field(default_factory=list)
    #: Override the automatic language-detection threshold used by
    #: :func:`app.services.language_detection.detect_language`. Only
    #: consulted when ``analyzers_by_language`` is set; the legacy path
    #: does not call the detector. The default matches the detector's
    #: own default so changing it is an opt-in tuning knob rather than
    #: a breaking change.
    language_detection_ja_threshold: float = 0.2
    #: Linguistic-tier filter. Each entity label is classified (via
    #: :mod:`app.services.classification`) as one of ``"proper_noun"`` /
    #: ``"contact"`` / ``"identifier"`` / ``"credential"`` / ``"attribute"`` /
    #: ``"other"``. Only detections whose classification is in this list
    #: are masked; everything else is treated as if it had never been
    #: detected (does NOT appear in ``detections`` either). This lets an
    #: operator say "I only care about 固有名詞, not about employee IDs
    #: or structured codes" by setting this to ``["proper_noun"]``.
    #: Default enables every class so existing behaviour is unchanged.
    enabled_pii_classes: list[str] = Field(
        default_factory=lambda: [
            "proper_noun",
            "contact",
            "identifier",
            "credential",
            "attribute",
            "other",
        ]
    )
    #: When ``True`` and ``morphological_analyzer == "sudachi"``, each
    #: detection whose linguistic class is ``proper_noun`` is validated
    #: against Sudachi's POS output. If Sudachi tokenizes the surface as
    #: ``名詞,一般`` (common noun — brand, product, generic term) rather
    #: than ``名詞,固有名詞``, the detection is demoted to class
    #: ``"other"`` so the ``proper_noun`` class does not silently include
    #: false positives like brand-name katakana runs. Default ``False``
    #: keeps the existing behaviour (every ``PROPER_NOUN_*`` /
    #: ``KATAKANA_NAME`` detection is taken at face value).
    sudachi_validate_proper_nouns: bool = False
    #: Minimum confidence score (0.0–1.0). Detections whose ``score`` is
    #: strictly below this threshold are discarded before masking. 0.0
    #: disables the filter. Presidio scores vary per recognizer;
    #: Sudachi POS-based detections are always 1.0; RegexAnalyzer is
    #: always 1.0. Tune this to silence Presidio false positives without
    #: touching the analyzer configuration itself.
    min_score: float = 0.0
    #: Enable the built-in PII detection pattern set. When True (default),
    #: a comprehensive set of Japanese PII patterns (addresses, ages,
    #: company names, etc.) is loaded into the RegexAnalyzer automatically.
    #: Individual categories can be disabled via
    #: ``disabled_pattern_categories``.
    enable_preset_patterns: bool = True
    #: Categories to disable from the preset. Must be keys from
    #: ``BUILTIN_PATTERNS`` in ``presets.py`` (e.g. ``["URL", "DATE"]``).
    disabled_pattern_categories: list[str] = Field(default_factory=list)
    #: Pragmatic hack for the handful of surfaces (``千葉`` / ``神戸`` /
    #: ``岡山`` / ``福岡``) that Sudachi's default dictionary returns as
    #: ``PROPER_NOUN_LOCATION`` even though they are at least as common
    #: as Japanese surnames. When set to ``True`` the Sudachi analyzer
    #: relabels those specific surfaces to ``PROPER_NOUN_PERSON`` *after*
    #: the POS filter has already let them through. Default ``False``
    #: preserves the pre-existing behaviour byte-for-byte. This is NOT a
    #: machine-learned disambiguator — see the analyzer docstring for
    #: the explicit hardcoded set and its rationale.
    prefer_surname_for_ambiguous: bool = False
    #: Force-mask trigger keywords (Milestone 8 Wave A). When any of
    #: these keywords appears in the input AS A NOUN (per Sudachi POS
    #: on Japanese input, case-insensitive substring match for ASCII
    #: keywords), every :class:`AggregatedEntity` whose ``category`` is
    #: in :attr:`force_mask_categories` gets ``masked=True`` regardless
    #: of the user's allow-list or per-entity toggle. Empty list
    #: disables the feature.
    force_mask_keywords: list[str] = Field(
        default_factory=lambda: [
            "リーク",
            "未公開",
            "機密",
            "confidential",
            "leak",
        ]
    )
    #: Big categories to force-mask when a keyword fires. Names are the
    #: display-level categories from :mod:`app.services.category_map`
    #: (``PERSON`` / ``ORGANIZATION`` / ``FINANCIAL`` / ``CREDENTIAL``
    #: etc.). Non-existent category names are silently ignored so a
    #: typo here cannot break the sanitize path; the trigger just
    #: becomes a no-op.
    force_mask_categories: list[str] = Field(
        default_factory=lambda: ["PERSON", "ORGANIZATION", "FINANCIAL"]
    )
    #: Common-noun blocklist. Detections whose surface exactly matches
    #: any entry here are dropped entirely before masking. Default list
    #: covers generic Japanese business loanwords that Sudachi's
    #: ``sudachidict_core`` occasionally tags as 固有名詞 (ex:
    #: ``プロジェクト`` / ``メンバー``). Also protects the
    #: KATAKANA_NAME heuristic from firing on bare generic terms.
    #: Match is case-sensitive and exact; operators who want prefix
    #: matching can add each variant explicitly.
    common_noun_blocklist: list[str] = Field(
        default_factory=lambda: [
            "プロジェクト", "メンバー", "チーム", "マネージャー",
            "リーダー", "ユーザー", "クライアント", "サーバー",
            "システム", "データ", "ファイル", "フォルダ", "フォルダー",
            "レポート", "ミーティング", "タスク", "チケット",
            "スケジュール", "ドキュメント", "アカウント",
            "パスワード", "メッセージ", "スタッフ", "カスタマー",
            "オフィス", "ミーティングルーム",
        ]
    )
    #: Severity threshold below which the review UI defaults rows to
    #: unchecked (auto-allowed through). Typically ``"low"`` leaves all
    #: rows checked by default; setting to ``"medium"`` auto-un-checks
    #: low-severity rows so ``AGE`` / ``GENDER`` / ``BLOOD_TYPE`` start
    #: as pass-through unless the user explicitly re-checks them.
    #: Default ``"low"`` preserves "mask everything by default".
    default_uncheck_below: Literal["critical", "high", "medium", "low"] = "low"
    default_provider_id: str = "openai"
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)


class ToggleRequest(BaseModel):
    enabled: bool


class ProviderSelectionRequest(BaseModel):
    provider_id: str


class TextSanitizeRequest(BaseModel):
    text: str
    #: Per-request override of the detector set. Falls back to
    #: ``RuntimeConfig.entity_types`` when omitted.
    entity_types: list[str] | None = None
    #: Per-request override of the pass-through allow-list. Falls back to
    #: ``RuntimeConfig.allow_entity_types`` when omitted. Entries here are
    #: still reported in the ``detections`` list with ``action="allowed"``.
    allow_entity_types: list[str] | None = None
    mask_strategy: MaskStrategy | None = None
    forward_upstream: bool = False
    provider_id: str | None = None
    operation: str | None = None
    upstream_payload: dict[str, Any] | None = None


class DetectionResult(BaseModel):
    entity_type: str
    #: 0-based character offset in the original text.
    start: int
    end: int
    score: float
    #: The matched substring as it appeared in the original text.
    text: str
    #: 1-based line number of ``start`` within the original text.
    line: int
    #: 1-based column of ``start`` on that line.
    column: int
    #: Up to ~20 characters of the original text preceding the match,
    #: suitable for building a human-readable "context" column.
    context_before: str
    #: Up to ~20 characters of the original text following the match.
    context_after: str
    #: What the masking service actually did with this detection.
    action: DetectionAction
    #: Risk tier resolved via :func:`app.services.severity.severity_for`.
    #: Used by the UI for color coding and to gate ``critical`` rows
    #: behind a long-press. Defaults to ``"low"`` when absent so older
    #: audit-log entries and third-party consumers keep working.
    severity: str = "low"


class ProviderSelectionResult(BaseModel):
    provider_id: str
    provider_type: ProviderType
    base_url: str
    enabled: bool
    route_mode: RouteMode


class SanitizeResponse(BaseModel):
    audit_id: str
    filter_enabled: bool
    original_length: int
    sanitized_text: str
    detections: list[DetectionResult]
    forwarded: bool = False
    selected_provider: ProviderSelectionResult | None = None
    upstream_response: dict[str, Any] | None = None


class AuditRecord(BaseModel):
    audit_id: str
    #: Origin of the request. ``"extension"`` is written by the
    #: browser-extension-facing `/v1/extension/sanitize` route and makes
    #: it possible to tell "this detection came from a Chrome extension
    #: monkey-patching fetch on claude.ai" apart from the other entry
    #: points during audit review.
    request_type: Literal["text", "pdf", "image", "proxy", "extension"]
    filter_enabled: bool
    detected_count: int
    entity_summary: dict[str, int]
    upstream_target: str | None = None
    status: Literal["success", "blocked", "error"]
    elapsed_ms: int
    created_at: datetime


class ExtensionSanitizeRequest(BaseModel):
    """Browser-extension-facing sanitize request.

    This is deliberately a narrower contract than
    :class:`TextSanitizeRequest`: the extension only ever wants a
    single masked string back, so the proxy-forwarding fields
    (``forward_upstream`` / ``provider_id`` / ``upstream_payload``)
    are intentionally omitted. The two optional hints — ``service``
    and ``source_url`` — exist so the gateway's audit log can record
    which AI service the text was bound for without the extension
    having to implement the heavier legacy request schema.
    """

    text: str
    #: Service identifier the content script matched against
    #: (``"claude"`` / ``"chatgpt"`` / ``"gemini"`` / ``"manus"`` / …).
    #: Free-form on purpose — the gateway does not dispatch on this,
    #: it only echoes it into the audit log.
    service: str | None = None
    #: Page URL the extension captured the fetch/XHR from. Saved
    #: verbatim in the audit record for forensic purposes.
    source_url: str | None = None


class ExtensionSanitizeResponse(BaseModel):
    """Response shape returned to the browser extension.

    Mirrors the core fields of :class:`SanitizeResponse` but drops
    the proxy-forwarding metadata (the extension never forwards to
    an upstream — it substitutes the masked text back into the page
    fetch itself). ``action`` collapses the per-detection state into
    a single top-level summary so the content script can decide at a
    glance whether to swap the body, leave it alone, or fall through
    to the user-prompt confirmation dialog.
    """

    sanitized_text: str
    detections: list[DetectionResult]
    #: Coarse disposition of the call:
    #: * ``"masked"`` — at least one detection resulted in a mask
    #:   being applied and ``sanitized_text`` differs from the input.
    #: * ``"no_change"`` — detections (if any) were all allow-listed
    #:   or the filter was disabled; forward the original text.
    #: * ``"failed"`` — the gateway hit an internal error. Current
    #:   code path always raises before returning this value; kept
    #:   here so the extension's type guards stay exhaustive even if
    #:   a future fallback mode starts emitting it.
    action: Literal["masked", "no_change", "failed"]
    audit_id: str


class AggregatedEntity(BaseModel):
    """One entry per unique masked surface.

    The UI-facing aggregated endpoint collapses multiple occurrences of
    the same surface text into a single entry so the sidebar can show
    ``田中太郎 (2件)`` as one row instead of listing each occurrence.

    ``label`` is the analyzer-level entity type (e.g.
    ``"PROPER_NOUN_PERSON"``); ``category`` is the big bucket the UI
    groups by (``"PERSON"``). ``positions`` enumerates all the
    ``(start, end)`` character spans the surface occupied in the
    original text — the frontend uses these to build the final
    replacement. ``masked`` defaults to ``True`` and flips to ``False``
    when the UI lets the user opt a surface out of masking; it is also
    forced back to ``True`` by the ``force_mask_keywords`` trigger.
    """

    #: Surface text of the detection, verbatim from the original input.
    value: str
    #: Analyzer-level entity label (``PROPER_NOUN_PERSON`` / ``EMAIL_ADDRESS``
    #: / ``MONETARY_AMOUNT`` …). When a surface was flagged by multiple
    #: analyzers under different labels the lowest-``start`` label wins
    #: (first occurrence precedence — see :func:`aggregate_detections`).
    label: str
    #: Display-level big category resolved via :mod:`app.services.category_map`.
    category: str
    #: Total number of occurrences of ``value`` that the analyzers
    #: flagged in the original text. Equal to ``len(positions)``.
    count: int
    #: List of ``(start, end)`` character offsets for every occurrence.
    positions: list[tuple[int, int]]
    #: Whether the gateway plans to mask this entity when substituting
    #: text back into the outbound request. The UI toggles it off when
    #: the user wants to let a surface through, and the
    #: ``force_mask_keywords`` trigger forces it back on.
    masked: bool = True
    #: Numbered placeholder the gateway uses in ``sanitized_text`` for
    #: this surface. Two detections with the same (label, value) share
    #: the same placeholder so repeated mentions collapse into one
    #: referent (``<PROPER_NOUN_PERSON_1>`` used twice means "same
    #: person mentioned twice"). The sidebar renders this string next
    #: to the row so the user knows exactly what token the AI will see.
    placeholder: str = ""
    #: Linguistic tier (proper_noun / contact / identifier / credential /
    #: attribute / other) resolved from ``label`` via
    #: :func:`app.services.classification.classification_for`. Used by
    #: the UI to group rows alongside the coarser ``category`` grouping,
    #: and by ``RuntimeConfig.enabled_pii_classes`` as the filter key.
    classification: str = "other"
    #: Risk tier resolved via :func:`app.services.severity.severity_for`.
    #: Drives the left colour border + badge in the sidebar and gates
    #: ``critical`` rows behind the 800 ms long-press guard. Defaults
    #: to ``"low"`` so older AggregatedEntity payloads keep deserialising.
    severity: str = "low"


class AggregatedExtensionResponse(BaseModel):
    """Response shape returned by the aggregated extension endpoint.

    Sits alongside :class:`ExtensionSanitizeResponse` (the original
    per-detection shape is preserved for backward compatibility) and
    is returned by ``POST /v1/extension/sanitize/aggregated``. The
    frontend uses ``aggregated`` to render the per-surface control
    list; ``force_masked_categories`` tells the sidebar which big
    categories were locked to masked=True by a keyword trigger so it
    can show a "locked" icon next to them.
    """

    #: Echo of the input text so the sidebar can render it alongside
    #: the controls without having to keep its own local copy.
    original_text: str
    #: Per-unique-surface aggregation list.
    aggregated: list[AggregatedEntity]
    #: Audit record UUID written by ``MaskingService``; kept stable
    #: across all three extension endpoints so operators can correlate.
    audit_id: str
    #: Big-category names forced to ``masked=True`` by the
    #: ``force_mask_keywords`` trigger. Empty list when no keyword
    #: fired.
    force_masked_categories: list[str]
