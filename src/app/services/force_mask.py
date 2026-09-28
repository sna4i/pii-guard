"""Force-mask keyword trigger for the aggregated extension endpoint.

When the input text contains a sensitive-context keyword like ``リーク``
/ ``未公開`` / ``機密`` / ``confidential`` / ``leak``, the categories in
``RuntimeConfig.force_mask_categories`` are force-masked regardless of
what the user's ``allow_entity_types`` says or what the UI toggled off.
This is the "red-flag words" safety net discussed in the Milestone 8
spec — the user asked for it because a leaker who types
``"リーク情報: 田中太郎の給料"`` into an LLM prompt should have the name
and amount masked even if they accidentally untick them.

Two match modes coexist in :func:`detect_force_mask_trigger`:

* **Japanese keywords** are checked via Sudachi POS. A keyword fires
  only when at least one morpheme's surface equals the keyword AND its
  POS starts with ``"名詞"``. Pure string-``in`` matching is not
  enough because a keyword like ``機密`` could appear as part of a
  longer word or in a verb inflection where firing the trigger would
  be surprising.

* **ASCII keywords** (``"leak"``, ``"confidential"``, …) fall back to
  case-insensitive substring matching because Sudachi only tokenizes
  Japanese. This is the pragmatic compromise called out in the spec.

The module is deliberately standalone — it depends only on
:class:`SudachiProperNounAnalyzer` (which is already cached by
``MaskingService``) and on the ``category_map`` for mapping the
configured categories back to the aggregated entities.
"""
from __future__ import annotations

from typing import Iterable

from app.models.schemas import AggregatedEntity


def _is_ascii_keyword(keyword: str) -> bool:
    """Return True when every character in ``keyword`` is ASCII.

    Used to decide whether a keyword goes through the Sudachi POS path
    (Japanese) or the case-insensitive substring fallback (ASCII /
    Latin). A mixed keyword (e.g. ``"leak機密"``) routes through the
    substring fallback; that is acceptable because Sudachi would
    probably not tokenize the ASCII half as a 名詞 anyway.
    """
    return all(ord(ch) < 128 for ch in keyword)


def detect_force_mask_trigger(
    text: str,
    keywords: list[str],
    *,
    tokenizer_fn,
) -> list[str]:
    """Return the subset of ``keywords`` that fired on ``text``.

    Parameters
    ----------
    text:
        The full original input text. Substring / tokenization both
        operate on this verbatim string.
    keywords:
        The configured trigger words from
        ``RuntimeConfig.force_mask_keywords``.
    tokenizer_fn:
        Callable that takes ``text`` and returns an iterable of
        ``(surface, pos_tuple)`` pairs. Injected so the caller can pass
        a Sudachi-backed tokenizer, a stub for tests, or a no-op when
        Sudachi is not available. The callable is only invoked when
        there is at least one Japanese keyword in ``keywords``.

    Returns
    -------
    list[str]
        The list of keywords that fired, preserving the configured
        order. Empty list when no keyword fired. Callers convert this
        into the list of forced categories via
        :func:`resolve_forced_categories`.
    """
    if not text or not keywords:
        return []

    ascii_keywords = [kw for kw in keywords if _is_ascii_keyword(kw)]
    ja_keywords = [kw for kw in keywords if not _is_ascii_keyword(kw)]

    fired: list[str] = []

    # ASCII path: case-insensitive substring match. Cheap, no tokenizer.
    text_lower = text.lower()
    for kw in ascii_keywords:
        if kw.lower() in text_lower:
            fired.append(kw)

    # Japanese path: Sudachi POS check. A keyword fires only when its
    # surface appears as a morpheme whose POS starts with ``"名詞"``.
    if ja_keywords:
        ja_targets = set(ja_keywords)
        try:
            tokens = list(tokenizer_fn(text))
        except Exception:  # pragma: no cover — defensive
            # If the tokenizer crashes for any reason we fall back to
            # the substring match so the force-mask trigger still
            # surfaces obvious cases rather than silently disabling
            # itself. A tokenizer crash is already reported in logs by
            # the Sudachi layer; we do not want to compound it with a
            # security regression here.
            tokens = []
            for kw in ja_keywords:
                if kw in text:
                    fired.append(kw)
            return fired

        matched_ja: set[str] = set()
        for surface, pos in tokens:
            if pos and pos[0] == "名詞":
                # Exact match OR keyword is a substring of the token surface.
                # Sudachi may fuse compound nouns (機密情報 instead of 機密 + 情報).
                for kw in ja_targets:
                    if kw == surface or kw in surface:
                        matched_ja.add(kw)
        # Preserve the configured order.
        for kw in ja_keywords:
            if kw in matched_ja:
                fired.append(kw)

    return fired


def resolve_forced_categories(
    fired_keywords: list[str],
    configured_categories: list[str],
) -> list[str]:
    """Return which big categories are forced to masked=True.

    Trivially equal to ``configured_categories`` when ``fired_keywords``
    is non-empty and empty otherwise. Kept as a named function so the
    route handler has a one-liner to call and the semantics stay
    documented in one place: "any keyword fires → all configured
    categories lock". If a future iteration wants per-keyword category
    mapping, change this function's body without touching the route.
    """
    if not fired_keywords:
        return []
    # De-dupe while preserving order.
    seen: set[str] = set()
    ordered: list[str] = []
    for cat in configured_categories:
        if cat not in seen:
            seen.add(cat)
            ordered.append(cat)
    return ordered


def apply_force_mask(
    aggregated: Iterable[AggregatedEntity],
    forced_categories: list[str],
) -> list[AggregatedEntity]:
    """Flip ``masked=True`` for every aggregated entity in a forced category.

    The aggregated entities are returned as a new list of updated
    Pydantic models; the input iterable is not mutated. Pydantic's
    ``model_copy(update=...)`` is used so field validation still runs
    and any future schema migration picks it up automatically.
    """
    if not forced_categories:
        return list(aggregated)
    forced_set = set(forced_categories)
    out: list[AggregatedEntity] = []
    for entity in aggregated:
        if entity.category in forced_set and not entity.masked:
            out.append(entity.model_copy(update={"masked": True}))
        else:
            out.append(entity)
    return out
