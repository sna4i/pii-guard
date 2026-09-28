"""Regex-backed analyzer for org-local identifiers.

This is the third backend to satisfy the :class:`Analyzer` protocol
introduced in ``refactor/analyzer-protocol``. Where
:class:`PresidioAnalyzer` handles statistical NER and
:class:`SudachiProperNounAnalyzer` handles Japanese morphology,
:class:`RegexAnalyzer` covers the long tail of strings that are
perfectly well-defined but simply do not look like anything a
pretrained model was exposed to: employee IDs, ticket numbers,
internal project codes, free-text secret formats, etc.

Each pattern is a ``(entity_type, regex_string)`` pair. On a match
the analyzer emits a :class:`presidio_analyzer.RecognizerResult` with
a fixed ``score`` of ``1.0`` — per-pattern scoring policy is
intentionally out of scope for the first pass; an operator who needs
weighted regexes can layer that on later without changing the
protocol.

Zero-length matches are skipped to stop pathological patterns (e.g.
``^$`` or ``(?=foo)``) from silently producing empty detections that
would confuse the masking strategy downstream. All compilation
happens at ``__init__`` time so a repeated call does not re-parse the
same regex twice.
"""

from __future__ import annotations

import re

from presidio_analyzer import RecognizerResult

from app.services.analyzers.base import AnalyzerRequest


class RegexAnalyzer:
    """:class:`Analyzer` implementation backed by user-supplied regexes.

    The constructor takes a list of ``(entity_type, pattern)`` tuples
    and compiles each pattern eagerly. The fields a caller passes on
    :class:`AnalyzerRequest` other than ``text`` — ``entity_types``
    and ``language`` — are intentionally ignored: regex patterns are
    always active when the analyzer is enabled, and downstream
    filtering happens through ``allow_entity_types`` in
    ``MaskingService`` rather than at the analyzer boundary. This
    matches the shape of the Sudachi analyzer, which also ignores
    ``entity_types`` because its detection set is orthogonal to
    Presidio's categories.

    The short ``name`` attribute is used as the key in
    ``MaskingService._analyzers`` so future features can disable a
    specific analyzer by string. Keeping the name stable (``regex``)
    is a public API commitment of this class.
    """

    name = "regex"

    def __init__(self, patterns: list[tuple[str, str]]) -> None:
        """Compile ``patterns`` and stash them for :meth:`analyze`.

        Each entry in ``patterns`` is ``(entity_type, regex_string)``.
        The entity type becomes the ``entity_type`` field of every
        ``RecognizerResult`` the analyzer later emits for that pattern,
        so the tag can be referenced from ``allow_entity_types`` the
        same way ``EMAIL_ADDRESS`` or ``PROPER_NOUN_PERSON`` can.

        Compiling up-front means a bogus pattern raises
        ``re.error`` at construction time, before the first request
        ever reaches the hot path. ``MaskingService`` catches that at
        ``_get_analyzer`` time and propagates it as a config-validation
        error rather than a per-request 500.
        """
        self._compiled: list[tuple[str, re.Pattern[str]]] = [
            (entity_type, re.compile(pattern)) for entity_type, pattern in patterns
        ]

    def analyze(self, request: AnalyzerRequest) -> list[RecognizerResult]:
        """Run every compiled pattern against ``request.text``.

        Emits one ``RecognizerResult`` per non-empty match, with
        ``score`` fixed at ``1.0``. Zero-length matches are dropped
        defensively — a pattern like ``(?=foo)`` would otherwise
        produce empty spans that the masking strategy has no sensible
        way to handle.
        """
        results: list[RecognizerResult] = []
        text = request.text
        for entity_type, compiled in self._compiled:
            for match in compiled.finditer(text):
                start, end = match.start(), match.end()
                if end <= start:
                    continue
                results.append(
                    RecognizerResult(
                        entity_type=entity_type,
                        start=start,
                        end=end,
                        score=1.0,
                    )
                )
        return results
