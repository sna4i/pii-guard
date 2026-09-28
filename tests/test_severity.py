"""Tests for the severity tier module + end-to-end severity wiring.

Covers:

- :func:`severity_for` static map spot checks (2-3 labels per tier).
- Unknown labels fall back to ``"low"``.
- ``SEVERITY_ORDER`` contains every value used by the static map.
- :func:`max_severity` picks the highest-risk tier in a list.
- Integration: ``DetectionResult.severity`` and
  ``AggregatedEntity.severity`` are populated when
  :class:`MaskingService` runs end-to-end.
"""
from __future__ import annotations

from app.models.schemas import RuntimeConfig, TextSanitizeRequest
from app.services.aggregation import aggregate_detections
from app.services.masking_service import MaskingService
from app.services.severity import (
    LABEL_TO_SEVERITY,
    SEVERITY_ORDER,
    max_severity,
    severity_for,
)

from conftest import DummyAuditRepository, DummyConfigRepository


# ------------------------------------------------------------------
# severity_for — static map spot checks
# ------------------------------------------------------------------


def test_critical_labels_map_to_critical() -> None:
    for label in ("MY_NUMBER", "PASSPORT", "API_KEY", "CREDIT_CARD",
                  "BANK_ACCOUNT", "SECRET", "DB_CONNECTION",
                  "DRIVERS_LICENSE"):
        assert severity_for(label) == "critical", label


def test_high_labels_map_to_high() -> None:
    for label in ("PERSON", "PROPER_NOUN_PERSON", "EMAIL_ADDRESS",
                  "PHONE_NUMBER", "ADDRESS", "PATIENT_ID"):
        assert severity_for(label) == "high", label


def test_medium_labels_map_to_medium() -> None:
    for label in ("LOCATION", "PROPER_NOUN_LOCATION", "COMPANY",
                  "EMPLOYEE_ID", "MEMBER_ID", "CUSTOMER_ID",
                  "CONTRACT_NUMBER", "INVOICE_NUMBER", "URL",
                  "IP_ADDRESS", "MONETARY_AMOUNT"):
        assert severity_for(label) == "medium", label


def test_low_labels_map_to_low() -> None:
    for label in ("AGE", "GENDER", "DATE", "BLOOD_TYPE",
                  "POSTAL_CODE", "SKU", "KATAKANA_NAME"):
        assert severity_for(label) == "low", label


def test_unknown_label_falls_back_to_low() -> None:
    assert severity_for("NOT_A_REAL_LABEL") == "low"
    assert severity_for("") == "low"


def test_severity_order_covers_every_value_in_map() -> None:
    """Every severity the static map uses must appear in the ordered
    tuple — otherwise the UI iterates over tiers it knows nothing
    about and the max_severity / worstSeverity helpers silently miss
    values."""
    values = set(LABEL_TO_SEVERITY.values()) | {"low"}  # + fallback
    for v in values:
        assert v in SEVERITY_ORDER, v


def test_severity_order_runs_highest_to_lowest() -> None:
    """Callers rely on ``SEVERITY_ORDER[0]`` being the worst tier."""
    assert SEVERITY_ORDER[0] == "critical"
    assert SEVERITY_ORDER[-1] == "low"


# ------------------------------------------------------------------
# max_severity helper
# ------------------------------------------------------------------


def test_max_severity_picks_worst() -> None:
    assert max_severity(["low", "medium", "high"]) == "high"
    assert max_severity(["medium", "critical", "low"]) == "critical"
    assert max_severity(["low"]) == "low"
    assert max_severity([]) == "low"
    # Unknown values are treated as "low" so they cannot accidentally
    # outrank a real tier.
    assert max_severity(["bogus", "high"]) == "high"


# ------------------------------------------------------------------
# Integration — DetectionResult.severity is populated
# ------------------------------------------------------------------


def test_detection_result_carries_severity_field() -> None:
    """When MaskingService sanitizes text containing an email, the
    returned DetectionResult must carry ``severity="high"`` so the
    browser extension can colour-code the row without a second
    lookup on its end."""
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(text="contact: user@example.com")

    result = service.sanitize_text(request)

    email = next(
        (d for d in result.detections if d.entity_type == "EMAIL_ADDRESS"),
        None,
    )
    assert email is not None, "expected an EMAIL_ADDRESS detection"
    assert email.severity == "high"


def test_aggregated_entity_carries_severity_field() -> None:
    """End-to-end: aggregate_detections() pulls the severity off the
    label via severity_for(), so the sidebar never has to consult the
    map itself."""
    service = MaskingService(DummyConfigRepository(), DummyAuditRepository())
    request = TextSanitizeRequest(
        text="my email is user@example.com and my phone is 555-123-4567"
    )

    result = service.sanitize_text(request)
    aggregated = aggregate_detections(result.detections)

    by_label = {entry.label: entry for entry in aggregated}
    assert "EMAIL_ADDRESS" in by_label, by_label.keys()
    assert by_label["EMAIL_ADDRESS"].severity == "high"


def test_api_key_preset_yields_critical_severity() -> None:
    """Preset-regex detections must also flow through the severity
    populator — verifies the code path that builds DetectionResult
    from RegexAnalyzer matches applies severity_for()."""
    config = RuntimeConfig(
        filter_enabled=True,
        enable_preset_patterns=True,
    )
    service = MaskingService(DummyConfigRepository(config), DummyAuditRepository())
    request = TextSanitizeRequest(
        text="API key sk-proj-ABC123XYZ456DEF789GHI0"
    )

    result = service.sanitize_text(request)

    api = next(
        (d for d in result.detections if d.entity_type == "API_KEY"),
        None,
    )
    assert api is not None, f"expected API_KEY detection, got {result.detections}"
    assert api.severity == "critical"
