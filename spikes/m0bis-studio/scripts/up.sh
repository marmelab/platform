#!/usr/bin/env bash
# Starts the m0bis stack (Studio multi-head + shared postgres-meta + Studio GoTrue + forward-auth mock)
# on top of the running m0 stack, adds the studio.localhost route to Caddy and bootstraps the Studio admin.
source "$(dirname "$0")/lib.sh"
cd "$M0BIS_DIR"

docker inspect m0-db >/dev/null 2>&1 || { echo "m0 stack is not running (spikes/m0-tenancy/scripts/up.sh)"; exit 1; }

if [ ! -f .env ]; then
  node scripts/gen-env.mjs > .env
  chmod 600 .env
fi
set -a; . ./.env; set +a
mkdir -p data/studio data/snippets data/functions apps

echo "[m0bis] database roles"
psql_admin postgres -v meta_pw="$META_DEFAULT_PASSWORD" -v auth_pw="$STUDIO_AUTH_ADMIN_PASSWORD" < sql/bootstrap.sql
psql_admin studio_auth < sql/studio_auth.sql

echo "[m0bis] containers"
docker compose up -d
docker compose restart fwd-auth >/dev/null  # server.mjs is bind-mounted: pick up edits

echo "[m0bis] caddy route"
ROUTE=$(docker exec -i m0-caddy caddy adapt --adapter caddyfile --config /dev/stdin < caddy/studio.Caddyfile 2>/dev/null \
  | jq '.apps.http.servers.srv0.routes[0] + {"@id": "studio", "terminal": true}')
curl -fsS -X DELETE "$CADDY_ADMIN/id/studio" >/dev/null 2>&1 || true
echo "$ROUTE" | curl -fsS -X POST "$CADDY_ADMIN/id/apps/handle/0/routes" -H 'Content-Type: application/json' -d @- >/dev/null

echo "[m0bis] waiting for Studio"
fwd_login
for _ in $(seq 1 120); do
  code=$(fwd_curl -o /dev/null -w '%{http_code}' "$STUDIO_URL/api/self-hosted/bootstrap" || true)
  [ "$code" = 200 ] && break
  sleep 2
done
fwd_curl -fsS "$STUDIO_URL/api/self-hosted/bootstrap" >/dev/null || { docker logs --tail 40 m0bis-studio; exit 1; }

echo "[m0bis] Studio admin"
# Create the admin on first run, then always realign its password (and email confirmation) with .env:
# bootstrap is a no-op once an admin exists, so a regenerated .env would otherwise leave a stale password.
if fwd_curl -fsS "$STUDIO_URL/api/self-hosted/bootstrap" | grep -q '"bootstrapped":false'; then
  fwd_curl -fsS -X POST "$STUDIO_URL/api/self-hosted/bootstrap" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg email "$STUDIO_ADMIN_EMAIL" --arg password "$STUDIO_ADMIN_PASSWORD" '{$email, $password}')" >/dev/null
fi
ADMIN_ID=$(gotrue_admin "$STUDIO_URL/auth/v1/admin/users" \
  | jq -r --arg email "$STUDIO_ADMIN_EMAIL" '.users[] | select(.email == $email) | .id')
[ -n "$ADMIN_ID" ] || { echo "Studio admin $STUDIO_ADMIN_EMAIL not found in studio_auth"; exit 1; }
gotrue_admin -X PUT "$STUDIO_URL/auth/v1/admin/users/$ADMIN_ID" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg password "$STUDIO_ADMIN_PASSWORD" '{$password, email_confirm: true}')" >/dev/null

echo "[m0bis] login check"
TOKEN=$(studio_token || true)
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] || { echo "Studio login failed for STUDIO_ADMIN_EMAIL"; exit 1; }
cat <<EOF2
[m0bis] ready: $STUDIO_URL
  1. Platform SSO (mock):  FWD_AUTH_USER / FWD_AUTH_PASSWORD from .env
  2. Studio sign-in:       STUDIO_ADMIN_EMAIL / STUDIO_ADMIN_PASSWORD from .env
EOF2
