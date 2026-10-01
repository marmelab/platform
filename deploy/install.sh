#!/usr/bin/env bash
# Dev installer: generates secrets, starts the "plat" stack, initialises the cluster
# (template_supabase + platform database) and creates the first admin with a PAT.
# Re-runnable: secrets and the admin token are kept in deploy/.env and deploy/.env.local.
set -euo pipefail
cd "$(dirname "$0")"

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
API_URL="http://api.localhost:8100"

if [ ! -f .env ]; then
  umask 077
  cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 16)
PLATFORM_MASTER_KEY=$(openssl rand -hex 32)
PLATFORM_GATEWAY_TOKEN=$(openssl rand -hex 32)
PLATFORM_EDGE_ADMIN_TOKEN=$(openssl rand -hex 32)
ENV
  echo "secrets generated in deploy/.env"
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

if ! grep -q '^PLATFORM_TOKEN=' .env.local 2>/dev/null; then
  TOKEN="$(docker exec plat-control-plane node src/cli.ts create-user "$ADMIN_EMAIL" admin install)"
  umask 077
  {
    echo "PLATFORM_URL=$API_URL/mcp"
    echo "PLATFORM_ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "PLATFORM_TOKEN=$TOKEN"
  } > .env.local
  echo
  echo "Admin $ADMIN_EMAIL created. Personal access token (shown once, also saved in deploy/.env.local):"
  echo "  $TOKEN"
fi
echo
echo "MCP endpoint: $API_URL/mcp  (Authorization: Bearer \$PLATFORM_TOKEN)"
