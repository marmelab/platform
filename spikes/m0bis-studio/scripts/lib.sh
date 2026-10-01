#!/usr/bin/env bash
set -euo pipefail

M0BIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
M0_DIR="$(cd "$M0BIS_DIR/../m0-tenancy" && pwd)"
CADDY_ADMIN="${CADDY_ADMIN:-http://localhost:2020}"
DB_CONTAINER=m0-db
STUDIO_HOST=studio.localhost
STUDIO_URL="http://${STUDIO_HOST}:8080"

set -a
# shellcheck disable=SC1091
[ -f "$M0BIS_DIR/.env" ] && . "$M0BIS_DIR/.env"
set +a

psql_admin() {
  local db="${1:-postgres}"
  shift || true
  docker exec -i "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d "$db" "$@"
}

COOKIE_JAR="$M0BIS_DIR/data/fwd-auth.cookies"

# Forward-auth session (cookie). Basic auth is also accepted by the mock but it occupies the
# Authorization header, which Studio needs for its own Bearer token.
fwd_login() {
  mkdir -p "$M0BIS_DIR/data"
  curl -fsS -o /dev/null -c "$COOKIE_JAR" -X POST "$STUDIO_URL/_sso/login" \
    --data-urlencode "user=$FWD_AUTH_USER" --data-urlencode "password=$FWD_AUTH_PASSWORD"
}

# curl through Caddy with the forward-auth cookie only (no Studio login)
fwd_curl() {
  curl -sS -b "$COOKIE_JAR" "$@"
}

# Studio dashboard token (Studio's own GoTrue, password grant)
studio_token() {
  fwd_curl -fsS -X POST "$STUDIO_URL/auth/v1/token?grant_type=password" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$STUDIO_ADMIN_EMAIL\",\"password\":\"$STUDIO_ADMIN_PASSWORD\"}" | jq -r .access_token
}

# curl through Caddy + forward auth + Studio login
studio_curl() {
  [ -n "${STUDIO_TOKEN:-}" ] || STUDIO_TOKEN=$(studio_token)
  fwd_curl -H "Authorization: Bearer $STUDIO_TOKEN" "$@"
}
