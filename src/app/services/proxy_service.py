from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from app.models.schemas import ProviderConfig, ProviderSelectionResult
from app.services.repositories import ConfigRepository


#: Headers the gateway is willing to forward from a client request to the
#: upstream provider. Keys are the lowercased incoming names (HTTP headers
#: are case-insensitive); values are the canonical casing we send upstream.
#:
#: This is the single source of truth: the route layer imports the keys
#: when extracting headers from the ``Request``, and this service uses the
#: mapping when building the outbound request.
#:
#: Add to this dict to support new providers — e.g. an ``"x-goog-api-key"``
#: entry for Google APIs. Do **not** start forwarding arbitrary headers
#: (Host, Cookie, etc.) — that would defeat the whole point of an MITM.
PASSTHROUGH_HEADER_MAPPING: dict[str, str] = {
    "authorization": "Authorization",
    "x-api-key": "x-api-key",
    "anthropic-version": "anthropic-version",
    "anthropic-beta": "anthropic-beta",
    "openai-organization": "OpenAI-Organization",
    "openai-project": "OpenAI-Project",
}


@dataclass(slots=True)
class ProviderTarget:
    provider: ProviderConfig
    operation: str


class ProxyService:
    def __init__(self, config_repo: ConfigRepository | None = None) -> None:
        self.config_repo = config_repo or ConfigRepository()

    def resolve_provider(
        self,
        provider_id: str | None = None,
        operation: str | None = None,
    ) -> ProviderTarget:
        config = self.config_repo.load()
        resolved_provider_id = provider_id or config.default_provider_id
        provider = config.providers.get(resolved_provider_id)
        if provider is None:
            raise ValueError(f"unknown provider: {resolved_provider_id}")
        if not provider.enabled:
            raise ValueError(f"provider disabled: {resolved_provider_id}")
        return ProviderTarget(provider=provider, operation=operation or self._default_operation(provider))

    def describe_provider(self, provider_id: str | None = None) -> ProviderSelectionResult:
        target = self.resolve_provider(provider_id=provider_id)
        return ProviderSelectionResult(
            provider_id=target.provider.provider_id,
            provider_type=target.provider.provider_type,
            base_url=target.provider.base_url,
            enabled=target.provider.enabled,
            route_mode=target.provider.route_mode,
        )

    async def forward(
        self,
        payload: dict[str, Any],
        incoming_headers: dict[str, str],
        provider_id: str | None = None,
        operation: str | None = None,
    ) -> dict[str, Any]:
        target = self.resolve_provider(provider_id=provider_id, operation=operation)
        request_payload = self._normalize_request(target.provider, target.operation, payload)
        headers = self._build_headers(target.provider, incoming_headers)
        url = self._build_url(target.provider.base_url, target.operation)

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, headers=headers, json=request_payload)
            response.raise_for_status()
            body = response.json()

        return self._normalize_response(target.provider, body)

    async def forward_stream(
        self,
        payload: dict[str, Any],
        incoming_headers: dict[str, str],
        provider_id: str | None = None,
        operation: str | None = None,
    ) -> AsyncIterator[bytes]:
        """Streaming variant of ``forward``.

        Opens an HTTP stream to the upstream provider and yields raw
        bytes (typically SSE chunks) as they arrive. The caller wraps
        the return value in ``StreamingResponse``.

        PII masking still runs on the *request* payload (in the route
        layer, before calling this method). The *response* stream is
        passed through unmodified — there is nothing to mask in the
        model's output stream.
        """
        target = self.resolve_provider(provider_id=provider_id, operation=operation)
        request_payload = self._normalize_request(
            target.provider, target.operation, payload
        )
        headers = self._build_headers(target.provider, incoming_headers)
        url = self._build_url(target.provider.base_url, target.operation)

        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST", url, headers=headers, json=request_payload
            ) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    yield chunk

    def _default_operation(self, provider: ProviderConfig) -> str:
        if provider.provider_type == "openai":
            return "v1/chat/completions"
        if provider.provider_type == "anthropic":
            return "v1/messages"
        if provider.provider_type == "manus":
            return "v1/tasks"
        return "v1/chat/completions"

    def _normalize_request(
        self,
        provider: ProviderConfig,
        operation: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if provider.provider_type == "openai":
            return payload

        if provider.provider_type == "anthropic":
            return self._to_anthropic_messages_payload(payload)

        if provider.provider_type == "manus":
            return self._to_manus_task_payload(payload)

        return payload

    def _normalize_response(self, provider: ProviderConfig, body: dict[str, Any]) -> dict[str, Any]:
        if provider.provider_type == "anthropic":
            text_chunks = []
            for item in body.get("content", []):
                if item.get("type") == "text":
                    text_chunks.append(item.get("text", ""))
            if text_chunks:
                body.setdefault("normalized_text", "\n".join(text_chunks).strip())
        return body

    def _build_headers(
        self,
        provider: ProviderConfig,
        incoming_headers: dict[str, str],
    ) -> dict[str, str]:
        """Assemble the outbound header set for a proxied request.

        The gateway is a pure MITM: it does not hold credentials. Clients
        must send the same auth header they would send directly to the
        upstream provider (``Authorization: Bearer ...`` for OpenAI-style,
        ``x-api-key: ...`` for Anthropic, etc.). We forward the subset
        listed in ``PASSTHROUGH_HEADER_MAPPING`` and drop everything else.

        ``provider.default_headers`` still applies as a server-side base
        layer (e.g. a gateway-wide ``User-Agent``). Client-supplied headers
        override the defaults on conflict, which matches what operators
        typically expect from a transparent proxy.
        """
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            **provider.default_headers,
        }
        for incoming_name, canonical in PASSTHROUGH_HEADER_MAPPING.items():
            value = incoming_headers.get(incoming_name)
            if value:
                headers[canonical] = value
        return headers

    def _build_url(self, base_url: str, operation: str) -> str:
        return f"{base_url.rstrip('/')}/{operation.lstrip('/')}"

    def _resolve_model(self, provider: ProviderConfig, model_name: str | None) -> str | None:
        if not model_name:
            return model_name
        return provider.model_mapping.get(model_name, model_name)

    def _extract_text_segments(self, payload: dict[str, Any]) -> list[str]:
        texts: list[str] = []

        if isinstance(payload.get("input"), str):
            texts.append(payload["input"])

        for message in payload.get("messages", []):
            content = message.get("content")
            if isinstance(content, str):
                texts.append(content)
            elif isinstance(content, list):
                for item in content:
                    if item.get("type") == "text":
                        texts.append(item.get("text", ""))
                        if "content" in item and isinstance(item["content"], str):
                            texts.append(item["content"])

        return [text for text in texts if text]

    def _to_anthropic_messages_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        model_name = self._resolve_model_name_from_payload(payload)
        system_prompt = payload.get("system")
        messages = payload.get("messages", [])

        normalized_messages = []
        for message in messages:
            content = message.get("content")
            if isinstance(content, str):
                normalized_content = [{"type": "text", "text": content}]
            elif isinstance(content, list):
                normalized_content = []
                for item in content:
                    if item.get("type") == "text":
                        text_value = item.get("text") or item.get("content") or ""
                        normalized_content.append({"type": "text", "text": text_value})
            else:
                normalized_content = [{"type": "text", "text": str(content)}]

            normalized_messages.append(
                {
                    "role": message.get("role", "user"),
                    "content": normalized_content,
                }
            )

        response_payload: dict[str, Any] = {
            "model": model_name or "claude-3-5-sonnet-latest",
            "messages": normalized_messages,
            "max_tokens": payload.get("max_tokens", 1024),
        }
        if system_prompt:
            response_payload["system"] = system_prompt
        return response_payload

    def _to_manus_task_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        prompt_text = payload.get("input")
        if not isinstance(prompt_text, str):
            segments = self._extract_text_segments(payload)
            prompt_text = "\n\n".join(segments)

        return {
            "input": prompt_text or "",
            "metadata": {
                "source": "local-mask-mcp",
                "original_model": payload.get("model"),
            },
        }

    def _resolve_model_name_from_payload(self, payload: dict[str, Any]) -> str | None:
        return payload.get("model")
