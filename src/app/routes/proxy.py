from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.models.schemas import TextSanitizeRequest
from app.services.masking_service import MaskingService
from app.services.proxy_service import PASSTHROUGH_HEADER_MAPPING, ProxyService
from app.services.repositories import AuditRepository, ConfigRepository

router = APIRouter()
config_repo = ConfigRepository()
masking_service = MaskingService(config_repo, AuditRepository())
proxy_service = ProxyService(config_repo)


def _collect_passthrough_headers(request: Request) -> dict[str, str]:
    """Extract the subset of client headers we are willing to forward.

    Starlette's ``request.headers`` is a case-insensitive mapping, so
    ``name in request.headers`` works regardless of how the client cased
    the header. We copy into a plain dict (lowercased keys) to hand off
    to ``ProxyService``, which owns the canonicalization back to the
    casing each upstream provider expects.
    """
    return {
        name: request.headers[name]
        for name in PASSTHROUGH_HEADER_MAPPING
        if name in request.headers
    }


@router.post("/openai/v1/chat/completions")
async def proxy_openai_chat_completions(request: Request) -> dict[str, Any]:
    """OpenAI Chat Completions API への MITM プロキシ。PII マスク → 転送 → 応答返却。

    クライアントは `Authorization: Bearer sk-...` をそのまま送ること (ゲートウェイはキーを持たない)。
    """
    payload = await request.json()
    sanitized_payload = _sanitize_openai_like_payload(payload)
    return await _forward_payload(
        payload=sanitized_payload,
        incoming_headers=_collect_passthrough_headers(request),
        provider_id="openai",
        operation="v1/chat/completions",
    )


@router.post("/openai/v1/responses")
async def proxy_openai_responses(request: Request) -> dict[str, Any]:
    """OpenAI Responses API への MITM プロキシ。"""
    payload = await request.json()
    sanitized_payload = _sanitize_openai_like_payload(payload)
    return await _forward_payload(
        payload=sanitized_payload,
        incoming_headers=_collect_passthrough_headers(request),
        provider_id="openai",
        operation="v1/responses",
    )


@router.post("/anthropic/v1/messages")
async def proxy_anthropic_messages(request: Request) -> dict[str, Any]:
    """Anthropic Messages API への MITM プロキシ。`x-api-key` ヘッダをパススルー。"""
    payload = await request.json()
    sanitized_payload = _sanitize_openai_like_payload(payload)
    return await _forward_payload(
        payload=sanitized_payload,
        incoming_headers=_collect_passthrough_headers(request),
        provider_id="anthropic",
        operation="v1/messages",
    )


@router.post("/manus/v1/tasks")
async def proxy_manus_tasks(request: Request) -> dict[str, Any]:
    """Manus Tasks API への MITM プロキシ。"""
    payload = await request.json()
    sanitized_payload = _sanitize_openai_like_payload(payload)
    return await _forward_payload(
        payload=sanitized_payload,
        incoming_headers=_collect_passthrough_headers(request),
        provider_id="manus",
        operation="v1/tasks",
    )


@router.post("/generic/{provider_id}")
async def proxy_generic(provider_id: str, request: Request) -> dict[str, Any]:
    """汎用プロバイダへの MITM プロキシ。`provider_id` と `operation` で転送先を指定。"""
    payload = await request.json()
    sanitized_payload = _sanitize_openai_like_payload(payload)
    operation = payload.pop("operation", None)
    return await _forward_payload(
        payload=sanitized_payload,
        incoming_headers=_collect_passthrough_headers(request),
        provider_id=provider_id,
        operation=operation,
    )


async def _forward_payload(
    payload: dict[str, Any],
    incoming_headers: dict[str, str],
    provider_id: str,
    operation: str | None,
) -> dict[str, Any] | StreamingResponse:
    try:
        if payload.get("stream"):
            stream = proxy_service.forward_stream(
                payload=payload,
                incoming_headers=incoming_headers,
                provider_id=provider_id,
                operation=operation,
            )
            return StreamingResponse(
                stream,
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                },
            )
        return await proxy_service.forward(
            payload=payload,
            incoming_headers=incoming_headers,
            provider_id=provider_id,
            operation=operation,
        )
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=502, detail=f"upstream forwarding failed: {exc}") from exc


def _sanitize_openai_like_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if isinstance(payload.get("input"), str):
        payload["input"] = _sanitize_text(payload["input"])

    if isinstance(payload.get("system"), str):
        payload["system"] = _sanitize_text(payload["system"])

    if isinstance(payload.get("messages"), list):
        payload["messages"] = [_sanitize_message(message) for message in payload["messages"]]

    return payload


def _sanitize_message(message: dict[str, Any]) -> dict[str, Any]:
    content = message.get("content")
    if isinstance(content, str):
        return {**message, "content": _sanitize_text(content)}

    if isinstance(content, list):
        sanitized_parts = []
        for part in content:
            if part.get("type") == "text":
                text_value = part.get("text") or part.get("content") or ""
                if "text" in part:
                    sanitized_parts.append({**part, "text": _sanitize_text(text_value)})
                else:
                    sanitized_parts.append({**part, "content": _sanitize_text(text_value)})
            else:
                sanitized_parts.append(part)
        return {**message, "content": sanitized_parts}

    return message


def _sanitize_text(text: str) -> str:
    result = masking_service.sanitize_text(TextSanitizeRequest(text=text))
    return result.sanitized_text
