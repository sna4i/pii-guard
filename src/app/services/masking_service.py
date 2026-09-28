from __future__ import annotations

import hashlib
import time
import uuid
from collections import Counter
from typing import Iterable

from presidio_analyzer import RecognizerResult
# Note: we used to rely on Presidio's AnonymizerEngine for the "tag"
# strategy, but its operator model is keyed by entity_type which cannot
# express per-detection numbering. All three strategies now do manual
# substitution in this module.

from app.models.schemas import (
    AuditRecord,
    DetectionResult,
    RuntimeConfig,
    SanitizeResponse,
    TextSanitizeRequest,
)
from app.services.analyzers import (
    Analyzer,
    AnalyzerRequest,
    PresidioAnalyzer,
    RegexAnalyzer,
    SudachiProperNounAnalyzer,
    get_preset_patterns,
)
from app.services.classification import classification_for
from app.services.language_detection import detect_language
from app.services.repositories import AuditRepository, ConfigRepository
from app.services.severity import severity_for


#: Number of characters of surrounding text kept in each DetectionResult's
#: ``context_before`` / ``context_after``. Large enough for a human to see
#: the detection in context, small enough not to bloat the API response.
_CONTEXT_WINDOW_CHARS = 20


class MaskingService:
    def __init__(self, config_repo: ConfigRepository, audit_repo: AuditRepository) -> None:
        self.config_repo = config_repo
        self.audit_repo = audit_repo
        # AnonymizerEngine was dropped with the per-detection-numbered tag
        # strategy; substitutions are now done inline by _tag_mask /
        # _partial_mask / _hash_mask.
        #: Lazily populated map of active analyzers keyed by ``Analyzer.name``.
        #: A dict (rather than a list) because a future ``allow_entity_types``
        #: extension may want to disable a specific analyzer by string, which
        #: is an O(1) lookup here and avoids a linear scan over instances.
        #: Analyzers are added on first use so operators who never opt in to
        #: ``morphological_analyzer="sudachi"`` never pay the Sudachi dict
        #: load cost at service boot.
        self._analyzers: dict[str, Analyzer] = {}
        #: Construction fingerprint per analyzer so the service can rebuild
        #: a cached instance when its ``RuntimeConfig`` inputs change between
        #: requests. Keyed by analyzer name, value is an opaque hashable that
        #: the matching branch of ``_get_analyzer`` knows how to compare
        #: against the current config (``None`` for analyzers that take no
        #: config at all, e.g. :class:`PresidioAnalyzer`).
        self._analyzer_fingerprints: dict[str, object] = {}

    def _get_analyzer(self, name: str, config: RuntimeConfig | None = None) -> Analyzer:
        """Return the cached analyzer for ``name``, constructing it on demand.

        The constructor map is intentionally kept inline — adding a new
        analyzer means adding one elif branch here plus a new module in
        ``app.services.analyzers``. When the list grows beyond three or
        four backends, consider promoting this to a registry decorator.

        For analyzers whose construction depends on ``RuntimeConfig``
        (currently only Sudachi), the service records a *fingerprint* of
        the kwargs it built the instance with and, if the current config
        disagrees, transparently rebuilds the analyzer. This keeps the
        dict keyed by the short ``name`` string (so callers can still
        write ``"sudachi" in self._analyzers`` the way the existing tests
        do) while still honouring live-config edits between requests.
        """
        fingerprint: object | None = None

        if name == "sudachi":
            # Sudachi's constructor kwargs are exposed in RuntimeConfig,
            # so the fingerprint needs to round-trip through a hashable
            # tuple for the equality check below. Nested lists become
            # tuples of tuples — cheap, deterministic.
            if config is None:
                raise ValueError(
                    "MaskingService._get_analyzer('sudachi') requires a RuntimeConfig"
                )
            # Backward-compatible fingerprint shape: when the new
            # ``prefer_surname_for_ambiguous`` flag is False (the
            # default), we emit the legacy two-tuple that the
            # existing ``test_masking_service_honors_sudachi_config``
            # assertion locks in. When the flag is True we append
            # a third element so a live flip between False/True
            # still rebuilds the cached analyzer — the tuple
            # mismatch drives the rebuild path a few lines below.
            base_fingerprint = (
                config.sudachi_split_mode,
                tuple(tuple(p) for p in config.proper_noun_pos_patterns),
            )
            if config.prefer_surname_for_ambiguous:
                fingerprint = (*base_fingerprint, True)
            else:
                fingerprint = base_fingerprint
        elif name == "regex":
            # Regex patterns are fully described by the (entity_type,
            # pattern) pairs in RuntimeConfig, plus any built-in preset
            # patterns. Round-trip through a tuple so the equality check
            # below can detect a live-edit to ``regex_patterns``,
            # ``enable_preset_patterns``, or
            # ``disabled_pattern_categories`` and rebuild the compiled
            # analyzer.
            if config is None:
                raise ValueError(
                    "MaskingService._get_analyzer('regex') requires a RuntimeConfig"
                )
            fingerprint = (
                config.enable_preset_patterns,
                tuple(sorted(config.disabled_pattern_categories)),
                tuple(tuple(p) for p in config.regex_patterns),
            )

        cached = self._analyzers.get(name)
        if cached is not None and self._analyzer_fingerprints.get(name) == fingerprint:
            return cached

        if name == "presidio":
            analyzer: Analyzer = PresidioAnalyzer()
        elif name == "sudachi":
            assert config is not None  # guarded above; helps the type checker
            analyzer = SudachiProperNounAnalyzer(
                split_mode=config.sudachi_split_mode,
                pos_patterns=[list(p) for p in config.proper_noun_pos_patterns],
                prefer_surname_for_ambiguous=config.prefer_surname_for_ambiguous,
            )
        elif name == "regex":
            assert config is not None  # guarded above; helps the type checker
            # Merge built-in preset patterns (if enabled) with user-
            # supplied regex_patterns. Presets come first so user
            # patterns can shadow / extend built-in entity types.
            merged: list[tuple[str, str]] = []
            if config.enable_preset_patterns:
                merged.extend(
                    get_preset_patterns(config.disabled_pattern_categories)
                )
            # Coerce each inner list to a 2-tuple for RegexAnalyzer's
            # signature. Patterns shorter than 2 elements are ignored
            # defensively — an operator who hand-edits runtime_config.json
            # should get a cleaner fall-through than a RegexAnalyzer
            # TypeError at construction time.
            merged.extend(
                (entry[0], entry[1])
                for entry in config.regex_patterns
                if len(entry) >= 2
            )
            analyzer = RegexAnalyzer(merged)
        else:
            raise ValueError(f"unknown analyzer: {name!r}")

        self._analyzers[name] = analyzer
        self._analyzer_fingerprints[name] = fingerprint
        return analyzer

    def sanitize_text(
        self,
        request: TextSanitizeRequest,
        *,
        request_type: str = "text",
        upstream_target: str | None = None,
    ) -> SanitizeResponse:
        """Run the full masking pipeline on a text payload.

        ``request_type`` and ``upstream_target`` are optional audit-log
        annotations: the default call — ``sanitize_text(request)`` — is
        byte-for-byte identical to the pre-extension implementation, so
        every existing caller (`/sanitize/text`, `/sanitize/file`,
        `/proxy/*`, the MCP adapter) keeps its ``request_type="text"``
        audit tag. The extension route passes ``request_type="extension"``
        and the originating page URL as ``upstream_target`` so operators
        can reconstruct "where did this PII originate" from the audit log
        without having to cross-reference the raw request.
        """
        started = time.perf_counter()
        config = self.config_repo.load()
        audit_id = str(uuid.uuid4())

        entity_types = request.entity_types or config.entity_types
        allow_types: set[str] = set(
            request.allow_entity_types
            if request.allow_entity_types is not None
            else config.allow_entity_types
        )
        mask_strategy = request.mask_strategy or config.mask_strategy

        if not config.filter_enabled:
            response = SanitizeResponse(
                audit_id=audit_id,
                filter_enabled=False,
                original_length=len(request.text),
                sanitized_text=request.text,
                detections=[],
                forwarded=False,
            )
            self._write_audit(
                audit_id, request_type, False, [], upstream_target, "success", started
            )
            return response

        # Presidio always runs (pre-refactor default). Sudachi is the
        # opt-in secondary pass that was previously hard-wired behind an
        # ``if config.morphological_analyzer == "sudachi"`` branch. We
        # keep the primary / secondary split explicit so the behaviour
        # is byte-for-byte identical to the pre-refactor code: the
        # overlap resolver is only invoked when Sudachi actually
        # contributed at least one span, preserving Presidio's native
        # ordering in the common English-only case.
        analyzer_request = AnalyzerRequest(
            text=request.text,
            entity_types=list(entity_types),
            language="en",
        )

        # Two dispatch modes, chosen by whether the operator opted in to
        # per-language routing via ``config.analyzers_by_language``:
        #
        # - legacy (``analyzers_by_language is None``): Presidio always,
        #   Sudachi conditionally. Byte-for-byte identical to every
        #   release before this commit.
        # - language-aware: run the CJK-ratio detector on the request
        #   text, look up the analyzer chain for the detected language
        #   (falling back through ``mixed`` → ``en`` so an operator only
        #   has to configure the two or three chains they actually need),
        #   and run exactly that subset of analyzers.
        #
        # Result merging / overlap resolution / allow filter / masking
        # strategy is shared between the two modes — only the analyzer
        # selection differs.
        if config.analyzers_by_language is None:
            recognizer_results: list[RecognizerResult] = self._get_analyzer(
                "presidio"
            ).analyze(analyzer_request)

            if config.morphological_analyzer == "sudachi":
                sudachi_results = self._get_analyzer("sudachi", config).analyze(
                    analyzer_request
                )
                if sudachi_results:
                    recognizer_results = _resolve_overlaps(
                        list(recognizer_results) + list(sudachi_results)
                    )

            # When preset patterns are enabled, always run the regex
            # analyzer in legacy mode — even though the operator never
            # opted into ``analyzers_by_language`` or
            # ``regex_patterns``. This ensures the built-in PII
            # checklist fires by default.
            if config.enable_preset_patterns or config.regex_patterns:
                regex_results = self._get_analyzer("regex", config).analyze(
                    analyzer_request
                )
                if regex_results:
                    recognizer_results = _resolve_overlaps(
                        list(recognizer_results) + list(regex_results)
                    )
        else:
            recognizer_results = self._run_language_aware_chain(
                analyzer_request, config
            )

        # Common-noun blocklist. Drop detections whose surface is an
        # exact match for a known generic term. Operators iterate this
        # list as they find new false positives; the shared default
        # covers the most common katakana loanwords Sudachi's
        # ``sudachidict_core`` mislabels as 固有名詞 (プロジェクト /
        # メンバー etc.). Applied BEFORE any other post-analyzer filter
        # so a blocked surface cannot survive via some downstream
        # re-classification path. Empty / ``None`` list = no-op.
        blocklist = set(config.common_noun_blocklist or [])
        if blocklist:
            recognizer_results = [
                r
                for r in recognizer_results
                if request.text[r.start:r.end] not in blocklist
            ]

        # Drop low-confidence detections before anything else touches the
        # merged list. Applied exactly once, on the already-merged result
        # set, so the filter sees the final union of every analyzer that
        # ran — no individual analyzer has to know about ``min_score``
        # itself. ``min_score == 0.0`` (the default) is a no-op and
        # preserves the pre-threshold behaviour byte-for-byte.
        if config.min_score > 0.0:
            recognizer_results = [
                r for r in recognizer_results if r.score >= config.min_score
            ]

        # Optional Sudachi-POS validation for proper-noun-class labels.
        # When a ``KATAKANA_NAME`` regex or Presidio ``PERSON`` hit
        # actually resolves to a Sudachi 名詞,一般 (brand / product /
        # generic term), we do NOT want the user to believe our
        # ``proper_noun`` class is clean. Validation removes those from
        # the ``proper_noun`` class entirely — the label is kept but
        # reclassified to ``"other"`` so the ``enabled_pii_classes``
        # filter below can drop them if the user configured things as
        # ``["proper_noun"]`` only.
        reclassified: dict[tuple[int, int, str], str] = {}
        if (
            config.sudachi_validate_proper_nouns
            and config.morphological_analyzer == "sudachi"
        ):
            reclassified = self._sudachi_validate_proper_nouns(
                request.text, recognizer_results, config
            )

        # Linguistic-tier filter. Drop detections whose classification
        # is NOT in ``enabled_pii_classes``. This is orthogonal to
        # ``allow_entity_types`` (per-label allow) and
        # ``disabled_pattern_categories`` (per-preset-category disable
        # for regex only). Everything cut here stays out of BOTH the
        # masked text and the detections list — the user explicitly
        # said "recognize these as separate from PII", so we do not
        # leak them into the audit trail under a disabled class.
        enabled = set(config.enabled_pii_classes)
        recognizer_results = [
            r
            for r in recognizer_results
            if _effective_classification(r, reclassified) in enabled
        ]

        maskable = [r for r in recognizer_results if r.entity_type not in allow_types]

        sanitized_text = self._apply_strategy(request.text, maskable, mask_strategy)
        detections = self._build_detection_results(request.text, recognizer_results, allow_types)

        self._write_audit(
            audit_id, request_type, True, detections, upstream_target, "success", started
        )
        return SanitizeResponse(
            audit_id=audit_id,
            filter_enabled=True,
            original_length=len(request.text),
            sanitized_text=sanitized_text,
            detections=detections,
        )

    def _run_language_aware_chain(
        self,
        analyzer_request: AnalyzerRequest,
        config: RuntimeConfig,
    ) -> list[RecognizerResult]:
        """Run the analyzer chain selected by the detected language.

        Called only when ``config.analyzers_by_language is not None``.
        Everything about result merging, overlap resolution, the
        allow-list filter, and the masking strategy is identical to
        the legacy path — the only thing that differs here is
        *which* analyzers run. That keeps the dispatcher trivially
        reviewable and means adding a new analyzer to the chain is a
        one-line config change rather than a code change.

        Fallback ladder: the detector returns ``"ja"`` / ``"en"`` /
        ``"mixed"``. If the operator did not provide an explicit chain
        for the detected label, we fall back to ``"mixed"`` (the most
        permissive) and then ``"en"`` (the pre-language-aware default
        chain). An empty chain after the fallback means "no analyzer
        runs", which is a legitimate pass-through mode — we honour it
        rather than silently re-enabling Presidio.
        """
        # Presidio expects ``language="en"`` today; teach analyzers that
        # actually care about locale about the detected label while
        # keeping the existing contract for the English-only backend.
        detected = detect_language(
            analyzer_request.text,
            ja_threshold=config.language_detection_ja_threshold,
        )
        chain_map = config.analyzers_by_language
        # ``chain_map`` can be ``None`` only in the legacy path, which
        # is branched above; the assert documents the invariant for
        # any future refactor that might call this helper directly.
        assert chain_map is not None
        if detected in chain_map:
            chain = chain_map[detected]
        else:
            chain = chain_map.get("mixed", chain_map.get("en", []))

        recognizer_results: list[RecognizerResult] = []
        contributed_names: set[str] = set()

        # When preset patterns are enabled, ensure "regex" is always
        # in the chain even if the operator did not list it explicitly.
        effective_chain = list(chain)
        if (
            config.enable_preset_patterns
            and "regex" not in effective_chain
        ):
            effective_chain.append("regex")

        for analyzer_name in effective_chain:
            # ``regex`` is the one analyzer whose chain membership is
            # conditional on the config actually containing any
            # patterns — an empty ``regex_patterns`` list with ``regex``
            # listed in the chain is treated as a no-op, not an error,
            # so operators can leave the chain config stable while they
            # enable / disable the pattern set independently.
            # When preset patterns are enabled the regex analyzer
            # always has patterns, so the skip only fires when both
            # presets and user patterns are empty.
            if (
                analyzer_name == "regex"
                and not config.regex_patterns
                and not config.enable_preset_patterns
            ):
                continue
            analyzer = self._get_analyzer(analyzer_name, config)
            results = analyzer.analyze(analyzer_request)
            if results:
                recognizer_results.extend(results)
                contributed_names.add(analyzer_name)

        # Only run the overlap resolver when at least two analyzers
        # contributed — a single analyzer cannot overlap with itself
        # in a way the resolver cares about, and skipping it preserves
        # result order for the common "just Presidio" or "just Sudachi"
        # case.
        if len(contributed_names) > 1:
            recognizer_results = _resolve_overlaps(recognizer_results)
        return recognizer_results

    def _apply_strategy(
        self,
        text: str,
        detections: list[RecognizerResult],
        mask_strategy: str,
    ) -> str:
        if mask_strategy == "tag":
            return self._tag_mask(text, detections)

        if mask_strategy == "partial":
            return self._partial_mask(text, detections)

        if mask_strategy == "hash":
            return self._hash_mask(text, detections)

        return text

    def _tag_mask(self, text: str, detections: list[RecognizerResult]) -> str:
        """Tag strategy with numbered placeholders.

        Each detection is replaced with ``<ENTITY_TYPE_N>`` where ``N`` is
        a 1-based counter scoped to the entity type. Numbering follows
        left-to-right order of first occurrence and is **stable for a
        given surface**: if the same substring is detected twice under
        the same entity type, both occurrences share the same number.

        Example::

            "田中太郎と田中太郎と山田花子が会議"
            → "<PROPER_NOUN_PERSON_1>と<PROPER_NOUN_PERSON_1>と<PROPER_NOUN_PERSON_2>が会議"

        The shared-number invariant lets downstream LLMs treat repeated
        mentions as the same referent, and is the building block for a
        future reverse-masking pass that will substitute placeholders
        back to their original values in the model's response.
        """
        # Pass 1: assign numbers. Sort by (start, end) so numbering is
        # deterministic regardless of detection insertion order.
        counters: dict[str, int] = {}
        assignments: dict[tuple[str, str], int] = {}
        for item in sorted(detections, key=lambda d: (d.start, d.end)):
            surface = text[item.start:item.end]
            key = (item.entity_type, surface)
            if key not in assignments:
                counters[item.entity_type] = counters.get(item.entity_type, 0) + 1
                assignments[key] = counters[item.entity_type]

        # Pass 2: apply substitutions in reverse offset order so earlier
        # offsets remain valid after later replacements. Dedupe by
        # (start, end) first — two analyzers (e.g. Presidio +
        # preset-regex) commonly flag the identical span, and substituting
        # the same range twice would graft the second placeholder into
        # the text of the first (producing ``<EMAIL_ADDRESS_1>1>`` or
        # similar garbage). The overlap resolver intentionally preserves
        # duplicates for audit purposes, so the dedup has to happen here.
        # Last-wins dedup: user-defined RegexAnalyzer patterns are
        # appended AFTER preset patterns in MaskingService, so a
        # custom ``EMPLOYEE_ID`` pattern must override the preset
        # ``INTERNAL_ID`` when both fire on the same span. Using
        # plain ``dict[...] = item`` (not ``setdefault``) keeps the
        # last entry for each (start, end) pair — which is the
        # caller's desired override.
        unique_spans: dict[tuple[int, int], RecognizerResult] = {}
        for item in detections:
            unique_spans[(item.start, item.end)] = item
        result = text
        for item in sorted(unique_spans.values(), key=lambda d: d.start, reverse=True):
            surface = text[item.start:item.end]
            number = assignments[(item.entity_type, surface)]
            placeholder = f"<{item.entity_type}_{number}>"
            result = result[:item.start] + placeholder + result[item.end:]
        return result

    def _partial_mask(self, text: str, detections: list[RecognizerResult]) -> str:
        chars = list(text)
        for item in detections:
            original = text[item.start:item.end]
            if len(original) <= 2:
                masked = "*" * len(original)
            else:
                masked = original[:1] + ("*" * (len(original) - 2)) + original[-1:]
            chars[item.start:item.end] = list(masked)
        return "".join(chars)

    def _hash_mask(self, text: str, detections: list[RecognizerResult]) -> str:
        result = text
        for item in sorted(detections, key=lambda x: x.start, reverse=True):
            original = text[item.start:item.end]
            digest = hashlib.sha256(original.encode("utf-8")).hexdigest()[:10]
            token = f"<{item.entity_type}:{digest}>"
            result = result[:item.start] + token + result[item.end:]
        return result

    def _build_detection_results(
        self,
        text: str,
        detections: Iterable[RecognizerResult],
        allow_types: set[str],
    ) -> list[DetectionResult]:
        results: list[DetectionResult] = []
        for item in detections:
            line, column = _locate_offset(text, item.start)
            before, after = _slice_context(text, item.start, item.end)
            results.append(
                DetectionResult(
                    entity_type=item.entity_type,
                    start=item.start,
                    end=item.end,
                    score=item.score,
                    text=text[item.start:item.end],
                    line=line,
                    column=column,
                    context_before=before,
                    context_after=after,
                    action="allowed" if item.entity_type in allow_types else "masked",
                    severity=severity_for(item.entity_type),
                )
            )
        return results

    def _sudachi_validate_proper_nouns(
        self,
        text: str,
        detections: list[RecognizerResult],
        config: RuntimeConfig,
    ) -> dict[tuple[int, int, str], str]:
        """Re-classify ``proper_noun`` detections using Sudachi POS.

        For every detection whose default classification is
        ``"proper_noun"``, tokenize the surface span with Sudachi and
        check whether the resulting morpheme sequence actually contains
        a ``名詞,固有名詞`` head. If it does not — meaning Sudachi sees
        the surface as a common / generic noun (``一般``, ``ブランド名``,
        etc.) — return a re-classification to ``"other"`` for that
        (start, end, label) triple. The original detection record is
        kept verbatim so the audit trail does not lose information;
        only the effective classification used by the
        ``enabled_pii_classes`` filter changes.
        """
        try:
            from sudachipy import Dictionary, SplitMode
        except Exception:
            # Sudachi isn't importable (shouldn't happen in the Docker
            # image, but keep the Python layer resilient). Skip
            # validation; everything stays at its default class.
            return {}

        mode_map = {"A": SplitMode.A, "B": SplitMode.B, "C": SplitMode.C}
        mode = mode_map.get(config.sudachi_split_mode, SplitMode.C)
        # Build once per request; MaskingService does not keep a
        # standalone tokenizer handle, and the Sudachi analyzer is
        # only guaranteed to exist when `_analyzers["sudachi"]` has
        # been constructed. Using a throwaway tokenizer keeps the
        # validation path self-contained.
        tokenizer = Dictionary().create()

        patterns = config.proper_noun_pos_patterns or [["名詞", "固有名詞"]]

        def _is_proper_noun(surface: str) -> bool:
            for morph in tokenizer.tokenize(surface, mode):
                pos = morph.part_of_speech()
                for prefix in patterns:
                    if all(
                        len(pos) > i and pos[i] == token
                        for i, token in enumerate(prefix)
                    ):
                        return True
            return False

        reclassified: dict[tuple[int, int, str], str] = {}
        for det in detections:
            if classification_for(det.entity_type) != "proper_noun":
                continue
            surface = text[det.start:det.end]
            if not _is_proper_noun(surface):
                reclassified[(det.start, det.end, det.entity_type)] = "other"
        return reclassified

    def _write_audit(
        self,
        audit_id: str,
        request_type: str,
        filter_enabled: bool,
        detections: list[DetectionResult],
        upstream_target: str | None,
        status: str,
        started: float,
    ) -> None:
        summary = Counter([item.entity_type for item in detections])
        record = AuditRecord(
            audit_id=audit_id,
            request_type=request_type,
            filter_enabled=filter_enabled,
            detected_count=len(detections),
            entity_summary=dict(summary),
            upstream_target=upstream_target,
            status=status,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            created_at=self.audit_repo.now(),
        )
        self.audit_repo.append(record)


def _resolve_overlaps(results: list[RecognizerResult]) -> list[RecognizerResult]:
    """Drop detections fully contained within a higher-scoring neighbour.

    Presidio + Sudachi can sometimes flag the same Japanese span twice —
    e.g. a ``LOCATION`` from Presidio's English NER and a
    ``PROPER_NOUN_LOCATION`` from Sudachi on the same character range.
    Keeping both would produce duplicate entries in ``detections`` and,
    worse, the ``partial`` and ``hash`` masking strategies would mutate
    the same offsets twice. This resolver keeps partial overlaps intact
    (they may legitimately describe different pieces of information) but
    discards any entry that is a strict subset of another with a higher
    score. Ties stay deterministic: the first entry wins.

    The implementation is a single linear sweep-line over results
    sorted by ``(start ascending, end descending)``. That sort order
    guarantees every candidate's potential dominator appears strictly
    before it in the walk:

    * If ``prior.start < candidate.start``, then length is strict by
      construction whenever ``prior.end >= candidate.end``.
    * If ``prior.start == candidate.start``, the ``-end`` secondary
      key puts the longer span first, so again any prior with
      ``prior.end > candidate.end`` has strictly greater length; a
      tied ``(start, end)`` pair is *not* considered dominance.

    The sweep maintains a single running "envelope" — the strongest
    dominator seen so far, identified by ``(end, score)``. Each
    candidate is checked against the envelope in O(1); if it survives,
    it optionally replaces the envelope when it extends further or
    matches the end with a strictly higher score. The final complexity
    is ``O(n log n)`` dominated by the sort plus an ``O(n)`` sweep —
    a clean improvement over the previous ``O(n²)`` nested scan on
    payloads with hundreds of detections.
    """
    if len(results) < 2:
        return list(results)

    # Sort once. ``(start, -end)`` = (start ASC, end DESC) because the
    # tuple comparison treats the second element as a number. That
    # order is what lets the sweep treat "processed earlier" as
    # "potentially dominates the current candidate".
    ordered = sorted(results, key=lambda r: (r.start, -r.end))

    keepers: list[RecognizerResult] = []
    # Envelope = the strongest dominator candidate walked so far. The
    # sentinel values here (``-1`` / ``-1.0``) are unreachable from a
    # real ``RecognizerResult`` — offsets are non-negative and scores
    # live in ``[0.0, 1.0]`` — so the first iteration always installs
    # a real envelope without a special-case branch.
    envelope_start = -1
    envelope_end = -1
    envelope_score = -1.0

    for candidate in ordered:
        # By the sort contract, ``envelope_start <= candidate.start``
        # holds whenever the envelope is set. Length-strict dominance
        # therefore reduces to "envelope started earlier OR ended
        # later" — exactly the ``(start, end) != candidate's span``
        # escape hatch that stops identical spans from eliminating
        # each other.
        if (
            envelope_end >= candidate.end
            and envelope_score >= candidate.score
            and (envelope_start < candidate.start or envelope_end > candidate.end)
        ):
            continue

        keepers.append(candidate)

        # Promote the envelope to the strictly-stronger of the two:
        # longer span wins, and on an end-tie the higher score wins.
        # That keeps the envelope maximally useful for subsequent
        # smaller candidates without ever demoting to a weaker one.
        if candidate.end > envelope_end or (
            candidate.end == envelope_end and candidate.score > envelope_score
        ):
            envelope_start = candidate.start
            envelope_end = candidate.end
            envelope_score = candidate.score

    return keepers


def _effective_classification(
    detection: RecognizerResult,
    reclassified: dict[tuple[int, int, str], str],
) -> str:
    """Return the class that the enabled-class filter should check.

    The default class comes from the static
    :func:`app.services.classification.classification_for` map.
    When Sudachi POS validation fires and demotes a specific
    ``(start, end, label)`` triple, the override in ``reclassified``
    wins. This separation keeps the default map pure (label → class
    is context-free) while letting per-detection evidence from Sudachi
    override for edge cases like brand-name katakana.
    """
    key = (detection.start, detection.end, detection.entity_type)
    if key in reclassified:
        return reclassified[key]
    return classification_for(detection.entity_type)


def _locate_offset(text: str, offset: int) -> tuple[int, int]:
    """Return (line, column), both 1-based, for a character offset.

    ``line`` counts ``\\n`` occurrences in ``text[:offset]``; ``column`` is
    the distance from the last preceding newline (or the start of the text).
    Kept deliberately simple — O(offset) per call is fine for PoC payloads.
    Switch to a ``bisect`` over precomputed line starts if you start seeing
    very long inputs with many detections.
    """
    prefix = text[:offset]
    line = prefix.count("\n") + 1
    last_nl = prefix.rfind("\n")
    column = (offset - last_nl) if last_nl >= 0 else (offset + 1)
    return line, column


def _slice_context(
    text: str,
    start: int,
    end: int,
    window: int = _CONTEXT_WINDOW_CHARS,
) -> tuple[str, str]:
    """Return up to ``window`` characters of text on either side of a match.

    The snippets are returned verbatim (newlines preserved). Consumers are
    free to render them however they like — a CLI may replace ``\\n`` with
    a visible marker, a JSON consumer will typically keep them as-is.
    """
    before = text[max(0, start - window):start]
    after = text[end:min(len(text), end + window)]
    return before, after
