"""Tests for Milestone 8 Wave A — aggregation, force-mask, business presets.

Covers:

* ``aggregate_detections`` collapses duplicate surfaces into one
  :class:`AggregatedEntity` with ``count`` / ``positions`` populated and
  the big ``category`` resolved via :mod:`app.services.category_map`.
* The force-mask keyword trigger fires only when the keyword's surface
  is a 名詞 per Sudachi POS (or a case-insensitive substring match for
  ASCII keywords).
* The new ``POST /v1/extension/sanitize/aggregated`` endpoint returns
  the aggregated payload shape.
* Every one of the 15 business-document preset categories introduced
  in Wave A fires on a representative input string.

The dummy repo helpers live in ``tests/conftest.py`` so every test in
the suite uses the same in-memory stubs.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import (
    DetectionResult,
    RuntimeConfig,
    TextSanitizeRequest,
)
from app.routes import extension as extension_module
from app.services.aggregation import aggregate_detections
from app.services.force_mask import (
    apply_force_mask,
    detect_force_mask_trigger,
    resolve_forced_categories,
)
from app.services.masking_service import MaskingService

from conftest import DummyAuditRepository, DummyConfigRepository


# =========================================================================
# aggregate_detections()
# =========================================================================


def _det(
    entity_type: str,
    start: int,
    end: int,
    text: str,
    *,
    action: str = "masked",
) -> DetectionResult:
    """Build a :class:`DetectionResult` with sensible defaults for tests."""
    return DetectionResult(
        entity_type=entity_type,
        start=start,
        end=end,
        score=1.0,
        text=text,
        line=1,
        column=start + 1,
        context_before="",
        context_after="",
        action=action,  # type: ignore[arg-type]
    )


def test_aggregate_collapses_duplicate_surfaces() -> None:
    """Two occurrences of the same surface should collapse into one row
    with count=2 and both positions recorded."""
    detections = [
        _det("PROPER_NOUN_PERSON", 0, 4, "田中太郎"),
        _det("PROPER_NOUN_PERSON", 5, 9, "田中太郎"),
    ]
    aggregated = aggregate_detections(detections)
    assert len(aggregated) == 1, f"expected 1 aggregated row, got {aggregated}"
    entity = aggregated[0]
    assert entity.value == "田中太郎"
    assert entity.count == 2
    assert entity.positions == [(0, 4), (5, 9)]
    assert entity.label == "PROPER_NOUN_PERSON"
    assert entity.masked is True


def test_aggregate_assigns_category() -> None:
    """Person detections resolve to category=PERSON via category_map."""
    detections = [
        _det("PROPER_NOUN_PERSON", 0, 4, "田中太郎"),
        _det("EMAIL_ADDRESS", 10, 27, "user@example.com"),
    ]
    aggregated = aggregate_detections(detections)
    by_value = {e.value: e for e in aggregated}
    assert by_value["田中太郎"].category == "PERSON"
    assert by_value["user@example.com"].category == "CONTACT"


def test_aggregate_first_occurrence_wins_label() -> None:
    """When the same surface fires under two labels, the lowest-start
    label wins (first occurrence precedence)."""
    detections = [
        _det("PROPER_NOUN_LOCATION", 0, 2, "東京"),
        _det("LOCATION", 5, 7, "東京"),  # later start; should lose
    ]
    aggregated = aggregate_detections(detections)
    assert len(aggregated) == 1
    # The first-occurrence label wins, so the analyzer-level tag is the
    # Sudachi one.
    assert aggregated[0].label == "PROPER_NOUN_LOCATION"
    assert aggregated[0].count == 2


def test_aggregate_preserves_first_occurrence_order() -> None:
    """Output order matches the order surfaces first appear in the
    input so the UI sidebar does not flicker on re-render."""
    detections = [
        _det("EMAIL_ADDRESS", 0, 17, "b@example.com"),
        _det("PROPER_NOUN_PERSON", 20, 22, "田中"),
        _det("EMAIL_ADDRESS", 30, 47, "b@example.com"),
    ]
    aggregated = aggregate_detections(detections)
    values = [e.value for e in aggregated]
    assert values == ["b@example.com", "田中"]


# =========================================================================
# Force-mask keyword trigger
# =========================================================================


class _StubTokenizer:
    """Pre-canned ``(surface, pos)`` pairs for the Japanese POS check.

    The force-mask trigger only cares about ``surface`` and ``pos[0]``
    so we mock just those. Replaces Sudachi in the unit tests so the
    trigger can be exercised without loading the 50 MB dictionary on
    every run.
    """

    def __init__(self, tokens: list[tuple[str, tuple[str, ...]]]) -> None:
        self._tokens = tokens

    def __call__(self, text: str) -> list[tuple[str, tuple[str, ...]]]:
        return self._tokens


def test_force_mask_fires_when_keyword_is_noun() -> None:
    """``リーク`` tokenized as 名詞 must trigger the force-mask."""
    tokenizer = _StubTokenizer(
        [
            ("リーク", ("名詞", "普通名詞", "一般", "*", "*", "*")),
            ("情報", ("名詞", "普通名詞", "一般", "*", "*", "*")),
        ]
    )
    fired = detect_force_mask_trigger(
        "これはリーク情報です",
        ["リーク"],
        tokenizer_fn=tokenizer,
    )
    assert fired == ["リーク"]


def test_force_mask_respects_sudachi_pos() -> None:
    """When the keyword's surface appears but Sudachi tags it as a non-
    noun (e.g. verb / particle / symbol), the trigger must NOT fire."""
    tokenizer = _StubTokenizer(
        [
            # Keyword surface is present but its POS is "動詞" (verb).
            # Pure string-in would fire; POS-aware must not.
            ("機密", ("動詞", "非自立可能", "*", "*", "*", "*")),
        ]
    )
    fired = detect_force_mask_trigger(
        "機密あり",
        ["機密"],
        tokenizer_fn=tokenizer,
    )
    assert fired == [], f"force-mask fired on a non-noun POS: {fired}"


def test_force_mask_ascii_keyword_substring_match() -> None:
    """ASCII keywords use case-insensitive substring matching; no Sudachi
    pass is needed because Sudachi only tokenizes Japanese."""
    tokenizer = _StubTokenizer([])
    fired = detect_force_mask_trigger(
        "This is a LEAK alert",
        ["leak", "confidential"],
        tokenizer_fn=tokenizer,
    )
    assert fired == ["leak"], (
        f"expected case-insensitive match on 'leak', got {fired}"
    )


def test_resolve_forced_categories_empty_when_no_keyword_fires() -> None:
    assert resolve_forced_categories([], ["PERSON", "FINANCIAL"]) == []


def test_resolve_forced_categories_returns_configured_list() -> None:
    assert resolve_forced_categories(
        ["リーク"], ["PERSON", "FINANCIAL", "PERSON"]
    ) == ["PERSON", "FINANCIAL"]  # de-duped, order preserved


def test_apply_force_mask_flips_masked_for_matching_categories() -> None:
    """Entities whose category is in the forced list must have
    ``masked`` set to True; others are untouched."""
    detections = [
        _det("PROPER_NOUN_PERSON", 0, 4, "田中太郎", action="allowed"),
        _det("MONETARY_AMOUNT", 10, 17, "1200万円"),
        _det("EMAIL_ADDRESS", 20, 37, "a@example.com", action="allowed"),
    ]
    aggregated = aggregate_detections(detections)
    # ``allowed`` action initially makes masked=False for PERSON.
    by_value = {e.value: e for e in aggregated}
    assert by_value["田中太郎"].masked is False

    forced = apply_force_mask(aggregated, ["PERSON", "FINANCIAL"])
    forced_by_value = {e.value: e for e in forced}
    assert forced_by_value["田中太郎"].masked is True  # locked by PERSON
    assert forced_by_value["1200万円"].masked is True  # already True
    assert forced_by_value["a@example.com"].masked is False  # CONTACT, not forced


# =========================================================================
# Aggregated endpoint
# =========================================================================


def _install_dummy_service(monkeypatch, *, config: RuntimeConfig | None = None) -> None:
    """Swap the route's shared MaskingService with a dummy-repo-backed one."""
    audit_repo = DummyAuditRepository()
    service = MaskingService(DummyConfigRepository(config), audit_repo)
    monkeypatch.setattr(extension_module, "_masking_service", service)


def test_aggregated_endpoint_returns_aggregated_payload(monkeypatch) -> None:
    """POSTing to the new endpoint returns ``AggregatedExtensionResponse``
    with the aggregated list populated."""
    _install_dummy_service(monkeypatch)
    client = TestClient(create_app())

    response = client.post(
        "/v1/extension/sanitize/aggregated",
        json={
            "text": "contact user@example.com or user@example.com again",
            "service": "claude",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Echo
    assert body["original_text"].startswith("contact")
    # Aggregated shape
    assert "aggregated" in body
    assert isinstance(body["aggregated"], list)
    # The duplicated email must collapse into one row with count=2.
    emails = [e for e in body["aggregated"] if e["value"] == "user@example.com"]
    assert len(emails) == 1
    email_entity = emails[0]
    assert email_entity["count"] == 2
    assert email_entity["category"] == "CONTACT"
    assert email_entity["label"] == "EMAIL_ADDRESS"
    # force_masked_categories is present and empty (no keyword fired).
    assert body["force_masked_categories"] == []
    # audit_id is a string uuid.
    assert isinstance(body["audit_id"], str) and body["audit_id"]


def test_aggregated_endpoint_force_mask_locks_person(monkeypatch) -> None:
    """A text containing ``リーク`` must force PERSON category rows to
    ``masked=True`` and surface ``PERSON`` in force_masked_categories."""
    # Opt into Sudachi so the Japanese keyword is POS-checked via the
    # real tokenizer. The default config ships reasonable defaults for
    # force_mask_keywords / force_mask_categories.
    config = RuntimeConfig(
        filter_enabled=True,
        morphological_analyzer="sudachi",
    )
    _install_dummy_service(monkeypatch, config=config)
    client = TestClient(create_app())

    response = client.post(
        "/v1/extension/sanitize/aggregated",
        json={
            "text": "これはリーク情報です。田中太郎の話。",
            "service": "claude",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    forced = body["force_masked_categories"]
    assert "PERSON" in forced, f"expected PERSON to be force-masked, got {forced}"

    # 田中太郎 row should have masked=True (either natively or because
    # force-mask locked it).
    person_rows = [e for e in body["aggregated"] if e["category"] == "PERSON"]
    assert person_rows, "expected at least one PERSON row"
    assert all(row["masked"] for row in person_rows)


# =========================================================================
# Business-document preset categories (15)
# =========================================================================


def _run_preset(text: str) -> list[str]:
    """Shorthand: run MaskingService with presets enabled and return the
    list of detected entity_types."""
    config = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    result = service.sanitize_text(TextSanitizeRequest(text=text))
    return [d.entity_type for d in result.detections]


def test_preset_detects_postal_code() -> None:
    assert "POSTAL_CODE" in _run_preset("住所 〒651-0087 兵庫県")


def test_preset_detects_department() -> None:
    assert "DEPARTMENT" in _run_preset("所属 DIV-101")


def test_preset_detects_contract_number() -> None:
    assert "CONTRACT_NUMBER" in _run_preset("契約: CONTRACT-ABC-001")


def test_preset_detects_purchase_order() -> None:
    assert "PURCHASE_ORDER" in _run_preset("PO-1234567")


def test_preset_detects_customer_id() -> None:
    assert "CUSTOMER_ID" in _run_preset("顧客ID: C-999-ABC")


def test_preset_detects_invoice_number() -> None:
    assert "INVOICE_NUMBER" in _run_preset("INV-20240415 を発行")


def test_preset_detects_employee_id() -> None:
    assert "EMPLOYEE_ID" in _run_preset("社員番号: E-0042")


def test_preset_detects_member_id() -> None:
    assert "MEMBER_ID" in _run_preset("MEMBER-123456 様")


def test_preset_detects_patient_id() -> None:
    assert "PATIENT_ID" in _run_preset("PATIENT-12345 を確認")


def test_preset_detects_sku() -> None:
    assert "SKU" in _run_preset("型番 SKU-ABC-123")


def test_preset_detects_blood_type() -> None:
    # AB型 must be preferred over A型 by the alternation ordering.
    detections = _run_preset("血液型: AB型の人")
    assert "BLOOD_TYPE" in detections


def test_preset_detects_annual_income() -> None:
    assert "ANNUAL_INCOME" in _run_preset("年収1200万円を提示")


def test_preset_detects_patent_number() -> None:
    assert "PATENT_NUMBER" in _run_preset("特許2024-123456 を申請")


def test_preset_detects_asset_number() -> None:
    assert "ASSET_NUMBER" in _run_preset("ASSET-12345 を確認")


def test_preset_detects_license_number() -> None:
    assert "LICENSE_NUMBER" in _run_preset("LIC-ABC-2024 を更新")
