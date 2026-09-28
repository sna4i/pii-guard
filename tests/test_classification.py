"""Tests for the linguistic-tier classification layer.

Covers:
- The static ``classification_for`` mapping for every label we care
  about (proper_noun / contact / identifier / credential / attribute).
- ``RuntimeConfig.enabled_pii_classes`` filter: when a class is
  disabled, detections in that class are DROPPED from both the masked
  text and the detections list.
- The aggregated endpoint surfaces the ``classification`` field on
  each ``AggregatedEntity`` so the sidebar can group / filter by it.
"""
from __future__ import annotations

from app.models.schemas import RuntimeConfig, TextSanitizeRequest
from app.services.aggregation import aggregate_detections
from app.services.classification import (
    KNOWN_CLASSIFICATIONS,
    classification_for,
)
from app.services.masking_service import MaskingService

from conftest import DummyAuditRepository, DummyConfigRepository


# ------------------------------------------------------------------
# classification_for — static map spot checks
# ------------------------------------------------------------------

def test_proper_noun_labels_map_to_proper_noun() -> None:
    for label in ("PERSON", "PROPER_NOUN_PERSON", "KATAKANA_NAME",
                  "LOCATION", "PROPER_NOUN_LOCATION", "COMPANY"):
        assert classification_for(label) == "proper_noun", label


def test_contact_labels_map_to_contact() -> None:
    for label in ("EMAIL_ADDRESS", "PHONE_NUMBER", "URL",
                  "IP_ADDRESS", "ADDRESS", "POSTAL_CODE"):
        assert classification_for(label) == "contact", label


def test_identifier_labels_map_to_identifier() -> None:
    for label in ("EMPLOYEE_ID", "MEMBER_ID", "CUSTOMER_ID",
                  "CONTRACT_NUMBER", "INVOICE_NUMBER", "PATIENT_ID",
                  "INTERNAL_ID", "DEPARTMENT", "SKU",
                  "ASSET_NUMBER", "DB_CONNECTION"):
        assert classification_for(label) == "identifier", label


def test_credential_labels_map_to_credential() -> None:
    for label in ("API_KEY", "SECRET", "MY_NUMBER",
                  "DRIVERS_LICENSE", "PASSPORT", "CREDIT_CARD",
                  "BANK_ACCOUNT"):
        assert classification_for(label) == "credential", label


def test_attribute_labels_map_to_attribute() -> None:
    for label in ("AGE", "GENDER", "DATE", "BLOOD_TYPE",
                  "MONETARY_AMOUNT", "ANNUAL_INCOME"):
        assert classification_for(label) == "attribute", label


def test_unknown_label_falls_back_to_other() -> None:
    assert classification_for("NOT_A_REAL_LABEL") == "other"


def test_every_known_class_is_covered() -> None:
    # Sanity — ensure the ordered tuple and the map agree on the set
    # of classes we consider valid. Keeps drift from creeping in.
    classes_in_map = set()
    from app.services.classification import LABEL_TO_CLASSIFICATION

    for c in LABEL_TO_CLASSIFICATION.values():
        classes_in_map.add(c)
    classes_in_map.add("other")  # fallback
    for c in classes_in_map:
        assert c in KNOWN_CLASSIFICATIONS, c


# ------------------------------------------------------------------
# RuntimeConfig.enabled_pii_classes — filter integration
# ------------------------------------------------------------------

def test_default_config_keeps_all_classes_enabled() -> None:
    """Backward compat: the default factory enables every class so
    existing deployments see zero behaviour change."""
    cfg = RuntimeConfig(filter_enabled=True)
    for c in KNOWN_CLASSIFICATIONS:
        assert c in cfg.enabled_pii_classes, c


def test_enabled_pii_classes_filters_email_when_contact_disabled() -> None:
    """Disabling ``contact`` must drop ``EMAIL_ADDRESS`` detections
    entirely — they should not appear in sanitized_text nor in
    result.detections."""
    cfg = RuntimeConfig(
        filter_enabled=True,
        enable_preset_patterns=True,
        enabled_pii_classes=[
            "proper_noun",
            # "contact" deliberately omitted
            "identifier",
            "credential",
            "attribute",
            "other",
        ],
    )
    service = MaskingService(DummyConfigRepository(cfg), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="Contact us at foo@example.com for details")
    )

    assert "foo@example.com" in result.sanitized_text, (
        "EMAIL_ADDRESS is in the 'contact' class; disabling that class "
        "should leave the email verbatim in the output"
    )
    assert not any(
        d.entity_type == "EMAIL_ADDRESS" for d in result.detections
    ), "contact-class detections must be dropped from the audit list"


def test_enabled_pii_classes_only_proper_noun() -> None:
    """User says 'I only care about 固有名詞': everything else —
    employee IDs, emails, API keys — passes through untouched."""
    cfg = RuntimeConfig(
        filter_enabled=True,
        enable_preset_patterns=True,
        enabled_pii_classes=["proper_noun"],
        regex_patterns=[["EMPLOYEE_ID", r"EMP-\d{5}"]],
        analyzers_by_language={"en": ["presidio", "regex"]},
    )
    service = MaskingService(DummyConfigRepository(cfg), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(text="employee EMP-12345 mailed foo@example.com")
    )

    # Both identifier and contact labels must pass through.
    assert "EMP-12345" in result.sanitized_text
    assert "foo@example.com" in result.sanitized_text
    assert not any(
        d.entity_type in ("EMPLOYEE_ID", "INTERNAL_ID", "EMAIL_ADDRESS")
        for d in result.detections
    )


def test_aggregated_entity_carries_classification_field() -> None:
    """The sidebar needs each row tagged with its linguistic class so
    the user can mass-toggle by class without knowing the label-level
    details."""
    # Build a SanitizeResponse-style detection list manually via the
    # service so the aggregation helper sees realistic input.
    cfg = RuntimeConfig(filter_enabled=True, enable_preset_patterns=True)
    service = MaskingService(DummyConfigRepository(cfg), DummyAuditRepository())
    result = service.sanitize_text(
        TextSanitizeRequest(
            text="foo@example.com の年齢は35歳、血液型 A型"
        )
    )

    aggregated = aggregate_detections(result.detections)
    by_label = {a.label: a for a in aggregated}

    # Every aggregated entity has a non-empty classification.
    assert all(a.classification for a in aggregated)
    # Spot checks against the static map — these should round-trip.
    if "EMAIL_ADDRESS" in by_label:
        assert by_label["EMAIL_ADDRESS"].classification == "contact"
    if "AGE" in by_label:
        assert by_label["AGE"].classification == "attribute"
    if "BLOOD_TYPE" in by_label:
        assert by_label["BLOOD_TYPE"].classification == "attribute"
