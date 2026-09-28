# ============================================================
#  local-mask-mcp — operations shortcuts
#
#  Single-file wrapper over `docker compose` + `curl` for the
#  everyday dev loop. Every target is a thin alias; the actual
#  commands are visible with `make --dry-run <target>` or by
#  reading this file.
#
#  Quick tour:
#      make help           # list all targets
#      make up             # build + start + wait for /health + print token
#      make token          # print the admin token
#      make config         # GET /admin/config with the auto-loaded token
#      make logs           # tail gateway logs
#      make test           # run pytest inside the Docker test stage
#      make down           # stop and remove container
#      make rebuild        # nuke caches + rebuild :latest from scratch
#
#  Override the compose driver if you still have the legacy CLI:
#      make COMPOSE="docker-compose" up
# ============================================================

SHELL         := /bin/bash
.DEFAULT_GOAL := help

COMPOSE       ?= docker compose
SERVICE       := mask-gateway
HOST          := 127.0.0.1
PORT          := 8081
DATA_DIR      := data
TOKEN_FILE    := $(DATA_DIR)/admin_token
BASE_URL      := http://$(HOST):$(PORT)

# ------------------------------------------------------------
#  Help
# ------------------------------------------------------------

.PHONY: help
help:  ## Show this list of targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nlocal-mask-mcp — make targets\n\n"} \
	      /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2 } \
	      END {printf "\n"}' $(MAKEFILE_LIST)

# ------------------------------------------------------------
#  Lifecycle
# ------------------------------------------------------------

.PHONY: up
up:  ## Build, start, wait for /health, then print the admin token
	@mkdir -p $(DATA_DIR)
	@$(COMPOSE) up -d --build
	@printf "waiting for /health "
	@for i in $$(seq 1 60); do \
	    if curl -sf $(BASE_URL)/health > /dev/null 2>&1; then \
	        printf "ok (%ss)\n" "$$i"; \
	        exit 0; \
	    fi; \
	    printf "."; sleep 1; \
	done; \
	printf "\n"; \
	echo "error: /health never responded; check 'make logs'" >&2; exit 1
	@$(MAKE) --no-print-directory token

.PHONY: down
down:  ## Stop and remove container + network (data/ is kept)
	@$(COMPOSE) down

.PHONY: restart
restart: down up  ## down + up

.PHONY: rebuild
rebuild:  ## Rebuild :latest from scratch — use when you hit stale-tag weirdness
	@$(COMPOSE) build --no-cache
	@echo "fresh :latest built. run 'make up' to start it."

.PHONY: ps
ps:  ## Show container status
	@$(COMPOSE) ps

.PHONY: mcp
mcp:  ## Start the MCP stdio server (for Claude Desktop; Ctrl-C to stop)
	@mkdir -p $(DATA_DIR)
	@docker run --rm -i \
	    --user "$$(id -u):$$(id -g)" \
	    -v "$$(pwd)/$(DATA_DIR):/app/data" \
	    local-mask-mcp:latest \
	    python -m mcp_server.server

# ------------------------------------------------------------
#  Introspection
# ------------------------------------------------------------

.PHONY: logs
logs:  ## Follow gateway logs (Ctrl-C to stop)
	@$(COMPOSE) logs -f $(SERVICE)

.PHONY: shell
shell:  ## Open an interactive shell inside the running container
	@$(COMPOSE) exec $(SERVICE) bash 2>/dev/null || $(COMPOSE) exec $(SERVICE) sh

.PHONY: health
health:  ## GET /health and pretty-print
	@curl -sf $(BASE_URL)/health | python3 -m json.tool

.PHONY: token
token:  ## Print the admin bearer token (bootstraps via /admin/config if missing)
	@if [ ! -s $(TOKEN_FILE) ]; then \
	    curl -s -o /dev/null $(BASE_URL)/admin/config 2>/dev/null || true; \
	fi
	@if [ -s $(TOKEN_FILE) ]; then \
	    printf "admin_token: "; cat $(TOKEN_FILE); \
	else \
	    echo "error: gateway is not running (run 'make up' first)" >&2; \
	    exit 1; \
	fi

.PHONY: config
config:  ## GET /admin/config using the auto-loaded token
	@TOKEN=$$(cat $(TOKEN_FILE) 2>/dev/null); \
	if [ -z "$$TOKEN" ]; then echo "error: run 'make up' first" >&2; exit 1; fi; \
	curl -sf -H "Authorization: Bearer $$TOKEN" $(BASE_URL)/admin/config | python3 -m json.tool

# ------------------------------------------------------------
#  Testing
# ------------------------------------------------------------

.PHONY: test
test:  ## Run pytest inside the Docker test stage (fails build on red)
	@docker build --target test --progress=plain -t local-mask-mcp:test .

# ------------------------------------------------------------
#  Danger zone
# ------------------------------------------------------------

.PHONY: clean
clean:  ## Stop and wipe data/ (DESTRUCTIVE: audit log + token + runtime config)
	@$(COMPOSE) down
	@printf "about to delete %s/ (audit log, admin token, runtime config).\ncontinue? [y/N] " "$(DATA_DIR)"
	@read ans; if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then \
	    rm -rf $(DATA_DIR); echo "removed."; \
	else \
	    echo "aborted."; \
	fi
