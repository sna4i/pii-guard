"""Tests for the pure-heuristic CJK-ratio language detector.

These exercise :func:`app.services.language_detection.detect_language`
in isolation from the rest of ``MaskingService``. The detector has no
dependency on Presidio / Sudachi / config repositories, so the tests
can run in milliseconds and live outside the main integration file.
"""

from __future__ import annotations

from app.services.language_detection import detect_language


def test_pure_english_is_en() -> None:
    """Plain ASCII with zero Japanese characters must classify as ``en``."""
    assert detect_language("Hello world") == "en"


def test_pure_japanese_is_ja() -> None:
    """A wholly Japanese sentence must classify as ``ja``."""
    assert detect_language("今日は良い天気です") == "ja"


def test_mixed_is_not_en() -> None:
    """A string that mixes English and a Japanese name must not fall
    through to the English-only chain.

    The exact label is either ``"mixed"`` or ``"ja"`` depending on the
    ratio; what matters for the dispatcher is that it is NOT ``"en"``,
    because that would skip the Japanese analyzer entirely and leak
    the name.
    """
    label = detect_language("Contact 田中 at tanaka@example.com")
    assert label != "en"
    assert label in {"ja", "mixed"}


def test_empty_string_is_en() -> None:
    """Empty input must not crash and must fall back to ``en``.

    ``en`` is the safe default because the English path always runs in
    the legacy code path; classifying empty text as ``ja`` would
    pointlessly warm the Sudachi dictionary on a zero-length request.
    """
    assert detect_language("") == "en"


def test_whitespace_only_is_en() -> None:
    """Leading / trailing whitespace must not count toward the ratio
    and must not crash the zero-denominator guard."""
    assert detect_language("   \n\t  ") == "en"


def test_threshold_tunable_raises_bar_for_ja() -> None:
    """A high ``ja_threshold`` shifts a borderline string from ``ja``
    to ``mixed``.

    We pick a string where exactly half the non-whitespace characters
    are Japanese. The default ``ja_threshold=0.2`` tags it as ``ja``;
    bumping the threshold to ``0.9`` forces it into ``mixed`` (ratio
    ``0.5`` no longer meets the bar, but there is still at least one
    JA char so it cannot be ``en``).
    """
    borderline = "ab日本"
    assert detect_language(borderline, ja_threshold=0.2) == "ja"
    assert detect_language(borderline, ja_threshold=0.9) == "mixed"


def test_katakana_is_japanese() -> None:
    """Katakana-only strings (``カタカナ``) must classify as ``ja``.

    Hiragana and Katakana share the same top-level language but live
    in different Unicode blocks, so this guards against regressions
    where the Katakana range is accidentally dropped from the
    codepoint set.
    """
    assert detect_language("カタカナ") == "ja"


def test_single_japanese_char_in_long_english_is_mixed() -> None:
    """A long English sentence with a single Japanese name drops below
    the default threshold and should fall into ``mixed``, not ``ja``.

    This pins the intent of the ``0.2`` default: tiny amounts of
    Japanese in an otherwise English document still reach the
    ``mixed`` dispatcher so both analyzer chains can run, but the
    document is not treated as pure Japanese.
    """
    text = "This is a long English sentence that mentions 田 once."
    assert detect_language(text) == "mixed"
