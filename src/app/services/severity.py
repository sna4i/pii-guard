"""Risk-tier classification for entity labels.

Orthogonal to :mod:`category_map` (display bucket) and
:mod:`classification` (linguistic tier). This module answers
"how bad is it if THIS surface leaks?" so the UI can color-code
rows and guard the highest-risk ones behind a long-press gesture.

Four tiers, highest first:

``critical``
    Identity theft / financial compromise / production credentials.
    MY_NUMBER, PASSPORT, DRIVERS_LICENSE, CREDIT_CARD, BANK_ACCOUNT,
    API_KEY, SECRET, DB_CONNECTION.

``high``
    Directly personally identifying. PERSON / PROPER_NOUN_PERSON,
    EMAIL_ADDRESS, PHONE_NUMBER, ADDRESS (full address),
    PATIENT_ID (medical record).

``medium``
    Structured organizational or monetary data that is sensitive
    but not a direct identity vector. LOCATION / COMPANY / org
    names, EMPLOYEE_ID / MEMBER_ID / CUSTOMER_ID / CONTRACT_NUMBER /
    INVOICE_NUMBER / PURCHASE_ORDER / INTERNAL_ID, MONETARY_AMOUNT /
    ANNUAL_INCOME, URL, IP_ADDRESS, PATENT_NUMBER, ASSET_NUMBER,
    LICENSE_NUMBER, DEPARTMENT, PROPER_NOUN_LOCATION /
    PROPER_NOUN_ORG.

``low``
    Broad attributes, partial identifiers, noisy heuristics.
    AGE, GENDER, DATE, BLOOD_TYPE, POSTAL_CODE, SKU,
    KATAKANA_NAME (has high false-positive rate), any label
    not otherwise mapped.
"""
from __future__ import annotations

from typing import Final

Severity = str  # Literal["critical", "high", "medium", "low"]

#: Ordered highest → lowest. The sidebar renders categories in this
#: order when it groups by severity, and ``KNOWN_`` sets in tests can
#: iterate over it to check membership.
SEVERITY_ORDER: Final[tuple[str, ...]] = ("critical", "high", "medium", "low")

#: Label → severity map. Updating entries here is purely additive so
#: adding a new analyzer label is a one-line change: add to this map,
#: and the sidebar automatically picks up the right colour + the
#: long-press guard kicks in for ``critical`` tier.
LABEL_TO_SEVERITY: Final[dict[str, str]] = {
    # ---- critical -------------------------------------------------------
    # Identity theft vectors + production credentials. Leaking any of
    # these lets an attacker impersonate the user or their systems.
    "MY_NUMBER": "critical",
    "PASSPORT": "critical",
    "DRIVERS_LICENSE": "critical",
    "CREDIT_CARD": "critical",
    "BANK_ACCOUNT": "critical",
    "API_KEY": "critical",
    "SECRET": "critical",
    "DB_CONNECTION": "critical",
    # ---- high -----------------------------------------------------------
    # Direct personally-identifying data.
    "PERSON": "high",
    "PROPER_NOUN_PERSON": "high",
    "JP_SURNAME": "high",
    "WESTERN_FIRST_NAME": "high",
    "EMAIL_ADDRESS": "high",
    "PHONE_NUMBER": "high",
    "ADDRESS": "high",
    "PATIENT_ID": "high",
    # ---- medium ---------------------------------------------------------
    # Organizational / monetary / structured-identifier data: sensitive
    # but not a direct identity vector.
    "LOCATION": "medium",
    "PROPER_NOUN_LOCATION": "medium",
    "PREFECTURE_CITY": "medium",
    "JP_PREFECTURE_DICT": "medium",
    "JP_DESIGNATED_CITY": "medium",
    "WORLD_COUNTRY": "medium",
    "PROPER_NOUN_ORG": "medium",
    "ORGANIZATION": "medium",
    "COMPANY": "medium",
    "EMPLOYEE_ID": "medium",
    "MEMBER_ID": "medium",
    "CUSTOMER_ID": "medium",
    "CONTRACT_NUMBER": "medium",
    "PURCHASE_ORDER": "medium",
    "INVOICE_NUMBER": "medium",
    "INTERNAL_ID": "medium",
    "DEPARTMENT": "medium",
    "ASSET_NUMBER": "medium",
    "LICENSE_NUMBER": "medium",
    "PATENT_NUMBER": "medium",
    "MONETARY_AMOUNT": "medium",
    "ANNUAL_INCOME": "medium",
    "URL": "medium",
    "IP_ADDRESS": "medium",
    # ---- low ------------------------------------------------------------
    # Broad demographic attributes, noisy katakana heuristics, partial
    # identifiers. Useful context but low leak-cost on their own.
    "AGE": "low",
    "GENDER": "low",
    "DATE": "low",
    "BLOOD_TYPE": "low",
    "POSTAL_CODE": "low",
    "SKU": "low",
    "KATAKANA_NAME": "low",
}


def severity_for(label: str) -> str:
    """Return the risk tier of a label, ``"low"`` when unknown.

    Unknown labels default to ``"low"`` rather than raising so adding
    a new analyzer is purely additive: the UI still renders the row
    (in the least-alarming colour) until someone adds an explicit
    entry to :data:`LABEL_TO_SEVERITY`.
    """
    return LABEL_TO_SEVERITY.get(label, "low")


# Surface patterns that escalate a detection to ``critical`` regardless
# of the label-level severity. Used by :func:`severity_for_surface`.
import re as _re

_FORMAL_COMPANY_RE = _re.compile(r"(株式会社|㈱|有限会社|㈲|合同会社|合資会社)")
_EMAIL_WITH_DOMAIN_RE = _re.compile(r"[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}")

# Polite / business / verb-ending fragments that frequently get
# mis-tagged as PERSON by Sudachi/Presidio. When a surface contains
# any of these AND its length is implausibly long for a real name
# (>6 chars), the detection is considered a false positive.
_PERSON_FP_TOKENS = (
    "ます", "ません", "ください", "いたします", "致します", "願い",
    "注意", "確認", "ご了承", "申し訳", "ありがと", "よろしく",
    "とおり", "ように", "ような", "については", "ところ", "ため",
    "こと", "もの", "それ", "これ", "あれ",
)


def is_false_positive_person(surface: str) -> bool:
    """True when a PERSON-labeled surface is almost certainly a phrase.

    Heuristic only — meant to suppress Sudachi/Presidio noise where
    polite Japanese expressions (ご注意くださいますよう…) get tagged
    as proper-noun-person. A surface qualifies as FP when:

    * length > 6 characters (real Japanese names are 2–6 chars), AND
    * it contains at least one of the polite/verb-ending tokens
      enumerated in :data:`_PERSON_FP_TOKENS`.

    Short surfaces and surfaces with no polite markers are left
    alone (they may still be real names).
    """
    if not surface or len(surface) <= 6:
        return False
    return any(tok in surface for tok in _PERSON_FP_TOKENS)


def severity_for_surface(label: str, surface: str) -> str:
    """Return the risk tier for a specific detected surface.

    Augments :func:`severity_for` with surface-aware escalation:

    * ``PERSON`` / ``PROPER_NOUN_PERSON`` are always ``critical``
      (any name leak is treated as identity-level risk).
    * ``ORGANIZATION`` / ``COMPANY`` / ``PROPER_NOUN_ORG`` are
      escalated to ``critical`` when the surface contains a formal
      Japanese company suffix (株式会社, ㈱, 有限会社, etc.).
    * ``EMAIL_ADDRESS`` is escalated to ``critical`` when the
      surface is a full email with a routable domain (RFC-ish
      ``user@host.tld`` shape).
    """
    base = severity_for(label)
    if label in ("PERSON", "PROPER_NOUN_PERSON"):
        return "critical"
    if label in ("ORGANIZATION", "COMPANY", "PROPER_NOUN_ORG"):
        if surface and _FORMAL_COMPANY_RE.search(surface):
            return "critical"
    if label == "EMAIL_ADDRESS":
        if surface and _EMAIL_WITH_DOMAIN_RE.search(surface):
            return "critical"
    return base


def max_severity(severities: list[str]) -> str:
    """Return the highest-risk tier in a list.

    Used by the sidebar to pick a single severity for a category
    header when its rows span multiple tiers — we show the worst
    offender's colour so a ``CREDENTIAL`` category with one API_KEY
    and several URLs is still flagged red.
    """
    order = {sev: i for i, sev in enumerate(SEVERITY_ORDER)}
    best = "low"
    best_rank = order["low"]
    for sev in severities:
        rank = order.get(sev, order["low"])
        if rank < best_rank:
            best = sev
            best_rank = rank
    return best
