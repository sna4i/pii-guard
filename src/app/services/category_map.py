"""Analyzer entity label → display-layer big category map.

The analyzers produce fine-grained entity labels (e.g.
``PROPER_NOUN_PERSON``, ``EMAIL_ADDRESS``, ``MONETARY_AMOUNT``). The
browser-extension UI groups those into a small handful of big
categories so the sidebar can show one toggle per category instead of
one per label. This module is the single source of truth for that
mapping.

Add a new entry here whenever a new analyzer label is introduced —
especially when extending :mod:`app.services.analyzers.presets`. An
unmapped label falls back to ``"OTHER"`` at runtime rather than
raising, so the aggregation pipeline never blows up on a new label; but
leaving the fallback in place means the UI cannot bucket it with
related categories, so prefer adding the entry over relying on the
fallback.
"""
from __future__ import annotations

from typing import Final

#: Seven big categories that the UI groups detections by. The keys are
#: analyzer-level entity types (``"PROPER_NOUN_PERSON"``, ``"EMAIL_ADDRESS"``,
#: etc.); values are the display-level category. Add new labels here
#: when a new analyzer category is introduced.
LABEL_TO_CATEGORY: Final[dict[str, str]] = {
    # PERSON
    "PERSON": "PERSON",
    "PROPER_NOUN_PERSON": "PERSON",
    "KATAKANA_NAME": "PERSON",
    "JP_SURNAME": "PERSON",
    "WESTERN_FIRST_NAME": "PERSON",
    # LOCATION
    "LOCATION": "LOCATION",
    "PROPER_NOUN_LOCATION": "LOCATION",
    "ADDRESS": "LOCATION",
    "PREFECTURE_CITY": "LOCATION",
    "JP_PREFECTURE_DICT": "LOCATION",
    "JP_DESIGNATED_CITY": "LOCATION",
    "WORLD_COUNTRY": "LOCATION",
    # ORGANIZATION
    "ORGANIZATION": "ORGANIZATION",
    "PROPER_NOUN_ORG": "ORGANIZATION",
    "COMPANY": "ORGANIZATION",
    "DEPARTMENT": "ORGANIZATION",
    # CONTACT
    "EMAIL_ADDRESS": "CONTACT",
    "PHONE_NUMBER": "CONTACT",
    "URL": "CONTACT",
    "IP_ADDRESS": "CONTACT",
    "POSTAL_CODE": "CONTACT",
    # FINANCIAL
    "CREDIT_CARD": "FINANCIAL",
    "BANK_ACCOUNT": "FINANCIAL",
    "MONETARY_AMOUNT": "FINANCIAL",
    "ANNUAL_INCOME": "FINANCIAL",
    "INVOICE_NUMBER": "FINANCIAL",
    # CREDENTIAL
    "API_KEY": "CREDENTIAL",
    "SECRET": "CREDENTIAL",
    "MY_NUMBER": "CREDENTIAL",
    "DRIVERS_LICENSE": "CREDENTIAL",
    "PASSPORT": "CREDENTIAL",
    "DB_CONNECTION": "CREDENTIAL",
    "LICENSE_NUMBER": "CREDENTIAL",
    # IDENTITY — everyday identifiers that are not credentials per se
    "AGE": "IDENTITY",
    "GENDER": "IDENTITY",
    "DATE": "IDENTITY",
    "BLOOD_TYPE": "IDENTITY",
    # INTERNAL_ID fallback bucket for codes like PRJ-001, EMP-04521 etc.
    "INTERNAL_ID": "INTERNAL_ID",
    "EMPLOYEE_ID": "INTERNAL_ID",
    "CONTRACT_NUMBER": "INTERNAL_ID",
    "PURCHASE_ORDER": "INTERNAL_ID",
    "CUSTOMER_ID": "INTERNAL_ID",
    "PATIENT_ID": "INTERNAL_ID",
    "MEMBER_ID": "INTERNAL_ID",
    "SKU": "INTERNAL_ID",
    "PATENT_NUMBER": "INTERNAL_ID",
    "ASSET_NUMBER": "INTERNAL_ID",
    # PHONE_NUMBER_JP preset emits ``PHONE_NUMBER`` entity_type via the
    # regex analyzer, so the mapping above for ``PHONE_NUMBER`` covers
    # both Presidio's US-formatted phones and the Japan-specific preset.
}


def category_for(label: str) -> str:
    """Return the big category for an analyzer-level ``label``.

    Unmapped labels fall back to ``"OTHER"`` so the aggregation
    pipeline never blows up on a label the map has not heard of. That
    makes extending the analyzer set a purely-additive operation from
    the UI's perspective, at the cost of new labels defaulting to a
    catch-all bucket until someone wires them up here.
    """
    return LABEL_TO_CATEGORY.get(label, "OTHER")
