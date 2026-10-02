#!/usr/bin/env bash
# Reproducible M1 run: generate state, (re)start the stack, run the integration tests.
# FRESH=1 also wipes the Deno module cache volume.
set -euo pipefail
cd "$(dirname "$0")"

deno run -A setup.ts "${APPS:-2}"
if [[ "${FRESH:-0}" == "1" ]]; then docker compose -p m1 down -v --remove-orphans; fi
docker compose -p m1 up -d controlplane
docker compose -p m1 exec -T controlplane sh -euc \
  'rm -rf /functions/* /config/apps/*; cp -a /src/functions/. /functions/; cp /src/config/apps/*.json /config/apps/'
docker compose -p m1 up -d --force-recreate edge caddy
deno test -A ../../apps/edge-main-worker/main_test.ts
deno test -A test.ts
