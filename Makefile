COMPOSE := docker compose -p plat -f deploy/docker-compose.yml
COMPOSE_DEV := $(COMPOSE) -f deploy/docker-compose.dev.yml
# the admin dev container writes Vite's cache (node_modules/.vite) into the checkout
export DEV_USER := $(shell id -u):$(shell id -g)

.DEFAULT_GOAL := help
.PHONY: help deps install seed start stop ps logs cli build-control-plane build-studio dev-admin start-dev \
	typecheck test e2e e2e-studio e2e-admin test-edge plugin

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

deps: ## Install the workspace dependencies
	pnpm install

install: deps ## Install or update the local stack (safe to rerun)
	deploy/install.sh

seed: deps ## Install the local stack with sample users and apps
	deploy/install.sh --seed

# `up --build`, like install.sh: the control plane (routes, Studio's URL...) and the containers follow the checkout, a
# cache hit when nothing changed. Waits for the control plane's API, which it serves once its routes (Caddy) are in place.
start: ## Start the stack, rebuilding the control plane if its sources changed
	$(COMPOSE) up -d --build
	@for i in $$(seq 60); do curl -fs -o /dev/null -H 'Host: api.localhost:8100' http://127.0.0.1:8100/health && exit 0; \
	sleep 1; done; echo "the control plane did not answer within 60 s (make logs SERVICE=control-plane)" >&2; exit 1

stop: ## Stop the stack
	$(COMPOSE) stop

ps: ## List the stack's containers
	$(COMPOSE) ps

logs: ## Follow the logs (SERVICE=control-plane for one service)
	$(COMPOSE) logs -f --tail 100 $(SERVICE)

cli: ## Run the admin CLI (ARGS="create-user carol@example.com developer")
	docker exec plat-control-plane node src/cli.ts $(ARGS)

build-control-plane: ## Rebuild and restart the control plane, with the built admin console
	$(COMPOSE) up -d --build control-plane

build-studio: ## Rebuild and restart the Studio image
	apps/studio/build.sh
	$(COMPOSE) up -d studio

# Announces the platform's URL instead of the dev server's own one ($(1) -> $(2)), drops the "Network:" lines. Ignores
# Ctrl+C, so that the shutdown lines still go through. perl, not awk: mawk holds piped input back in blocks.
announce = (trap '' INT; exec perl -ne 'BEGIN { $$| = 1 } next if /Network:/; s!\Q$(1)\E!$(2)!; print')

# Points Caddy's admin route (router.ts upsertAdmin) to $(1). The control plane resets it when it starts.
admin_route = curl -fsS -X PATCH -H 'Content-Type: application/json' -d '"$(1)"' \
	http://127.0.0.1:2030/id/admin/handle/0/upstreams/0/dial

# Ctrl+C stops the dev container; `trap :` keeps the shell alive to put the built console back. No compose menu: it puts
# the terminal in raw mode. No Studio dev mode until Next 16.3 (docs/TECH_DEBT.md STU-11): `make build-studio`.
dev-admin: start ## Admin console on Vite at http://admin.localhost:8100 (Ctrl+C restores the built console)
	trap : INT TERM; $(call admin_route,admin-dev:5173) && \
	$(COMPOSE_DEV) up --no-deps --menu=false admin-dev | $(call announce,http://localhost:5173/,http://admin.localhost:8100/); \
	$(call admin_route,control-plane:3000); $(COMPOSE_DEV) rm -fs admin-dev

# ponytail: alias, dev-admin already starts the whole stack (built Studio included)
start-dev: dev-admin ## Start the stack, Studio at http://localhost:8100, with the admin console on Vite

typecheck: ## Typecheck every workspace package
	pnpm typecheck

test: ## Unit tests (stack running)
	pnpm --filter @platform/control-plane test

e2e: ## End-to-end suites, except Studio (stack running)
	pnpm e2e

e2e-studio: ## Studio end-to-end suite
	pnpm --filter @platform/control-plane e2e:studio

e2e-admin: ## Admin API and console end-to-end suites
	pnpm e2e:admin

test-edge: ## Edge main worker tests (Deno)
	cd apps/edge-main-worker && deno test --allow-read --allow-write

plugin: ## Install the Claude Code plugin from this checkout
	claude plugin marketplace add "$(CURDIR)"
	claude plugin install platform@platform-local

ifeq ($(shell uname -s),Darwin)
# Node does not resolve *.localhost on macOS (README, Prerequisites)
e2e e2e-studio e2e-admin: export NODE_OPTIONS += --import $(CURDIR)/packages/deploy-cli/src/localhost-dns.ts
endif
