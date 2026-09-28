"""Cheap heuristic language detector — no extra dependency.

Classifies a string as ``"ja"`` / ``"en"`` / ``"mixed"`` based on the
ratio of CJK-Unified / Hiragana / Katakana codepoints. The goal is NOT
to be a world-class language identifier — it is to decide which
analyzer chain to run on a given payload, and ``ja`` / ``en`` /
``mixed`` is enough signal for the dispatcher to make that call.

The dispatcher lives in :mod:`app.services.masking_service`; this
module is deliberately isolated from it so the same detector can later
be exposed as an MCP tool (see Milestone 5 in ``TODO.md``) without
circular imports.

Rationale for the pure-codepoint approach (vs. pulling in
``langdetect`` / ``fasttext`` / ``lingua``):

* Zero new dependency. Every extra wheel is extra Docker layers, and
  ``uv.lock`` stays minimal.
* Deterministic: the same string always returns the same label, no
  random seeding or training data drift.
* The only decision we need to make downstream is "should we run the
  Japanese analyzer chain or the English one?" — a binary split with
  a clear escape hatch (``mixed``) is exactly the right granularity.
"""

from __future__ import annotations

from typing import Literal

#: Alias for the three-way language label emitted by
#: :func:`detect_language`. Kept narrow so mypy can catch typos in
#: ``RuntimeConfig.analyzers_by_language`` keys at call sites that
#: dispatch on the result.
Language = Literal["ja", "en", "mixed"]


#: Unicode ranges that count as "Japanese-ish" for the detector.
#: Each tuple is an inclusive ``(low, high)`` range over codepoints.
#: We intentionally cover the two kana blocks plus the CJK-Unified
#: ideograph range — the same set of codepoints Sudachi would
#: tokenize into meaningful morphemes. Half-width katakana and the
#: Katakana Phonetic Extensions block are included so transliterated
#: payloads from legacy systems still trip the detector.
_JAPANESE_RANGES: tuple[tuple[int, int], ...] = (
    (0x3040, 0x309F),  # Hiragana
    (0x30A0, 0x30FF),  # Katakana
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0x31F0, 0x31FF),  # Katakana Phonetic Extensions
    (0xFF65, 0xFF9F),  # Half-width Katakana
)


def _is_japanese_char(char: str) -> bool:
    """Return True if ``char`` is in any of the configured JA ranges.

    Implemented as a plain linear scan over a 5-entry tuple — the
    constant factor is small enough that a dict / bisect lookup would
    only slow things down for typical payload lengths.
    """
    codepoint = ord(char)
    for low, high in _JAPANESE_RANGES:
        if low <= codepoint <= high:
            return True
    return False


def detect_language(text: str, *, ja_threshold: float = 0.2) -> Language:
    """Return ``"ja"`` / ``"en"`` / ``"mixed"`` for ``text``.

    The rule:

    * Let ``total`` be the count of non-whitespace characters.
    * Let ``ja_count`` be the subset of those characters that fall
      inside :data:`_JAPANESE_RANGES`.
    * ``ratio = ja_count / max(1, total)``.
    * ``ratio >= ja_threshold`` → ``"ja"``.
    * ``ratio == 0``            → ``"en"``.
    * otherwise                 → ``"mixed"``.

    Whitespace is excluded from both the numerator and the
    denominator so leading / trailing spacing does not dilute the
    score; ``"   日本語   "`` still classifies as ``"ja"``.

    An empty string returns ``"en"`` as a safe default — nothing
    Japanese is present, and the caller can then fall back to the
    English analyzer chain without any additional guards.

    Args:
        text: the string to classify.
        ja_threshold: minimum ratio of Japanese-range characters for
            the text to be tagged ``"ja"``. Defaults to ``0.2``, which
            empirically rejects English sentences that mention one or
            two Japanese proper nouns while still accepting Japanese
            text that quotes an English phrase.

    Returns:
        One of ``"ja"``, ``"en"``, or ``"mixed"``.
    """
    total = 0
    ja_count = 0
    for char in text:
        if char.isspace():
            continue
        total += 1
        if _is_japanese_char(char):
            ja_count += 1

    if total == 0:
        return "en"

    ratio = ja_count / total
    if ratio >= ja_threshold:
        return "ja"
    if ratio == 0:
        return "en"
    return "mixed"
