#!/usr/bin/env bash
# Wrapper for Claude Desktop MCP integration.
#
# Claude Desktop calls this as:
#   { "command": "/path/to/mask-mcp/scripts/mcp-stdio.sh" }
#
# It handles two things that `docker run` alone cannot:
#   1. Ensures data/ exists BEFORE the bind mount so Docker does not
#      auto-create it as root (which causes PermissionError inside
#      the container).
#   2. Passes --user $(id -u):$(id -g) so the container process runs
#      as the same UID/GID as the host user, making the bind mount
#      writable regardless of the image's default USER (maskmcp/1000).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$REPO_DIR/data"

mkdir -p "$DATA_DIR"

exec docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    -v "$DATA_DIR:/app/data" \
    local-mask-mcp:latest \
    python -m mcp_server.server
