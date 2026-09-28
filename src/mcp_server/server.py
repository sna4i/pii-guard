from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from app.models.schemas import TextSanitizeRequest
from app.services.language_detection import detect_language as _detect_language
from app.services.masking_service import MaskingService
from app.services.proxy_service import ProxyService
from app.services.repositories import AuditRepository, ConfigRepository

mcp = FastMCP("local-mask-mcp")
config_repo = ConfigRepository()
service = MaskingService(config_repo, AuditRepository())
proxy_service = ProxyService(config_repo)


@mcp.tool()
def sanitize_text(text: str, mask_strategy: str = "tag") -> dict:
    result = service.sanitize_text(
        TextSanitizeRequest(
            text=text,
            mask_strategy=mask_strategy if mask_strategy in {"tag", "partial", "hash"} else "tag",
        )
    )
    return result.model_dump(mode="json")


@mcp.tool()
def toggle_filter(enabled: bool) -> dict:
    config = config_repo.load()
    config.filter_enabled = enabled
    config_repo.save(config)
    return {"filter_enabled": config.filter_enabled}


@mcp.tool()
def set_provider(provider_id: str) -> dict:
    config = config_repo.load()
    if provider_id not in config.providers:
        raise ValueError(f"unknown provider: {provider_id}")
    if not config.providers[provider_id].enabled:
        raise ValueError(f"provider disabled: {provider_id}")
    config.default_provider_id = provider_id
    config_repo.save(config)
    return proxy_service.describe_provider(provider_id).model_dump(mode="json")


@mcp.tool()
def get_runtime_config() -> dict:
    config = config_repo.load()
    return {
        **config.model_dump(mode="json"),
        "selected_provider": proxy_service.describe_provider(config.default_provider_id).model_dump(mode="json"),
    }


@mcp.tool()
def detect_language(text: str) -> dict:
    """Return the coarse language label for ``text``.

    Thin wrapper over :func:`app.services.language_detection.detect_language`
    so MCP clients can pre-flight a payload before deciding which
    analyzer chain to enable. The returned label is one of ``"ja"``,
    ``"en"``, or ``"mixed"`` — the same three-way signal the
    language-aware dispatcher consumes internally.

    This runs in the trusted-stdio model, same as every other tool
    in this module, so no auth is required.
    """
    return {"language": _detect_language(text)}


@mcp.tool()
def set_analyzer_config(
    morphological_analyzer: str,
    analyzers_by_language: dict | None = None,
) -> dict:
    """Update RuntimeConfig's analyzer dispatch fields and persist.

    Two fields are in scope for this tool:

    * ``morphological_analyzer`` — one of ``"none"`` or ``"sudachi"``.
      Flips the Japanese proper-noun analyzer on/off for the legacy
      (non-language-aware) code path.
    * ``analyzers_by_language`` — ``dict[str, list[str]]`` mapping a
      language label (``"ja"`` / ``"en"`` / ``"mixed"``) to an ordered
      list of analyzer names (``"presidio"`` / ``"sudachi"`` / ``"regex"``).
      ``None`` disables language-aware routing entirely and re-enables
      the legacy path.

    No extra validation beyond what Pydantic already does on
    :class:`RuntimeConfig` — an unknown ``morphological_analyzer``
    value or a non-dict ``analyzers_by_language`` raises the usual
    ``ValidationError`` at save time. Returns the freshly saved
    config as a JSON-ready dict so the caller can confirm the write
    landed.
    """
    config = config_repo.load()
    # Re-validate through Pydantic so any stray value surfaces as a
    # ValidationError rather than a silently-corrupt on-disk config.
    data = config.model_dump()
    data["morphological_analyzer"] = morphological_analyzer
    data["analyzers_by_language"] = analyzers_by_language
    new_config = config.__class__.model_validate(data)
    saved = config_repo.save(new_config)
    return saved.model_dump(mode="json")


if __name__ == "__main__":
    mcp.run()
