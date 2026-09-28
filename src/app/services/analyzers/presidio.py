"""Presidio-backed analyzer — thin wrapper around ``AnalyzerEngine``.

This module owns exactly one responsibility: turn an
:class:`AnalyzerRequest` into a list of ``RecognizerResult`` using
Presidio's built-in English NER. It is a direct lift of the call
``MaskingService`` used to make inline; centralising it here means the
service no longer depends on ``presidio_analyzer.AnalyzerEngine``
directly, which in turn makes Presidio swappable for another NER
backend without touching ``MaskingService``.

Instantiation loads the spaCy model baked into the Docker image
(``en_core_web_lg``), so the first construction is the expensive part
of service startup. We delegate that cost to ``MaskingService`` which
constructs :class:`PresidioAnalyzer` lazily on the first real request.
"""

from __future__ import annotations

from presidio_analyzer import AnalyzerEngine, RecognizerResult

from app.services.analyzers.base import AnalyzerRequest


class PresidioAnalyzer:
    """:class:`Analyzer` implementation backed by Presidio's engine.

    The Presidio call is lifted verbatim from the pre-refactor
    ``MaskingService.sanitize_text`` — entity list from the request,
    language hard-coded to ``"en"`` at the call site (matching the
    pre-refactor behaviour). Language handling is deliberately left as
    a future extension: Milestone 3 in ``TODO.md`` covers language-aware
    dispatch, and until that lands every Presidio call stays English.
    """

    name = "presidio"

    def __init__(self) -> None:
        self._engine = AnalyzerEngine()

    def analyze(self, request: AnalyzerRequest) -> list[RecognizerResult]:
        return self._engine.analyze(
            text=request.text,
            entities=request.entity_types,
            language=request.language,
        )
