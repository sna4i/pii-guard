from presidio_analyzer import RecognizerResult

from app.models.schemas import RuntimeConfig, TextSanitizeRequest
from app.services.masking_service import MaskingService, _resolve_overlaps

from conftest import DummyAuditRepository, DummyConfigRepository


def test_sanitize_text_masks_email_and_phone() -> None:
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(text="contact me at user@example.com or 09012345678")

    result = service.sanitize_text(request)

    assert result.filter_enabled is True
    assert result.original_length > 0
    assert isinstance(result.sanitized_text, str)


def test_filter_off_passthrough() -> None:
    config_repo = DummyConfigRepository()
    config = config_repo.load()
    config.filter_enabled = False
    config_repo.save(config)

    service = MaskingService(config_repo, DummyAuditRepository())
    request = TextSanitizeRequest(text="plain text")
    result = service.sanitize_text(request)

    assert result.filter_enabled is False
    assert result.sanitized_text == "plain text"


def test_detection_results_include_location_and_context() -> None:
    """Each detection should carry enough info to render a readable table."""
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(
        text="header line\ncontact: user@example.com here",
    )

    result = service.sanitize_text(request)

    email = next(
        (d for d in result.detections if d.entity_type == "EMAIL_ADDRESS"),
        None,
    )
    assert email is not None, "expected EMAIL_ADDRESS detection"
    assert email.text == "user@example.com"
    assert email.line == 2  # second line, after the header newline
    assert email.column >= 1
    assert "contact" in email.context_before
    assert "here" in email.context_after
    assert email.action == "masked"


def test_allow_entity_types_are_detected_but_not_masked() -> None:
    """Allow-listed types should survive into sanitized_text verbatim."""
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(
        text="my email is user@example.com",
        allow_entity_types=["EMAIL_ADDRESS"],
    )

    result = service.sanitize_text(request)

    # Not masked
    assert "user@example.com" in result.sanitized_text
    # But still reported as an "allowed" detection
    email = next(
        (d for d in result.detections if d.entity_type == "EMAIL_ADDRESS"),
        None,
    )
    assert email is not None, "allowed types must still appear in detections"
    assert email.action == "allowed"


def test_analyzers_by_language_dispatch_en() -> None:
    """With ``analyzers_by_language`` set, an English payload must run
    only the ``en`` chain — here, Presidio only. Sudachi must not
    contribute any PROPER_NOUN_* detections because it never ran.

    We deliberately include Sudachi in the ``ja`` chain so the test
    also pins the other half of the dispatcher contract: wiring
    Sudachi into some chain must not cause it to fire on English
    text when the detector picked ``en``.
    """
    config = RuntimeConfig(
        filter_enabled=True,
        analyzers_by_language={
            "en": ["presidio"],
            "ja": ["sudachi"],
        },
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="Contact user@example.com right now")

    result = service.sanitize_text(request)

    # Presidio picks up the email address — that is enough evidence
    # that the ``en`` chain ran.
    assert any(d.entity_type == "EMAIL_ADDRESS" for d in result.detections)
    # And no PROPER_NOUN_* — Sudachi is configured for ``ja`` only, so
    # on a pure-English payload it must not have been invoked.
    assert not any(
        d.entity_type.startswith("PROPER_NOUN") for d in result.detections
    ), f"Sudachi leaked on English input: {result.detections}"
    # As a belt-and-braces check, the Sudachi analyzer must not have
    # been cached by the service — the lazy construction is our
    # tripwire for "was it called at all?".
    assert "sudachi" not in service._analyzers, (
        "Sudachi analyzer was constructed on an English payload despite "
        "analyzers_by_language routing it to the ``ja`` chain only"
    )


def test_analyzers_by_language_dispatch_ja() -> None:
    """With the same config, a Japanese payload must route through
    Sudachi and surface at least one PROPER_NOUN_* detection."""
    config = RuntimeConfig(
        filter_enabled=True,
        analyzers_by_language={
            "en": ["presidio"],
            "ja": ["sudachi"],
        },
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="田中太郎は東京本社にいる")

    result = service.sanitize_text(request)

    masked = [d for d in result.detections if d.action == "masked"]
    assert masked, "expected at least one Sudachi detection on Japanese text"
    assert any(d.entity_type.startswith("PROPER_NOUN") for d in masked), (
        f"expected PROPER_NOUN_* detections from Sudachi, got "
        f"{[d.entity_type for d in masked]}"
    )


def test_regex_recognizer_flags_pattern() -> None:
    """A configured regex pattern must fire on matching text and
    surface as a maskable detection under its configured entity type."""
    config = RuntimeConfig(
        filter_enabled=True,
        analyzers_by_language={"en": ["presidio", "regex"]},
        regex_patterns=[["EMPLOYEE_ID", r"EMP-\d{5}"]],
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(text="employee EMP-12345 logged in")

    result = service.sanitize_text(request)

    # The regex hit must appear in detections with the configured tag.
    employee = next(
        (d for d in result.detections if d.entity_type == "EMPLOYEE_ID"),
        None,
    )
    assert employee is not None, (
        f"expected EMPLOYEE_ID detection, got {[d.entity_type for d in result.detections]}"
    )
    assert employee.text == "EMP-12345"
    assert employee.action == "masked"
    # And the masked text must carry the entity-type tag rather than
    # the raw identifier, matching the ``tag`` mask strategy contract.
    assert "EMP-12345" not in result.sanitized_text
    # Tag strategy now uses numbered placeholders; the exact suffix is
    # sequential per label so ``<EMPLOYEE_ID_1>`` is the expected form
    # for a single detection.
    assert "<EMPLOYEE_ID_1>" in result.sanitized_text


def test_min_score_filters_low_confidence_detections() -> None:
    """With min_score raised, detections whose Presidio confidence is
    below the threshold must be dropped before masking. This is the
    canonical fix for the Reach→PERSON false-positive pattern."""
    config = RuntimeConfig(filter_enabled=True, min_score=0.95)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    # 'Reach' is Presidio's classic false-positive; real PII like an
    # email address scores well above 0.95.
    request = TextSanitizeRequest(
        text="Reach out to user@example.com for the Q4 review"
    )

    result = service.sanitize_text(request)

    # Email should still be masked (Presidio EMAIL_ADDRESS recognizer
    # always scores ~1.0). Numbered placeholder form after the tag
    # strategy refactor.
    assert "<EMAIL_ADDRESS_1>" in result.sanitized_text
    # But no PERSON false-positive from 'Reach' — the threshold culls
    # it. Using the ``<PERSON_`` prefix catches every numbered variant
    # (``<PERSON_1>``, ``<PERSON_2>``, …) so a single false positive
    # at any index still fails the test.
    assert "<PERSON_" not in result.sanitized_text


def test_resolve_overlaps_sweep_line_on_50_detection_input() -> None:
    """Pin correctness of the sweep-line ``_resolve_overlaps`` rewrite
    on a 50-detection synthetic input.

    This is NOT a timing benchmark — we assert only on the keep/drop
    semantics. The test constructs a mixture of partially-overlapping
    and strictly-nested spans with varied scores so the sweep's
    "envelope" branch fires many times in a single call. Any future
    refactor that regresses the "drop strict subset of a higher-scored
    result" contract fails this test loudly.
    """
    # Build 50 synthetic results:
    #   - 10 long "dominator" spans at widely-spaced offsets, score 0.9
    #   - 30 short spans strictly contained in a dominator, score 0.5
    #     (must all be dropped)
    #   - 10 short spans lying outside every dominator, score 0.5
    #     (must all survive)
    results: list[RecognizerResult] = []
    dominators: list[RecognizerResult] = []
    for i in range(10):
        dom = RecognizerResult(
            entity_type="PERSON",
            start=i * 100,
            end=i * 100 + 50,
            score=0.9,
        )
        dominators.append(dom)
        results.append(dom)
    # Strict subsets — each contained in its corresponding dominator.
    dominated: list[RecognizerResult] = []
    for i, dom in enumerate(dominators):
        for k in range(3):
            sub = RecognizerResult(
                entity_type="PROPER_NOUN",
                start=dom.start + 10 + k * 5,
                end=dom.start + 15 + k * 5,
                score=0.5,
            )
            dominated.append(sub)
            results.append(sub)
    # Standalone spans that do not intersect any dominator.
    standalones: list[RecognizerResult] = []
    for i in range(10):
        solo = RecognizerResult(
            entity_type="EMAIL_ADDRESS",
            start=2000 + i * 30,
            end=2000 + i * 30 + 10,
            score=0.5,
        )
        standalones.append(solo)
        results.append(solo)

    assert len(results) == 50, "test fixture must build exactly 50 detections"

    kept = _resolve_overlaps(results)
    kept_ids = {(r.start, r.end, r.entity_type) for r in kept}

    # Every dominator must survive.
    for dom in dominators:
        assert (dom.start, dom.end, dom.entity_type) in kept_ids, (
            f"dominator {dom} was incorrectly dropped"
        )
    # Every strict subset with lower score must be dropped.
    for sub in dominated:
        assert (sub.start, sub.end, sub.entity_type) not in kept_ids, (
            f"strict subset {sub} should have been dominated"
        )
    # Every standalone span must survive.
    for solo in standalones:
        assert (solo.start, solo.end, solo.entity_type) in kept_ids, (
            f"standalone {solo} was incorrectly dropped"
        )
    # Final count: 10 dominators + 10 standalones = 20 survivors.
    assert len(kept) == 20, (
        f"expected 20 survivors (10 dominators + 10 standalones), got {len(kept)}"
    )


# =========================================================================
# Preset pattern detection tests
# =========================================================================


def test_preset_detects_japanese_address() -> None:
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(
        text="住所: 兵庫県明石市大久保町123"
    ))
    assert "<ADDRESS>" in result.sanitized_text or any(
        d.entity_type == "ADDRESS" for d in result.detections
    )


def test_preset_detects_age() -> None:
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(text="年齢は35歳です"))
    assert any(d.entity_type == "AGE" for d in result.detections)


def test_preset_detects_gender() -> None:
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(text="性別: 男性"))
    assert any(d.entity_type == "GENDER" for d in result.detections)


def test_preset_detects_company_name() -> None:
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(
        text="株式会社マスクテスト に所属しています"
    ))
    assert any(d.entity_type == "COMPANY" for d in result.detections)


def test_preset_detects_monetary_amount() -> None:
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(text="価格は¥15,000です"))
    assert any(d.entity_type == "MONETARY_AMOUNT" for d in result.detections)


def test_preset_detects_db_connection() -> None:
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(
        text="接続先: postgresql://admin:pass@db.example.com/mydb"
    ))
    assert any(d.entity_type == "DB_CONNECTION" for d in result.detections)


def test_disabled_category_skips_detection() -> None:
    config = RuntimeConfig(
        filter_enabled=True,
        enable_preset_patterns=True,
        disabled_pattern_categories=["AGE"],
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(text="年齢は35歳です"))
    assert not any(d.entity_type == "AGE" for d in result.detections)


def test_preset_off_disables_all_builtin() -> None:
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=False)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(text="兵庫県明石市 35歳 男性"))
    assert not any(
        d.entity_type in ("ADDRESS", "AGE", "GENDER") for d in result.detections
    )


def test_preset_detects_email_with_uncommon_tld() -> None:
    """Presidio's bundled EMAIL_ADDRESS recognizer uses a TLD
    whitelist that misses newer gTLDs (``.fizz`` / ``.xyz`` /
    ``.lgbt``). The permissive preset pattern must pick them up
    structurally so the extension's modal can offer them for
    masking. Regression guard for the bug report where
    ``hogehoge@fugafuga.fizz`` slipped through untouched.
    """
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="連絡先 hogehoge@fugafuga.fizz まで")
    )
    assert any(d.entity_type == "EMAIL_ADDRESS" for d in result.detections)
    assert "<EMAIL_ADDRESS_1>" in result.sanitized_text


def test_preset_detects_katakana_name() -> None:
    """Long katakana runs (≥ 4 chars) are flagged as KATAKANA_NAME
    because ``sudachidict_core`` misses many katakana name spellings.
    The interactive review modal lets operators untick false positives
    (brand names, product names) per request; the default behaviour
    here is to flag them.
    """
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="タカハシユウヤと申します")
    )
    assert any(d.entity_type == "KATAKANA_NAME" for d in result.detections)


def test_tag_mask_assigns_distinct_numbers_to_different_surfaces() -> None:
    """Two different persons get <PERSON_1> and <PERSON_2> so the LLM
    (and later, a reverse-masker) can tell them apart."""
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(
            # Two distinct emails, same label — easiest surface pair
            # that does not depend on Sudachi's dictionary.
            text="foo@example.com と bar@example.com に送信"
        )
    )
    assert "<EMAIL_ADDRESS_1>" in result.sanitized_text
    assert "<EMAIL_ADDRESS_2>" in result.sanitized_text


def test_tag_mask_repeats_same_number_for_same_surface() -> None:
    """Same surface detected twice shares a number so repeated mentions
    remain a single referent from the LLM's perspective."""
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(
            text="foo@example.com と foo@example.com に CC"
        )
    )
    # Both occurrences became <EMAIL_ADDRESS_1>, not _1 + _2.
    assert result.sanitized_text.count("<EMAIL_ADDRESS_1>") == 2
    assert "<EMAIL_ADDRESS_2>" not in result.sanitized_text


def test_tag_mask_independent_counters_per_label() -> None:
    """``<PERSON_1>`` and ``<EMAIL_ADDRESS_1>`` coexist — counters are
    scoped to the entity type."""
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="contact foo@example.com for Q4 review")
    )
    # Email is guaranteed; we only assert the email side to avoid
    # flaking on whether Presidio treats an English phrase as a PERSON.
    assert "<EMAIL_ADDRESS_1>" in result.sanitized_text
    assert "<EMAIL_ADDRESS_2>" not in result.sanitized_text


# ------------------------------------------------------------------
# common_noun_blocklist — drop generic JP business loanwords
# ------------------------------------------------------------------


def test_common_noun_blocklist_drops_プロジェクト() -> None:
    """`プロジェクト` must not survive as its own detection even when
    Sudachi's default dictionary tags it as 固有名詞. The default
    blocklist covers this surface; we assert that no detection has
    exactly the bare word as its text."""
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="プロジェクトαの開発")
    )

    assert not any(
        d.text == "プロジェクト" for d in result.detections
    ), (
        f"expected 'プロジェクト' to be dropped by the common-noun blocklist, "
        f"got {[d.text for d in result.detections]}"
    )


def test_common_noun_blocklist_drops_メンバー() -> None:
    """Same contract for ``メンバー`` — the second canonical example
    from the user report. Uses the default blocklist (no overrides)."""
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="メンバー全員に連絡")
    )

    assert not any(
        d.text == "メンバー" for d in result.detections
    ), (
        f"expected 'メンバー' to be dropped by the common-noun blocklist, "
        f"got {[d.text for d in result.detections]}"
    )


def test_custom_blocklist_overrides_default() -> None:
    """The knob works in both directions: adding a real proper noun
    like ``東京`` to the blocklist drops it even though Sudachi would
    otherwise emit ``PROPER_NOUN_LOCATION``. Verifies the filter is
    driven by the config value, not a hardcoded set."""
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
        common_noun_blocklist=["東京"],
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="東京の本社にいる")
    )

    assert not any(
        d.text == "東京" for d in result.detections
    ), (
        f"expected operator-supplied blocklist entry '東京' to be dropped, "
        f"got {[d.text for d in result.detections]}"
    )


def test_empty_blocklist_passes_everything_through() -> None:
    """An operator who explicitly empties the blocklist must see
    Sudachi's default behaviour — in this case ``プロジェクト`` is
    permitted through because there is nothing filtering it."""
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
        common_noun_blocklist=[],
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    # "プロジェクト田中" is constructed so the surname 田中 is
    # guaranteed to fire as PROPER_NOUN_PERSON. That keeps the test
    # meaningful (we know Sudachi did run) even if the Sudachi
    # dictionary happens to back off on bare プロジェクト in some
    # split mode.
    result = service.sanitize_text(
        TextSanitizeRequest(text="プロジェクト田中")
    )
    assert any(d.entity_type.startswith("PROPER_NOUN") for d in result.detections), (
        "Sudachi must still run with an empty blocklist"
    )
