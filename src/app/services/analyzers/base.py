"""Structural protocol shared by every PII / proper-noun analyzer.

``MaskingService`` does not know — and should not need to know — how any
individual analyzer implements its detections. It only cares that the
analyzer can turn a chunk of text plus a handful of configuration hints
into a list of ``presidio_analyzer.RecognizerResult`` objects. Keeping
that contract thin is what lets a new backend (GiNZA, Fugashi, a regex
recognizer, a scope-specific rule engine) drop into the pipeline as a
single new module next door instead of touching ``MaskingService``
internals.

Two pieces live here:

* :class:`AnalyzerRequest` — the per-call input. Every analyzer receives
  the same record. Fields an analyzer does not care about are simply
  ignored (Sudachi has no use for ``entity_types``, Presidio has no use
  for a hypothetical future ``split_mode``). Adding a new analyzer
  means, at most, adding one field here and a new module alongside.
* :class:`Analyzer` — a :class:`typing.Protocol` that any compliant
  backend satisfies structurally. We intentionally avoid an ABC so
  third-party classes (or duck-typed test doubles) do not need to
  inherit from our base class to participate.

The return type is deliberately Presidio's ``RecognizerResult`` so the
rest of the ``MaskingService`` pipeline (allow-list filtering, strategy
application, detection enrichment, audit writing) can keep working
unchanged. Non-Presidio analyzers wrap their own detection records in
``RecognizerResult`` at the module boundary — see
``analyzers/sudachi.py`` for the canonical example.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from presidio_analyzer import RecognizerResult


@dataclass(frozen=True)
class AnalyzerRequest:
    """Per-call analysis input passed to every :class:`Analyzer`.

    Carries everything the downstream pipeline (masking strategy,
    allow-list filter, detection enrichment) might need to decide what
    to produce. Individual analyzers ignore fields they do not care
    about — Sudachi has no use for ``entity_types``, Presidio ignores
    any future Sudachi-specific flag, etc. Adding a new analyzer means
    adding at most one field here plus a new module next door.

    The class is frozen so the same request can be fanned out to every
    active analyzer without any risk of one mutating shared state the
    next one observes.
    """

    text: str
    entity_types: list[str] = field(default_factory=list)
    language: str = "en"


class Analyzer(Protocol):
    """Structural type every analyzer satisfies.

    Implementations expose a stable ``name`` (used as the dict key in
    ``MaskingService._analyzers`` so a future allow-list filter can
    disable a specific analyzer by string) and an ``analyze`` method
    returning a list of ``RecognizerResult``. Protocol-based typing
    means a class does **not** need to inherit from :class:`Analyzer`
    to be accepted; it just needs the right shape.
    """

    name: str

    def analyze(self, request: AnalyzerRequest) -> list[RecognizerResult]:
        ...
