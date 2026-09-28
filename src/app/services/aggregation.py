"""Aggregate per-occurrence detections into one entry per unique surface.

The analyzer pipeline emits one :class:`DetectionResult` per occurrence,
which matches the existing extension-facing contract. The UI sidebar
(Milestone 8 Wave A) wants the opposite shape: one row per unique
surface text with an occurrence count and the list of positions, so the
user can tick ``田中太郎 (2件)`` once and have both occurrences masked.

This module is the bridge. The existing ``/v1/extension/sanitize``
endpoint still returns the per-occurrence shape verbatim; the new
``/v1/extension/sanitize/aggregated`` endpoint calls
:func:`aggregate_detections` to build the aggregated view from the
exact same :class:`DetectionResult` list.

Design decisions
~~~~~~~~~~~~~~~~

* **Aggregation key = surface text only.** Two detections with the
  same ``text`` but different ``entity_type`` (e.g. Presidio's
  ``LOCATION`` vs Sudachi's ``PROPER_NOUN_LOCATION`` firing on the
  same span) collapse into one row. The UI only cares about what the
  string is; the big category resolved from ``entity_type`` via
  :mod:`app.services.category_map` is carried through for display but
  is not part of the key.
* **First occurrence wins the label.** When multiple labels fire on
  the same surface, the one with the lowest ``start`` is kept so the
  ordering is deterministic and does not depend on analyzer iteration
  order. We break further ties by preferring a label whose category
  is not ``"OTHER"`` so the UI's grouping stays useful.
* **Masked flag = at least one occurrence was masked.** A surface is
  considered masked for display purposes when any of its occurrences
  had ``action="masked"``; ``action="allowed"`` on its own still
  reports ``masked=False`` so the UI can show "detected but allowed".
  The force-mask keyword trigger layered on top overrides this to
  ``True``.
"""
from __future__ import annotations

from typing import Iterable

from app.models.schemas import AggregatedEntity, DetectionResult
from app.services.category_map import category_for
from app.services.classification import classification_for
from app.services.severity import (
    severity_for,
    severity_for_surface,
    is_false_positive_person,
)


def aggregate_detections(
    detections: Iterable[DetectionResult],
) -> list[AggregatedEntity]:
    """Collapse detections that share the same surface text.

    Parameters
    ----------
    detections:
        Iterable of per-occurrence detections emitted by
        ``MaskingService.sanitize_text``. The caller is expected to
        feed the ``SanitizeResponse.detections`` list in verbatim.

    Returns
    -------
    list[AggregatedEntity]
        One entry per unique surface, ordered by the first occurrence
        of that surface in the original text. Stable ordering matters
        for the UI — the sidebar renders rows in this order and a
        non-deterministic order would cause the list to flicker on
        re-render.
    """
    # Preserve first-occurrence order. ``dict`` retains insertion
    # order on Python 3.7+, which is what ``app`` targets, so we
    # lean on that rather than maintaining a separate ordering list.
    order: list[str] = []
    by_value: dict[str, list[DetectionResult]] = {}
    for det in detections:
        if det.text not in by_value:
            order.append(det.text)
            by_value[det.text] = []
        by_value[det.text].append(det)

    # Pre-compute the number assigned to each (label, value) pair so
    # the ``placeholder`` embedded in each AggregatedEntity matches
    # the one ``MaskingService._tag_mask`` bakes into
    # ``sanitized_text``. Ordering is left-to-right by first-occurrence
    # start, per label — same invariant as _tag_mask's pass-1 so the
    # UI rows and the server-rendered string stay in lockstep.
    label_counters: dict[str, int] = {}
    numbering: dict[tuple[str, str], int] = {}
    for det in sorted(
        (d for hits in by_value.values() for d in hits),
        key=lambda d: (d.start, d.end),
    ):
        key = (det.entity_type, det.text)
        if key not in numbering:
            label_counters[det.entity_type] = label_counters.get(det.entity_type, 0) + 1
            numbering[key] = label_counters[det.entity_type]

    aggregated: list[AggregatedEntity] = []
    for value in order:
        hits = by_value[value]

        # First-occurrence precedence for the label: sort by start so
        # the winning label is deterministic. When two hits share a
        # start (unusual but possible for overlapping analyzers),
        # prefer a label whose big-category is NOT ``OTHER`` — that
        # avoids a catch-all analyzer ever displacing a well-bucketed
        # one from Presidio / Sudachi / presets.
        best = min(
            hits,
            key=lambda h: (
                h.start,
                0 if category_for(h.entity_type) != "OTHER" else 1,
            ),
        )
        label = best.entity_type
        category = category_for(label)

        # Dedupe by (start, end): two analyzers (e.g. Presidio +
        # regex-preset) can flag the exact same span with the same
        # entity_type, which the overlap resolver keeps intact on
        # purpose (``_resolve_overlaps`` does not drop identical spans
        # — see its docstring). For aggregation those are the SAME
        # occurrence, not two, so we collapse them here.  The first
        # hit wins when two duplicates disagree on ``action`` —
        # ``masked`` below is computed against the raw hit list so
        # allow-list state is still captured correctly.
        seen_spans: set[tuple[int, int]] = set()
        unique_positions: list[tuple[int, int]] = []
        for hit in hits:
            span = (hit.start, hit.end)
            if span in seen_spans:
                continue
            seen_spans.add(span)
            unique_positions.append(span)
        unique_positions.sort(key=lambda pos: pos[0])

        # The surface is considered masked for display purposes when
        # at least one occurrence had ``action == "masked"``. Pure
        # ``allowed`` detections (every hit had the allow-list action)
        # surface as masked=False so the UI can show a "detected but
        # allowed" state without a forced mask.
        masked = any(hit.action == "masked" for hit in hits)

        number = numbering.get((label, value), 1)
        placeholder = f"<{label}_{number}>"
        # Drop obvious PERSON false positives (polite Japanese phrases
        # mis-tagged by Sudachi/Presidio).
        if label in ("PERSON", "PROPER_NOUN_PERSON") and is_false_positive_person(value):
            continue
        classification = classification_for(label)
        severity = severity_for_surface(label, value)

        aggregated.append(
            AggregatedEntity(
                value=value,
                label=label,
                category=category,
                count=len(unique_positions),
                positions=unique_positions,
                masked=masked,
                placeholder=placeholder,
                classification=classification,
                severity=severity,
            )
        )
    return aggregated
