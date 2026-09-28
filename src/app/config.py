from __future__ import annotations

import json
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


#: Default provider catalog. Note the deliberate absence of an
#: ``api_key_env`` field: the gateway operates as a pure MITM and does not
#: hold upstream credentials. Clients send their own auth header (e.g.
#: ``Authorization: Bearer ...`` for OpenAI, ``x-api-key: ...`` for
#: Anthropic) and the proxy forwards it verbatim via
#: ``PASSTHROUGH_HEADER_MAPPING`` in ``proxy_service.py``.
#:
#: ``default_headers`` is for server-attached metadata only (versioning,
#: user-agent, etc.) — NEVER for secrets.
DEFAULT_PROVIDER_CATALOG = {
    "openai": {
        "provider_id": "openai",
        "provider_type": "openai",
        "base_url": "https://api.openai.com",
        "enabled": True,
        "route_mode": "native",
        "default_headers": {},
        "model_mapping": {},
    },
    "anthropic": {
        "provider_id": "anthropic",
        "provider_type": "anthropic",
        "base_url": "https://api.anthropic.com",
        "enabled": True,
        "route_mode": "native",
        # anthropic-version can still be overridden by the client if it
        # sends its own "anthropic-version" header (it's in the passthrough
        # allowlist). This value is only the fallback.
        "default_headers": {"anthropic-version": "2023-06-01"},
        "model_mapping": {},
    },
    "manus": {
        "provider_id": "manus",
        "provider_type": "manus",
        "base_url": "https://api.manus.im",
        "enabled": False,
        "route_mode": "native",
        "default_headers": {},
        "model_mapping": {},
    },
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_host: str = "127.0.0.1"
    app_port: int = 8081
    #: If set via ADMIN_TOKEN env var, this wins and is used verbatim.
    #: If unset (or left as the legacy sentinel "change-me"), the gateway
    #: auto-generates a secure random token on first access and persists
    #: it to ``admin_token_path``. Consumers should use
    #: ``get_admin_token()`` rather than reading this attribute directly.
    admin_token: str | None = None
    #: Where to persist the auto-generated token. The file is created with
    #: mode 0600 on first access; subsequent runs reuse it. Bind-mounted
    #: under /app/data in the Docker image so the host side can
    #: ``cat data/admin_token`` to retrieve it.
    admin_token_path: Path = Path("./data/admin_token")
    default_provider_id: str = Field(default="openai")
    default_provider_catalog_json: str = Field(
        default_factory=lambda: json.dumps(DEFAULT_PROVIDER_CATALOG, ensure_ascii=False)
    )
    default_filter_enabled: bool = True
    default_fail_closed: bool = True
    default_mask_strategy: str = "tag"
    audit_log_path: Path = Path("./data/audit.jsonl")
    runtime_config_path: Path = Path("./data/runtime_config.json")
    temp_dir: Path = Path("./data/tmp")

    def build_provider_catalog(self) -> dict[str, dict]:
        return json.loads(self.default_provider_catalog_json)


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_admin_token() -> str:
    """Return the bearer token required on /admin/* and /sanitize/* routes.

    Resolution order:
    1. ``ADMIN_TOKEN`` environment variable (if set to a real value, i.e.
       not the legacy sentinel ``"change-me"``).
    2. Contents of ``Settings.admin_token_path`` if the file exists.
    3. A freshly generated 32-byte URL-safe token, written to that path
       with mode 0600 for subsequent runs to reuse.

    Cached with ``@lru_cache`` so the file is touched at most once per
    process. Tests can reset via ``get_admin_token.cache_clear()``.
    """
    settings = get_settings()
    configured = settings.admin_token
    if configured and configured != "change-me":
        return configured

    path = settings.admin_token_path
    if path.exists():
        stored = path.read_text(encoding="utf-8").strip()
        if stored:
            return stored

    # First-run bootstrap: generate, persist with tight permissions, return.
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    path.write_text(token + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        # Some filesystems (FAT, network mounts) reject chmod. Non-fatal.
        pass
    return token
