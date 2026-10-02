#!/usr/bin/env bash
# Dev installer: generates secrets, builds Studio, starts the "plat" stack, initialises the cluster
# (template_supabase + platform database) and creates the first admin with a PAT and a Studio password.
# Re-runnable: secrets and the admin credentials are kept in deploy/.env and deploy/.env.local.
#   STUDIO_BUILD=1 deploy/install.sh    rebuilds the Studio image even if it exists
#   deploy/install.sh --seed (or SEED=1) also seeds the app builders alice and bob and their example apps
#                                        (apps/control-plane/scripts/seed.ts, idempotent)
set -euo pipefail
cd "$(dirname "$0")"

SEED="${SEED:-0}"
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    *) echo "usage: deploy/install.sh [--seed]" >&2; exit 1 ;;
  esac
done

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
API_URL="http://api.localhost:8100"
STUDIO_URL="http://studio.localhost:8100"

umask 077
touch .env
add_secret() {
  grep -q "^$1=" .env || { echo "$1=$(openssl rand -hex "$2")" >> .env; echo "secret $1 generated in deploy/.env"; }
}
add_secret POSTGRES_PASSWORD 16
add_secret PLATFORM_MASTER_KEY 32
add_secret PLATFORM_GATEWAY_TOKEN 32
add_secret PLATFORM_EDGE_ADMIN_TOKEN 32
add_secret PLATFORM_STUDIO_HEADER_SECRET 32
add_secret PLATFORM_STUDIO_CONFIG_TOKEN 32
add_secret PG_META_CRYPTO_KEY 32
add_secret STUDIO_META_DEFAULT_PASSWORD 16
# Local installs: builders may still deploy from their machine with their PAT (the e2e suites, the seed and the
# deploy skill rely on it). Production installs should use DIRECT_DEPLOY=admins (publishing through CI only).
grep -q '^DIRECT_DEPLOY=' .env || { echo "DIRECT_DEPLOY=everyone" >> .env; echo "DIRECT_DEPLOY=everyone written to deploy/.env"; }
umask 022

if [ "${STUDIO_BUILD:-0}" = 1 ] || ! docker image inspect plat/studio:dev >/dev/null 2>&1; then
  ../apps/studio/build.sh
fi

docker compose -p plat up -d --build

echo -n "waiting for the control plane"
for _ in $(seq 1 120); do
  if curl -fsS "$API_URL/health" >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."
  sleep 1
done
curl -fsS "$API_URL/health" >/dev/null || { echo; docker logs --tail 50 plat-control-plane; exit 1; }

docker exec plat-control-plane node src/cli.ts init

umask 077
touch .env.local
if ! grep -q '^PLATFORM_TOKEN=' .env.local; then
  TOKEN="$(docker exec plat-control-plane node src/cli.ts create-user "$ADMIN_EMAIL" admin install)"
  {
    echo "PLATFORM_URL=$API_URL/mcp"
    echo "PLATFORM_ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "PLATFORM_TOKEN=$TOKEN"
  } >> .env.local
  echo "Admin $ADMIN_EMAIL created, personal access token saved in deploy/.env.local (PLATFORM_TOKEN)"
fi
if ! grep -q '^PLATFORM_ADMIN_PASSWORD=' .env.local; then
  ADMIN_EMAIL_SAVED="$(sed -n 's/^PLATFORM_ADMIN_EMAIL=//p' .env.local)"
  PASSWORD="$(docker exec plat-control-plane node src/cli.ts set-password "${ADMIN_EMAIL_SAVED:-$ADMIN_EMAIL}" --generate)"
  echo "PLATFORM_ADMIN_PASSWORD=$PASSWORD" >> .env.local
  echo "Studio password of the admin saved in deploy/.env.local (PLATFORM_ADMIN_PASSWORD)"
fi
echo
echo "MCP endpoint: $API_URL/mcp  (Authorization: Bearer \$PLATFORM_TOKEN)"
echo "Studio:       $STUDIO_URL  (admin: PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD from deploy/.env.local)"

if [ "$SEED" = 1 ]; then
  node ../apps/control-plane/scripts/seed.ts
fi
