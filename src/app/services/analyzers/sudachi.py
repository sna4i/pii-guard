"""Japanese proper-noun analyzer backed by SudachiPy.

This module is deliberately self-contained: it exposes a small analyzer
class that returns plain dataclass instances and has no dependency on
Presidio at the tokenization layer. The ``MaskingService`` integration
lifts those records into ``RecognizerResult`` objects at call time so
the rest of the pipeline (allow-list filtering, strategy application,
detection reporting) keeps working unchanged.

The analyzer only reports morphemes whose part-of-speech tuple starts
with ``("名詞", "固有名詞", ...)``. Everything else — including the
otherwise plentiful ``("名詞", "一般", ...)`` common nouns — is dropped.
This matches the explicit product requirement:

    形態素解析で固有名詞を抽出してマスクし、一般名詞はマスクしない

``SudachiPy 0.6+`` returns codepoint-based offsets from
``Morpheme.begin()`` / ``Morpheme.end()``, which means the reported
``start`` / ``end`` spans can be used directly to slice the original
Python ``str`` — no byte-to-char translation is needed. The
``tests/test_sudachi_analyzer.py`` suite pins that invariant so a
future SudachiPy regression would fail loudly instead of silently
producing garbled spans.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, overload

from presidio_analyzer import RecognizerResult
from sudachipy import Dictionary, SplitMode, Tokenizer

from app.services.analyzers.base import AnalyzerRequest


#: Sudachi offers three split granularities.  ``C`` keeps multi-morpheme
#: proper nouns fused together (e.g. ``東京タワー`` as a single token)
#: and is the correct default for masking-oriented use cases where we
#: would rather over-span than split a name in half. ``A`` splits the
#: same string into its constituent morphemes, ``B`` sits in the middle.
SudachiSplitMode = Literal["A", "B", "C"]


@dataclass(frozen=True)
class SudachiDetection:
    """A single proper-noun span detected by Sudachi.

    Offsets are codepoint-based, matching what ``MaskingService`` stores
    for Presidio detections so the two sources can be merged without
    any translation step. ``score`` is always ``1.0`` for now — Sudachi
    does not return a per-morpheme confidence, and a fixed score keeps
    the overlap resolver in ``masking_service.py`` simple.
    """

    entity_type: str
    start: int
    end: int
    score: float
    surface: str


#: Map of Sudachi's third POS slot (``pos[2]``) to the detection's
#: ``entity_type``. Everything not in this table falls back to the
#: generic ``PROPER_NOUN`` tag.
_FINE_POS_TO_ENTITY: dict[str, str] = {
    "人名": "PROPER_NOUN_PERSON",
    "地名": "PROPER_NOUN_LOCATION",
    "組織": "PROPER_NOUN_ORG",
}


#: Hardcoded surnames that are ALSO listed as placenames in Sudachi's
#: default core dictionary. Every entry here is a string where both
#: readings are real and plausible in Japanese text: ``千葉`` is a
#: prefecture and one of the top-200 surnames; ``福岡`` likewise; and so
#: on. Because Sudachi returns a deterministic category per token
#: (the ``人名`` / ``地名`` slot in the POS 6-tuple), the default
#: dictionary labels these as ``地名`` — which is fine for
#: location-heavy corpora but surprises masking pipelines that see
#: signature lines like ``千葉 太郎`` where the first token is
#: obviously the surname.
#:
#: When ``RuntimeConfig.prefer_surname_for_ambiguous`` is ``True``,
#: the analyzer relabels every ``PROPER_NOUN_LOCATION`` whose surface
#: is in this set to ``PROPER_NOUN_PERSON``. That is deliberately a
#: hack, not ML: it trades the (rare) false positive "``千葉 県`` gets
#: tagged as a person" for the (common) false negative "``千葉 様`` gets
#: tagged as a place". Operators who want real disambiguation should
#: either build a GiNZA / spaCy-ja recognizer or train a custom NER;
#: both are out of scope for the local gateway.
#:
#: The set is intentionally tiny — four entries chosen because they
#: are the canonical examples used in the TODO.md discussion of this
#: feature. Adding more surfaces here is a one-line change; adding a
#: per-operator override should go through ``RuntimeConfig`` rather
#: than growing this module-level constant.
SURNAMES_THAT_ARE_ALSO_PLACENAMES: frozenset[str] = frozenset({
    "千葉",
    "神戸",
    "岡山",
    "福岡",
})


#: Default POS prefix for the analyzer when a caller does not pass
#: ``pos_patterns`` — matches every ``名詞,固有名詞`` entry, which is the
#: pre-refactor behaviour and the schema default on ``RuntimeConfig``.
_DEFAULT_POS_PATTERNS: list[list[str]] = [["名詞", "固有名詞"]]


def _split_mode_from_str(mode: str) -> SplitMode:
    """Translate the string flag from ``RuntimeConfig`` to a ``SplitMode``."""
    if mode == "A":
        return SplitMode.A
    if mode == "B":
        return SplitMode.B
    if mode == "C":
        return SplitMode.C
    raise ValueError(f"unknown Sudachi split mode: {mode!r} (expected 'A', 'B', or 'C')")


def _pos_matches(pos: tuple[str, ...], patterns: list[list[str]]) -> bool:
    """Return True when ``pos`` starts with any of the configured patterns.

    Each entry in ``patterns`` is a prefix of the POS 6-tuple Sudachi
    returns from ``morpheme.part_of_speech()``. A morpheme matches if
    its POS tuple starts with *any* pattern — the check is a plain
    element-wise comparison rather than regex so the config payload
    stays trivially JSON-serialisable in ``runtime_config.json``.
    """
    for pattern in patterns:
        if len(pos) < len(pattern):
            continue
        if all(pos[i] == pattern[i] for i in range(len(pattern))):
            return True
    return False


class SudachiProperNounAnalyzer:
    """Extract Japanese proper-noun spans using SudachiPy.

    Instantiating this class loads the Sudachi dictionary (~50 MB of
    memory), so ``MaskingService`` lazily creates a single instance the
    first time a request opts in to morphological analysis. Subsequent
    calls reuse the same tokenizer.

    The class carries two public responsibilities on purpose:

    * The low-level tokenizer API — ``analyze(text: str)`` — returns a
      list of :class:`SudachiDetection` dataclass instances. Tests and
      anyone who wants raw proper-noun morphemes (with the ``surface``
      field intact) rely on this shape, so it is preserved verbatim
      from the pre-refactor ``sudachi_analyzer`` module.
    * The :class:`app.services.analyzers.base.Analyzer` protocol —
      ``analyze(request: AnalyzerRequest)`` returns a list of
      ``RecognizerResult`` instead, which is what ``MaskingService``
      concatenates with every other analyzer's output before running
      the masking strategy. That adapter used to live inline in
      ``MaskingService.sanitize_text``; hoisting it here means adding a
      new analyzer is a one-file drop-in.

    Runtime dispatch is a plain ``isinstance`` check on the argument,
    which is unambiguous because ``AnalyzerRequest`` is a dataclass and
    ``str`` is, well, a string. Both call sites keep their natural
    ergonomics and neither needs a second method name.
    """

    name = "sudachi"

    def __init__(
        self,
        split_mode: str = "C",
        pos_patterns: list[list[str]] | None = None,
        prefer_surname_for_ambiguous: bool = False,
    ) -> None:
        self._mode: SplitMode = _split_mode_from_str(split_mode)
        #: The POS prefix filter consulted on every ``_tokenize`` call.
        #: ``None`` falls back to ``_DEFAULT_POS_PATTERNS`` so the
        #: default construction (no kwargs) matches the pre-refactor
        #: ``名詞,固有名詞`` filter byte-for-byte. We deep-copy each
        #: inner list so a caller mutating the argument after
        #: construction cannot silently change the analyzer's filter.
        self._pos_patterns: list[list[str]] = (
            [list(pattern) for pattern in pos_patterns]
            if pos_patterns is not None
            else [list(pattern) for pattern in _DEFAULT_POS_PATTERNS]
        )
        #: Opt-in surname/placename disambiguation hack. See the
        #: module-level :data:`SURNAMES_THAT_ARE_ALSO_PLACENAMES`
        #: docstring for the rationale. Default ``False`` keeps the
        #: pre-existing behaviour byte-for-byte.
        self._prefer_surname_for_ambiguous: bool = prefer_surname_for_ambiguous
        self._tokenizer: Tokenizer = Dictionary().create()

    @overload
    def analyze(self, arg: str) -> list[SudachiDetection]:
        ...

    @overload
    def analyze(self, arg: AnalyzerRequest) -> list[RecognizerResult]:
        ...

    def analyze(
        self, arg: str | AnalyzerRequest
    ) -> list[SudachiDetection] | list[RecognizerResult]:
        """Tokenize ``arg`` and return proper-noun detections.

        Passing a raw ``str`` returns the low-level
        :class:`SudachiDetection` records so callers who want the
        ``surface`` field (tests, ad-hoc experimentation) keep working
        unchanged. Passing an :class:`AnalyzerRequest` returns
        ``RecognizerResult`` records — Presidio's native type, which is
        what the ``MaskingService`` pipeline feeds into the overlap
        resolver and masking strategies.
        """
        if isinstance(arg, AnalyzerRequest):
            return [
                RecognizerResult(
                    entity_type=det.entity_type,
                    start=det.start,
                    end=det.end,
                    score=det.score,
                )
                for det in self._tokenize(arg.text)
            ]
        return self._tokenize(arg)

    def _tokenize(self, text: str) -> list[SudachiDetection]:
        """Return every proper-noun morpheme detected in ``text``.

        Empty input returns an empty list without touching the
        tokenizer, which avoids a surprise allocation on the hot path
        when a caller sends a zero-length body.
        """
        if not text:
            return []

        detections: list[SudachiDetection] = []
        for morpheme in self._tokenizer.tokenize(text, self._mode):
            pos = morpheme.part_of_speech()
            # The POS tuple is always length 6 for modern Sudachi
            # dictionaries; ``_pos_matches`` keeps only morphemes whose
            # prefix matches one of the configured patterns, which
            # defaults to ``名詞,固有名詞`` — i.e. every proper noun and
            # nothing else (no particles, verbs, symbols, or common
            # nouns). Operators can broaden or tighten the filter via
            # ``RuntimeConfig.proper_noun_pos_patterns``.
            if not _pos_matches(pos, self._pos_patterns):
                continue

            fine = pos[2] if len(pos) > 2 else ""
            entity_type = _FINE_POS_TO_ENTITY.get(fine, "PROPER_NOUN")

            # Pragmatic surname/placename disambiguation: when the flag
            # is on AND this morpheme came through as ``PROPER_NOUN_LOCATION``
            # AND its surface is one of the hardcoded ambiguous
            # surnames, relabel to ``PROPER_NOUN_PERSON``. This runs
            # *after* the POS filter because the morpheme's POS tuple
            # does not change — we just disagree with the default
            # dictionary's category assignment for that specific surface.
            surface = morpheme.surface()
            if (
                self._prefer_surname_for_ambiguous
                and entity_type == "PROPER_NOUN_LOCATION"
                and surface in SURNAMES_THAT_ARE_ALSO_PLACENAMES
            ):
                entity_type = "PROPER_NOUN_PERSON"

            detections.append(
                SudachiDetection(
                    entity_type=entity_type,
                    start=morpheme.begin(),
                    end=morpheme.end(),
                    score=1.0,
                    surface=surface,
                )
            )
        return detections
