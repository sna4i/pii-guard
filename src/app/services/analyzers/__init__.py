"""Analyzer package — every PII / proper-noun backend lives here.

``MaskingService`` depends only on :class:`Analyzer` and
:class:`AnalyzerRequest` from :mod:`app.services.analyzers.base`, plus
whichever concrete classes it needs to construct on demand. Adding a
new backend (GiNZA, Fugashi, a custom regex recognizer, etc.) means
dropping a new module alongside the existing ones and wiring its
constructor into :class:`MaskingService._get_analyzer`.

Re-exports below exist purely as an import-site convenience so callers
can write ``from app.services.analyzers import PresidioAnalyzer``
without chasing module paths.
"""

from app.services.analyzers.base import Analyzer, AnalyzerRequest
from app.services.analyzers.presidio import PresidioAnalyzer
from app.services.analyzers.presets import (
    BUILTIN_PATTERNS,
    CATEGORY_DESCRIPTIONS,
    get_preset_patterns,
)
from app.services.analyzers.regex import RegexAnalyzer
from app.services.analyzers.sudachi import SudachiProperNounAnalyzer

__all__ = [
    "Analyzer",
    "AnalyzerRequest",
    "BUILTIN_PATTERNS",
    "CATEGORY_DESCRIPTIONS",
    "PresidioAnalyzer",
    "RegexAnalyzer",
    "SudachiProperNounAnalyzer",
    "get_preset_patterns",
]
