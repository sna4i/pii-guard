# syntax=docker/dockerfile:1.7
#
# local-mask-mcp — PII masking gateway + MCP adapter (uv-managed)
#
# Build:   docker build -t local-mask-mcp:latest .
# Run:     docker run --rm -p 8081:8081 -v $(pwd)/data:/app/data --env-file .env local-mask-mcp:latest
# Compose: docker compose up -d
#

# ============================================================
# Stage 1: Builder
#   Uses uv to sync the project's dependency tree into a self-
#   contained venv at /opt/venv. The two-step sync (deps first,
#   project second) keeps the heavy dependency layer cacheable
#   across source-only edits.
# ============================================================
FROM python:3.11-slim-bookworm AS builder

# Pin the uv binary by pulling it from Astral's distroless image.
# Bump the tag in lockstep with the host-side uv you develop against
# so local and container behaviour stay aligned.
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /build

# 1) Dependency layer — cached unless pyproject.toml / uv.lock change.
#    --no-install-project skips the local package itself so this layer
#    stays stable across source edits.
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# 2) Project layer — installs the local package on top of the deps.
#    --no-editable copies the source into site-packages, so the
#    runtime stage does not need /build/src on disk.
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# 3) spaCy model — baked into /opt/venv here, inherited by both the
#    test and runtime stages so neither has to re-download it.
#
#    `uv run` is critical: spaCy 3.8's downloader auto-detects uv on
#    PATH and subprocesses out to `uv pip install`, which in turn
#    requires VIRTUAL_ENV to be set. Calling `/opt/venv/bin/python`
#    directly would bypass uv run's env injection and fail with
#    "No virtual environment found". `--no-sync` skips uv's implicit
#    pre-run lock check since we just synced one layer up.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv run --no-sync python -m spacy download en_core_web_lg

# ============================================================
# Stage 2 (optional): Test
#   Built only on explicit request:
#       docker build --target test .
#
#   Forks from `builder`, re-syncs WITH the dev dependency
#   group (pytest, pytest-asyncio, ruff), lays down the spaCy
#   model + tesseract that Presidio / pytesseract expect, and
#   runs the suite. If any test fails the Docker build fails,
#   which makes this a drop-in CI gate. The output image is
#   discarded — `runtime` below is what `docker build .` (no
#   target) produces and what `docker compose` ships.
# ============================================================
FROM builder AS test

# tesseract is not exercised by the current unit tests, but baking it in
# now keeps the test stage honest the moment an OCR test is added.
#
# Node.js 20 is required by ``tests/test_js_vectors.py``: the pytest
# wrapper spawns ``node scripts/validate_vectors.js`` to exercise the
# pure-JS masking engine against the shared JSON vectors. Without Node
# the wrapper would skip; by baking Node 20 in we keep the JS engine
# under CI alongside the Python suite.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        curl \
        ca-certificates \
        gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
         | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
         > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Re-sync WITH dev deps. Two flags are load-bearing:
#   --inexact : the default uv sync mode is strict and would
#               uninstall en_core_web_lg (installed in the builder
#               stage via spaCy's downloader, so it lives in
#               /opt/venv but NOT in uv.lock). --inexact tells uv
#               to leave packages it did not put there alone.
#   --no-editable : match the builder stage's install mode and
#               avoid a silent editable↔non-editable flip of the
#               project on top of an already-built venv.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --inexact --no-editable

# Only the test stage needs tests/ + the JS engine sources on disk.
# The JS vectors subprocess resolves paths relative to the repo root
# (CWD = /build in this stage), so both browser-extension and scripts
# must be layered in here.
COPY tests ./tests
COPY browser-extension ./browser-extension
COPY scripts ./scripts

# Fail the build on any red test.
RUN uv run pytest tests/ -v

# ============================================================
# Stage 3: Runtime — slim image with only what the app needs
# ============================================================
FROM python:3.11-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Put the uv-built venv first on PATH so `uvicorn`, `python`, and
    # other console scripts resolve inside it automatically.
    PATH="/opt/venv/bin:$PATH" \
    # Container-friendly defaults (override via --env / compose)
    APP_HOST=0.0.0.0 \
    APP_PORT=8081 \
    AUDIT_LOG_PATH=/app/data/audit.jsonl \
    RUNTIME_CONFIG_PATH=/app/data/runtime_config.json \
    TEMP_DIR=/app/data/tmp \
    ADMIN_TOKEN_PATH=/app/data/admin_token

# Runtime OS deps:
#   tesseract-ocr(-eng): required by pytesseract for OCR
#   tini              : proper PID 1 so SIGTERM reaches uvicorn
#   curl              : used by HEALTHCHECK (lighter than spinning
#                       up a Python interpreter per probe)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        tini \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Bring over the uv-managed venv from the builder stage. The venv
# already contains en_core_web_lg (installed in builder step 3), so
# the first request is not going to stall on a ~400 MB model fetch.
#
# If image size matters more than startup latency, switch to
# `en_core_web_sm` in builder AND configure a matching NlpEngineProvider
# in src/app/services/masking_service.py.
COPY --from=builder /opt/venv /opt/venv

# Non-root user + writable data dir.
RUN useradd --create-home --shell /bin/bash --uid 1000 maskmcp \
    && mkdir -p /app/data/tmp \
    && chown -R maskmcp:maskmcp /app

WORKDIR /app
USER maskmcp

EXPOSE 8081

# Healthcheck — see the docker-compose.yml for the same policy.
#
#   - The FastAPI app exposes GET /health returning {"status":"ok"}.
#   - app/routes/sanitize.py and app/routes/proxy.py instantiate
#     MaskingService() at module load, so spaCy's en_core_web_lg is
#     loaded eagerly during uvicorn startup (~10–25s). The gateway
#     only starts accepting /health after that load finishes.
#   - start-period must cover that eager load; /health itself is
#     static so a 5s timeout is plenty once warm.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8081/health || exit 1

# tini forwards SIGTERM → uvicorn so `docker stop` is fast & clean.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081"]
