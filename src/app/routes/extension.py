"""Browser-extension-facing sanitize endpoint.

This route sits alongside the admin-token-protected ``/sanitize/text``
endpoint but is intentionally *unauthenticated*. The trust model, same
as the rest of the gateway, is loopback-only:

* Docker publishes the port as ``127.0.0.1:8081``.
* The only process that is supposed to call this endpoint is the
  Chrome MV3 extension loaded into the user's own browser.
* Any other localhost process that reaches this endpoint can, at
  worst, submit its own text and receive back the masked version.
  It cannot alter gateway state, leak secrets, or read the audit log.

Decoupling the extension from the admin token lets us ship an install
experience where the user does not have to copy ``data/admin_token``
into their browser. That token is a **write** credential; this route
is strictly **read** (input text → output masked text).
"""
from __future__ import annotations

from fastapi import APIRouter

from app.models.schemas import (
    AggregatedExtensionResponse,
    ExtensionSanitizeRequest,
    ExtensionSanitizeResponse,
    TextSanitizeRequest,
)
from app.services.aggregation import aggregate_detections
from app.services.force_mask import (
    apply_force_mask,
    detect_force_mask_trigger,
    resolve_forced_categories,
)
from app.services.masking_service import MaskingService
from app.services.repositories import AuditRepository, ConfigRepository

router = APIRouter()

# A single shared ``MaskingService`` instance mirrors the pattern used by
# ``sanitize.py`` / ``proxy.py``. The service itself is stateless except
# for its analyzer cache, so reusing one instance across requests avoids
# re-paying the Sudachi dictionary / Presidio NER load cost every call.
_masking_service = MaskingService(ConfigRepository(), AuditRepository())


def _sudachi_tokenize(text: str) -> list[tuple[str, tuple[str, ...]]]:
    """Tokenize ``text`` via the MaskingService's cached Sudachi tokenizer.

    Returns ``(surface, pos_tuple)`` pairs so
    :func:`app.services.force_mask.detect_force_mask_trigger` can POS-check
    each keyword candidate. Lazy: we pull ``SudachiProperNounAnalyzer``'s
    internal tokenizer off the first cached instance in the service. If
    Sudachi has never been constructed yet, we build a throwaway instance
    — that is acceptable here because the aggregated endpoint is the only
    caller and the tokenizer dict is ~50 MB of memory shared via
    SudachiPy's own global cache.
    """
    # Reach into the cache first; fall back to building a throwaway
    # analyzer when the cache is cold. Either way we get a tokenizer
    # with the default split mode (C) which is what the force-mask
    # trigger expects — C keeps multi-morpheme keywords fused.
    analyzer = _masking_service._analyzers.get("sudachi")
    if analyzer is None:
        from app.services.analyzers import SudachiProperNounAnalyzer

        analyzer = SudachiProperNounAnalyzer()
    tokenizer = analyzer._tokenizer  # type: ignore[attr-defined]
    mode = analyzer._mode  # type: ignore[attr-defined]
    return [
        (morpheme.surface(), tuple(morpheme.part_of_speech()))
        for morpheme in tokenizer.tokenize(text, mode)
    ]


@router.post(
    "/sanitize",
    response_model=ExtensionSanitizeResponse,
    summary="Mask PII in a text payload on behalf of a browser extension.",
)
async def extension_sanitize(
    payload: ExtensionSanitizeRequest,
) -> ExtensionSanitizeResponse:
    """Sanitize text coming from a browser extension.

    The handler intentionally does **not** require ``ADMIN_TOKEN``. See
    the module docstring for the trust rationale. Internally it wraps
    the same ``MaskingService.sanitize_text`` used by the legacy
    ``/sanitize/text`` endpoint, so detection coverage is identical:
    Presidio + Sudachi + RegexAnalyzer + preset patterns, subject to
    whatever ``RuntimeConfig`` is in force.

    The audit trail is written with ``request_type="extension"`` so
    operators can filter for extension-originating traffic in
    ``data/audit.jsonl`` via ``jq`` or the admin query endpoint.
    """
    # ``MaskingService`` is the source of truth for masking; everything
    # this route adds is (1) a narrower request schema, (2) an
    # ``extension`` audit tag, and (3) a coarse ``action`` summary.
    result = _masking_service.sanitize_text(
        TextSanitizeRequest(text=payload.text),
        request_type="extension",
        upstream_target=payload.source_url,
    )

    # Coarse action summary. The content script uses this to decide
    # whether to do the text-substitution dance or proceed unchanged.
    # ``filter_enabled == False`` comes back as ``no_change`` because
    # the sanitized text is byte-identical to the input in that path.
    if not result.filter_enabled:
        action = "no_change"
    elif result.sanitized_text != payload.text:
        action = "masked"
    else:
        # Filter ran, but either no detections fired or every
        # detection was allow-listed and left verbatim.
        action = "no_change"

    return ExtensionSanitizeResponse(
        sanitized_text=result.sanitized_text,
        detections=result.detections,
        action=action,
        audit_id=result.audit_id,
    )


@router.post(
    "/sanitize/aggregated",
    response_model=AggregatedExtensionResponse,
    summary="Mask PII + return the aggregated (one-per-surface) view.",
)
async def extension_sanitize_aggregated(
    payload: ExtensionSanitizeRequest,
) -> AggregatedExtensionResponse:
    """Sanitize text and return the aggregated-entity shape.

    This is the Milestone 8 Wave A companion to the original
    ``/sanitize`` endpoint. The original endpoint returns one
    :class:`DetectionResult` per occurrence for backward compatibility;
    this endpoint collapses occurrences that share the same surface
    text into a single :class:`AggregatedEntity` and applies the
    force-mask keyword trigger on top. Both endpoints share the same
    :class:`MaskingService` pipeline under the hood, so detection
    coverage is identical.

    Response shape highlights:

    * ``aggregated`` is the list the sidebar renders (one row per
      unique masked surface).
    * ``force_masked_categories`` enumerates the big categories the
      keyword trigger locked to ``masked=True`` — the UI draws a
      lock icon on those categories.
    * ``original_text`` is echoed verbatim so the sidebar can render
      the input alongside the controls without keeping its own copy.
    """
    result = _masking_service.sanitize_text(
        TextSanitizeRequest(text=payload.text),
        request_type="extension",
        upstream_target=payload.source_url,
    )

    # Aggregation is a pure transformation over the detections list;
    # it does not re-run any analyzer.
    aggregated = aggregate_detections(result.detections)

    # Force-mask trigger. Skipped entirely when the filter was off —
    # an off-filter request never masks anything and returning
    # force_masked_categories would be misleading.
    config = _masking_service.config_repo.load()
    forced_categories: list[str] = []
    if result.filter_enabled and config.force_mask_keywords:
        fired = detect_force_mask_trigger(
            payload.text,
            list(config.force_mask_keywords),
            tokenizer_fn=_sudachi_tokenize,
        )
        forced_categories = resolve_forced_categories(
            fired, list(config.force_mask_categories)
        )
        if forced_categories:
            aggregated = apply_force_mask(aggregated, forced_categories)

    return AggregatedExtensionResponse(
        original_text=payload.text,
        aggregated=aggregated,
        audit_id=result.audit_id,
        force_masked_categories=forced_categories,
    )
