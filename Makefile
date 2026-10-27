COMPOSE := docker compose -p plat -f deploy/docker-compose.yml
COMPOSE_DEV := $(COMPOSE) -f deploy/docker-compose.dev.yml
# the Studio dev container writes .next/dev into the checkout
export DEV_USER := $(shell id -u):$(shell id -g)

.DEFAULT_GOAL := help
.PHONY: help deps install seed start stop ps logs cli build-control-plane build-studio dev dev-admin dev-studio \
	typecheck test e2e e2e-studio e2e-admin test-edge plugin

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

deps: ## Install the workspace dependencies
	pnpm install

install: deps ## Install or update the local stack (safe to rerun)
	deploy/install.sh

seed: deps ## Install the local stack with sample users and apps
	deploy/install.sh --seed

start: ## Start the stack
	$(COMPOSE) start

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

dev: ## Hot reload for Studio and the admin console (Ctrl+C stops both)
	@$(MAKE) --no-print-directory -j2 dev-studio dev-admin

dev-admin: ## Admin console on Vite, /api proxied to the stack (password login only)
	pnpm --filter @platform/admin dev --clearScreen false

# Ctrl+C stops the dev container; `trap :` keeps the shell alive to put the built Studio back.
dev-studio: ## Studio on next dev at http://studio.localhost:8100 (Ctrl+C restores the built Studio)
	trap : INT TERM; $(COMPOSE_DEV) up --no-deps studio; $(COMPOSE) up -d --no-deps studio

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
