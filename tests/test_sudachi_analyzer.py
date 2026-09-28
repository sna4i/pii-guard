"""Tests for the Sudachi-based Japanese proper-noun analyzer.

These cover both the standalone ``SudachiProperNounAnalyzer`` and its
integration into ``MaskingService`` behind the opt-in
``RuntimeConfig.morphological_analyzer`` flag. The ``DummyConfigRepository``
/ ``DummyAuditRepository`` helpers live in ``tests/conftest.py`` so the
same in-memory stubs are shared across the whole suite.
"""
from __future__ import annotations

from app.models.schemas import RuntimeConfig, TextSanitizeRequest
from app.services.analyzers import SudachiProperNounAnalyzer
from app.services.masking_service import MaskingService

from conftest import DummyAuditRepository, DummyConfigRepository


def test_detects_person_and_location() -> None:
    """Well-known proper nouns should round-trip through the analyzer,
    while the verb 住ん(でいる) must not appear in any detection."""
    analyzer = SudachiProperNounAnalyzer()
    detections = analyzer.analyze("田中太郎は東京に住んでいる")

    surfaces = {det.surface for det in detections}
    # Depending on Sudachi's dictionary version the personal name may
    # come through as a single morpheme or split into surname + given
    # name, so we accept either shape. Same for Tokyo.
    assert (
        "田中太郎" in surfaces
        or ("田中" in surfaces and "太郎" in surfaces)
    ), f"expected 田中太郎 in detections, got {surfaces}"
    assert "東京" in surfaces, f"expected 東京 in detections, got {surfaces}"

    # And crucially: no verb stem leaks in.
    assert "住ん" not in surfaces
    assert "住んでいる" not in surfaces

    proper_noun_types = {det.entity_type for det in detections}
    # Every detection must be one of our PROPER_NOUN_* tags.
    assert proper_noun_types <= {
        "PROPER_NOUN",
        "PROPER_NOUN_PERSON",
        "PROPER_NOUN_LOCATION",
        "PROPER_NOUN_ORG",
    }


def test_excludes_common_nouns() -> None:
    """名詞,一般 ('common noun') must never surface as a detection."""
    analyzer = SudachiProperNounAnalyzer()
    detections = analyzer.analyze("これは会社の車です")

    assert detections == [], (
        f"expected zero detections for common-noun-only text, got {detections}"
    )


def test_offsets_are_codepoint_based() -> None:
    """Guard against a regression to byte-based offsets in SudachiPy.

    ``text[detection.start:detection.end]`` must reconstruct the exact
    surface string — if SudachiPy ever flips back to byte offsets for
    multi-byte characters this assertion fails loudly.
    """
    text = "hello 田中 world"
    analyzer = SudachiProperNounAnalyzer()
    detections = analyzer.analyze(text)

    tanaka = next((det for det in detections if det.surface == "田中"), None)
    assert tanaka is not None, f"expected 田中 detection in {text!r}"
    assert text[tanaka.start:tanaka.end] == "田中"


def test_masking_service_integration() -> None:
    """With ``morphological_analyzer="sudachi"`` the service must
    strip Japanese proper nouns from ``sanitized_text`` and report
    them in ``detections``."""
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="田中太郎は東京本社にいる")

    result = service.sanitize_text(request)

    assert "田中太郎" not in result.sanitized_text
    assert "東京" not in result.sanitized_text
    # Numbered placeholders ``<LABEL_N>`` are the result of the tag
    # strategy refactor; prefix match tolerates whatever subcategory
    # / index Sudachi picks.
    assert (
        "<PROPER_NOUN_PERSON_" in result.sanitized_text
        or "<PROPER_NOUN_" in result.sanitized_text
    )

    masked = [d for d in result.detections if d.action == "masked"]
    assert masked, "expected at least one masked Japanese detection"
    assert any(d.entity_type.startswith("PROPER_NOUN") for d in masked)


def test_opt_in_default_off() -> None:
    """With the default config (``morphological_analyzer="none"``) the
    Sudachi analyzer must not run. We assert on the service's internal
    analyzer map rather than Presidio's output — Presidio's English NER
    is free to flag or not flag 東京 on its own, which is out of scope
    for this opt-in guard."""
    config = RuntimeConfig(filter_enabled=True)  # default: "none"
    assert config.morphological_analyzer == "none"

    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="田中太郎は東京にいる")

    service.sanitize_text(request)

    # The lazy Sudachi analyzer must not have been constructed — its
    # presence in the internal analyzer cache would mean the opt-in
    # default leaked.
    assert "sudachi" not in service._analyzers, (
        "Sudachi analyzer was constructed despite morphological_analyzer='none'"
    )


def test_split_mode_a_splits_compounds() -> None:
    """SplitMode.A must produce *more* tokens than C on a compound proper
    noun. The exact surfaces depend on the Sudachi dictionary version,
    so we compare counts rather than fixed strings. ``東京スカイツリー``
    is a compound where both halves are proper nouns in the default
    core dictionary: under C the whole string fuses into a single
    ``PROPER_NOUN`` detection, under A it splits into ``東京`` +
    ``スカイツリー``. ``東京タワー`` would *not* work here — ``タワー``
    is a common noun in the core dict and gets filtered out by the POS
    filter, collapsing A's output back to one.
    """
    compound = "東京スカイツリー"

    analyzer_c = SudachiProperNounAnalyzer(split_mode="C")
    detections_c = analyzer_c.analyze(compound)

    analyzer_a = SudachiProperNounAnalyzer(split_mode="A")
    detections_a = analyzer_a.analyze(compound)

    assert len(detections_a) > len(detections_c), (
        f"expected split_mode=A to yield more detections than C for {compound!r}; "
        f"got A={[(d.surface, d.entity_type) for d in detections_a]} "
        f"vs C={[(d.surface, d.entity_type) for d in detections_c]}"
    )
    assert len(detections_c) == 1, (
        f"expected split_mode=C to fuse {compound!r} into a single proper-noun "
        f"detection, got {detections_c}"
    )
    # The POS filter is orthogonal to the split mode, so every morpheme
    # A returns must still be a proper-noun subcategory.
    for det in detections_a:
        assert det.entity_type in {
            "PROPER_NOUN",
            "PROPER_NOUN_PERSON",
            "PROPER_NOUN_LOCATION",
            "PROPER_NOUN_ORG",
        }, f"unexpected entity_type from split_mode=A: {det}"


def test_pos_pattern_excludes_location() -> None:
    """Narrowing ``pos_patterns`` to ``["名詞", "固有名詞", "人名"]`` must
    keep personal names but drop place names. This exercises both sides
    of the prefix match: ``田中太郎`` has a ``人名`` slot and survives
    while ``東京`` — whose POS tuple starts with ``("名詞", "固有名詞",
    "地名", ...)`` — is filtered out."""
    analyzer = SudachiProperNounAnalyzer(
        pos_patterns=[["名詞", "固有名詞", "人名"]],
    )
    detections = analyzer.analyze("田中太郎は東京に住んでいる")
    surfaces = {det.surface for det in detections}

    person_detected = (
        "田中太郎" in surfaces
        or ("田中" in surfaces and "太郎" in surfaces)
    )
    assert person_detected, (
        f"expected 田中太郎 (or its split form) to still be detected under "
        f"人名-only filter, got {surfaces}"
    )

    assert "東京" not in surfaces, (
        f"東京 must be filtered out when pos_patterns requires 人名 "
        f"specifically, got {surfaces}"
    )

    # Every remaining detection must be a PERSON — the filter excludes
    # every other proper-noun subcategory by construction.
    for det in detections:
        assert det.entity_type == "PROPER_NOUN_PERSON", (
            f"expected only PROPER_NOUN_PERSON detections with 人名 filter, got {det}"
        )


def test_prefer_surname_for_ambiguous_relabels_location_to_person() -> None:
    """With the opt-in flag set, Sudachi's ``千葉`` (tagged ``地名`` in
    the default core dictionary) must come through as
    ``PROPER_NOUN_PERSON`` rather than ``PROPER_NOUN_LOCATION``.

    Default ``False`` preserves the pre-existing behaviour and is
    covered by every other test in this file; here we only pin the
    opt-in branch. The hardcoded set lives in the analyzer module
    under ``SURNAMES_THAT_ARE_ALSO_PLACENAMES`` and is intentionally
    tiny — see the docstring there for the rationale.
    """
    analyzer = SudachiProperNounAnalyzer(prefer_surname_for_ambiguous=True)
    detections = analyzer.analyze("千葉は大阪に住んでいる")

    chiba = next((det for det in detections if det.surface == "千葉"), None)
    assert chiba is not None, (
        f"expected 千葉 to be detected, got {[(d.surface, d.entity_type) for d in detections]}"
    )
    assert chiba.entity_type == "PROPER_NOUN_PERSON", (
        f"expected 千葉 to be relabeled to PROPER_NOUN_PERSON under the "
        f"opt-in flag, got {chiba.entity_type}"
    )

    # Sanity check: 大阪 is NOT in the hardcoded set so it must remain
    # a location. This guards against the relabel accidentally firing
    # on every PROPER_NOUN_LOCATION.
    osaka = next((det for det in detections if det.surface == "大阪"), None)
    if osaka is not None:
        assert osaka.entity_type == "PROPER_NOUN_LOCATION", (
            f"expected 大阪 to stay a LOCATION, got {osaka.entity_type}"
        )


def test_masking_service_honors_sudachi_config() -> None:
    """The masking service must thread ``sudachi_split_mode`` and
    ``proper_noun_pos_patterns`` from ``RuntimeConfig`` through to the
    analyzer. We pick ``A`` specifically to distinguish this from the
    default ``C`` code path, and use the default POS pattern so the
    fused assertions still hold for either split mode.
    """
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
        sudachi_split_mode="A",
        proper_noun_pos_patterns=[["名詞", "固有名詞"]],
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="田中太郎は東京本社にいる")

    result = service.sanitize_text(request)

    # The exact sanitized text depends on Sudachi's split-mode behaviour
    # on this particular compound, so we use loose assertions: at least
    # one proper-noun detection must fire, and the original literal
    # names must not survive in the sanitized output.
    masked = [d for d in result.detections if d.action == "masked"]
    assert masked, "expected at least one masked Japanese detection"
    assert any(d.entity_type.startswith("PROPER_NOUN") for d in masked)
    assert "田中太郎" not in result.sanitized_text
    assert "東京" not in result.sanitized_text

    # The service must have constructed the Sudachi analyzer with the
    # config-supplied split_mode, so the cached instance should match.
    sudachi = service._analyzers.get("sudachi")
    assert sudachi is not None, "expected Sudachi analyzer to be cached after first call"
    # Fingerprint check — we threaded the config through, so the service
    # should have stored (split_mode, pos_patterns) as the rebuild key.
    assert service._analyzer_fingerprints.get("sudachi") == (
        "A",
        (("名詞", "固有名詞"),),
    )
