from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.routes.admin import router as admin_router
from app.routes.extension import router as extension_router
from app.routes.proxy import router as proxy_router
from app.routes.sanitize import router as sanitize_router


class ExtensionCORSMiddleware(BaseHTTPMiddleware):
    """One-shot CORS + Private Network Access handler for the browser extension.

    Replaces Starlette's ``CORSMiddleware`` for our use case because the
    stock middleware rejects preflights that carry the PNA signal header
    (``Access-Control-Request-Private-Network: true``) with ``400 Bad
    Request``, which Chrome then refuses to follow up with the real
    request. Implementing our own avoids that.

    Policy:
    - **OPTIONS preflights** always return 200 with every header Chrome
      needs: the echoed origin, allowed methods/headers, a 10-minute
      cache, and ``Access-Control-Allow-Private-Network: true``.
    - **Actual responses** are CORS-decorated with the same origin echo
      so the browser accepts the body. PNA allow header is added too as
      belt-and-braces (some Chrome builds re-check on the final response).
    - Requests without an ``Origin`` header (e.g. direct curl from the
      host) pass through untouched — no CORS headers, normal behaviour.

    We deliberately echo whatever ``Origin`` the client sent instead of
    a fixed allow-list. The gateway binds to loopback and is a pure MITM
    with no credentials of its own, so origin reflection does not expose
    anything a motivated local attacker could not already reach. If you
    run this on a non-loopback interface, tighten the check here.
    """

    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")

        if request.method == "OPTIONS" and origin:
            from starlette.responses import Response
            return Response(
                status_code=200,
                headers={
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                    "Access-Control-Allow-Headers": (
                        request.headers.get(
                            "access-control-request-headers",
                            "Content-Type",
                        )
                    ),
                    "Access-Control-Allow-Private-Network": "true",
                    "Access-Control-Max-Age": "600",
                    "Vary": "Origin",
                },
            )

        response = await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Private-Network"] = "true"
            response.headers["Vary"] = "Origin"
        return response


def create_app() -> FastAPI:
    app = FastAPI(
        title="Local Mask MCP Gateway",
        version="0.1.0",
        description=(
            "ローカル PII マスキングゲートウェイ。\n\n"
            "テキスト / ドキュメント内の個人情報 (固有名詞・メールアドレス・電話番号など) を"
            "検出してマスクし、LLM プロバイダへ安全に転送します。\n\n"
            "- **Presidio** (英語 NER + 正規表現)\n"
            "- **SudachiPy** (日本語形態素解析 → 固有名詞抽出)\n"
            "- **RegexAnalyzer** (ユーザ定義パターン)\n\n"
            "の 3 層アナライザを言語検出で自動切替、または `analyzers_by_language` で明示指定できます。"
        ),
        docs_url="/v1/api",
        redoc_url="/v1/api/redoc",
        openapi_url="/v1/api/openapi.json",
    )

    # CORS — exposed so the Chrome MV3 browser extension can call
    # `/v1/extension/sanitize` from its content script. Edge and Brave
    # use the same ``chrome-extension://`` origin scheme; Firefox uses
    # ``moz-extension://`` but this project explicitly targets Chromium
    # only (TODO.md Milestone 7) so we do not widen the allow-list for
    # it. The ``allow_origin_regex`` handles the per-install extension
    # ID that Chrome generates (which varies across developers and
    # across install modes — "load unpacked" produces a different ID
    # than a Chrome Web Store install would) by matching the scheme
    # rather than an explicit ID.
    #
    # The plain list entry is a belt-and-braces fallback; Starlette's
    # CORSMiddleware normally honours either ``allow_origins`` OR
    # ``allow_origin_regex``, and the regex is what actually matches
    # the real ``chrome-extension://<id>`` origin that Chrome sends.
    # ``POST`` covers the sanitize call itself and ``OPTIONS`` covers
    # the preflight; ``Content-Type`` is the only non-CORS-safelisted
    # header the extension attaches.
    # NOTE: replaced Starlette's CORSMiddleware because it returns 400
    # Bad Request on preflights that carry the Private Network Access
    # signal header, which Chrome then refuses to follow up on. Our
    # custom ExtensionCORSMiddleware handles both CORS and PNA in one
    # place and always returns 200 to valid preflights.
    app.add_middleware(ExtensionCORSMiddleware)

    app.include_router(admin_router, prefix="/admin", tags=["admin"])
    app.include_router(sanitize_router, prefix="/sanitize", tags=["sanitize"])
    app.include_router(proxy_router, prefix="/proxy", tags=["proxy"])
    app.include_router(extension_router, prefix="/v1/extension", tags=["extension"])

    @app.get("/health", tags=["system"])
    async def health() -> dict[str, str]:
        """ヘルスチェック。認証不要。Docker HEALTHCHECK が使用。"""
        return {"status": "ok"}

    @app.get("/api", include_in_schema=False)
    @app.get("/docs", include_in_schema=False)
    async def redirect_to_docs() -> RedirectResponse:
        """ショートカット: /api や /docs でも Swagger UI に飛ばす。"""
        return RedirectResponse(url="/v1/api")

    return app


app = create_app()
