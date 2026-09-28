"""Linguistic-tier classification for entity labels.

Background
~~~~~~~~~~
The user observed that several entity labels we currently mask —
``ADDRESS``, ``EMAIL_ADDRESS``, ``MEMBER_ID``, project codes — are
**not 固有名詞** (proper nouns) in the linguistic sense. They are
structured identifiers or contact methods that happen to be PII. A
user who only wants to mask "真の固有名詞" (actual proper nouns like
``田中太郎`` / ``株式会社マスクテスト``) had no way to express that
without listing every structured-identifier label in
``allow_entity_types``.

This module introduces a second-axis classification — orthogonal to
the display ``category`` in :mod:`app.services.category_map` — that
groups labels by their **linguistic nature** rather than by display
intent. The runtime config exposes a ``enabled_pii_classes`` list so
operators can toggle whole classes on or off.

Classes
~~~~~~~
``proper_noun``
    Person / place / organization names recognised as 固有名詞 by a
    morphological analyzer. Includes Sudachi-confirmed
    ``PROPER_NOUN_*`` labels, Presidio ``PERSON`` / ``LOCATION`` /
    ``ORGANIZATION``, and ``COMPANY`` matches. ``KATAKANA_NAME`` lands
    here provisionally; ``MaskingService`` can Sudachi-POS-validate it
    and demote confirmed common nouns (brand / product names) to
    ``other`` so brand katakana does not inflate the proper-noun class.

``contact``
    Means of reaching a person: email addresses, phone numbers, URLs,
    postal addresses, IP addresses. These are **not** 固有名詞 but are
    sensitive — typically enabled by default.

``identifier``
    Structured organizational codes: employee / customer / patient /
    member IDs, contract numbers, invoice numbers, project codes, SKUs,
    asset numbers, department codes, patent numbers, DB connection
    strings. Frequently domain-specific; operators in non-commercial
    settings may want to disable this whole class.

``credential``
    Secrets in the security sense: API keys, passwords, MY_NUMBER,
    driver licenses, passports, credit cards, bank accounts. These
    should almost always stay enabled; the toggle exists mostly for
    completeness and for local-only test environments.

``attribute``
    Demographic / quantitative attributes that describe a person but
    are not names per se: age, gender, date of birth, blood type,
    annual income, monetary amounts. These vary in sensitivity by
    context.

Anything not in ``LABEL_TO_CLASSIFICATION`` falls back to ``"other"``.
"""
from __future__ import annotations

from typing import Final

#: Five-way linguistic tier. See module docstring for semantics.
PiiClassification = str  # Literal["proper_noun","contact","identifier","credential","attribute","other"]

#: All classes the system knows about, ordered from most to least
#: likely to be "true PII" in a strict privacy sense. The sidebar
#: renders categories in this order when it groups by classification.
KNOWN_CLASSIFICATIONS: Final[tuple[str, ...]] = (
    "proper_noun",
    "contact",
    "identifier",
    "credential",
    "attribute",
    "other",
)

#: Label → classification map. Presidio labels, Sudachi labels and
#: regex-preset labels all map through this one table so the filter
#: in ``MaskingService`` treats them uniformly.
LABEL_TO_CLASSIFICATION: Final[dict[str, str]] = {
    # ---- proper_noun ----------------------------------------------------
    "PERSON": "proper_noun",
    "PROPER_NOUN_PERSON": "proper_noun",
    "KATAKANA_NAME": "proper_noun",  # Sudachi validation may demote
    "JP_SURNAME": "proper_noun",
    "WESTERN_FIRST_NAME": "proper_noun",
    "LOCATION": "proper_noun",
    "PROPER_NOUN_LOCATION": "proper_noun",
    "ORGANIZATION": "proper_noun",
    "PROPER_NOUN_ORG": "proper_noun",
    "COMPANY": "proper_noun",
    # ---- contact --------------------------------------------------------
    "EMAIL_ADDRESS": "contact",
    "PHONE_NUMBER": "contact",
    "URL": "contact",
    "IP_ADDRESS": "contact",
    "ADDRESS": "contact",          # a full street/postal address
    "PREFECTURE_CITY": "contact",  # 都道府県+市区町村単体 (street なし)
    "JP_PREFECTURE_DICT": "contact",  # 47 都道府県の単体検出 (dictionary fallback)
    "JP_DESIGNATED_CITY": "contact",  # 政令指定都市 20 の単体検出
    "WORLD_COUNTRY": "contact",       # 主要国名 (JP + EN)
    "POSTAL_CODE": "contact",
    # ---- identifier -----------------------------------------------------
    "EMPLOYEE_ID": "identifier",
    "MEMBER_ID": "identifier",
    "CUSTOMER_ID": "identifier",
    "PATIENT_ID": "identifier",
    "CONTRACT_NUMBER": "identifier",
    "PURCHASE_ORDER": "identifier",
    "INVOICE_NUMBER": "identifier",
    "INTERNAL_ID": "identifier",
    "DEPARTMENT": "identifier",
    "SKU": "identifier",
    "ASSET_NUMBER": "identifier",
    "LICENSE_NUMBER": "identifier",
    "PATENT_NUMBER": "identifier",
    "DB_CONNECTION": "identifier",
    # ---- credential -----------------------------------------------------
    "API_KEY": "credential",
    "SECRET": "credential",
    "MY_NUMBER": "credential",
    "DRIVERS_LICENSE": "credential",
    "PASSPORT": "credential",
    "CREDIT_CARD": "credential",
    "BANK_ACCOUNT": "credential",
    # ---- attribute ------------------------------------------------------
    "AGE": "attribute",
    "GENDER": "attribute",
    "DATE": "attribute",
    "BLOOD_TYPE": "attribute",
    "MONETARY_AMOUNT": "attribute",
    "ANNUAL_INCOME": "attribute",
}


def classification_for(label: str) -> str:
    """Return the linguistic class of a label, ``"other"`` when unknown."""
    return LABEL_TO_CLASSIFICATION.get(label, "other")


def default_enabled_classes() -> list[str]:
    """Factory for :class:`RuntimeConfig.enabled_pii_classes`.

    All classes enabled by default so existing deployments see no
    behaviour change. Users opt out by removing classes from the
    returned list via the ``/admin/config`` PUT.
    """
    return list(KNOWN_CLASSIFICATIONS)
