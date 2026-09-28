from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Query

from app.config import get_admin_token
from app.models.schemas import RuntimeConfig, ToggleRequest
from app.services.repositories import AuditRepository, ConfigRepository

router = APIRouter()
config_repo = ConfigRepository()
audit_repo = AuditRepository()


def _authorize(token: str | None) -> None:
    expected = f"Bearer {get_admin_token()}"
    if token != expected:
        raise HTTPException(status_code=401, detail="invalid admin token")


@router.get("/config", response_model=RuntimeConfig)
async def get_config(authorization: str | None = Header(default=None)) -> RuntimeConfig:
    """現在の RuntimeConfig (フィルタ設定・プロバイダ一覧・アナライザ設定) を取得する。"""
    _authorize(authorization)
    return config_repo.load()


@router.put("/config", response_model=RuntimeConfig)
async def update_config(
    payload: RuntimeConfig,
    authorization: str | None = Header(default=None),
) -> RuntimeConfig:
    """RuntimeConfig を丸ごと上書きする。

    `morphological_analyzer`, `analyzers_by_language`, `regex_patterns`,
    `sudachi_split_mode`, `proper_noun_pos_patterns`, `min_score` など
    すべてのフィールドを一括で設定できる。
    """
    _authorize(authorization)
    return config_repo.save(payload)


@router.post("/toggle", response_model=RuntimeConfig)
async def toggle_filter(
    payload: ToggleRequest,
    authorization: str | None = Header(default=None),
) -> RuntimeConfig:
    """フィルタの ON/OFF を切り替える (`filter_enabled` のみ更新)。"""
    _authorize(authorization)
    config = config_repo.load()
    config.filter_enabled = payload.enabled
    return config_repo.save(config)


@router.get("/audits")
async def list_audits(
    authorization: str | None = Header(default=None),
    since: str | None = Query(
        default=None,
        description="ISO-8601 datetime; drops records created strictly before it.",
    ),
    entity_type: str | None = Query(
        default=None,
        description="Keep only records whose entity_summary contains this key.",
    ),
    action: Literal["masked", "allowed"] | None = Query(
        default=None,
        description="Coarse action filter: 'masked' (any detection) or 'allowed'.",
    ),
    limit: int = Query(
        default=100,
        ge=1,
        le=10_000,
        description="Max records returned after filtering; default preserves legacy behaviour.",
    ),
) -> list[dict]:
    """Return recent audit records, optionally filtered by query params.

    Backward compatible: ``GET /admin/audits`` with no params returns
    the last 100 records, newest first, exactly as before. The
    ``since`` / ``entity_type`` / ``action`` filters are layered on
    top; ``limit`` applies after filtering so a narrow filter still
    surfaces up to ``limit`` matches.
    """
    _authorize(authorization)
    parsed_since: datetime | None = None
    if since is not None:
        try:
            parsed_since = datetime.fromisoformat(since)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"invalid 'since' query param: {exc}",
            ) from exc
    return audit_repo.list_recent(
        limit=limit,
        since=parsed_since,
        entity_type=entity_type,
        action=action,
    )
