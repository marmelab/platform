#!/usr/bin/env bash
set -euo pipefail

M0_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CADDY_ADMIN="${CADDY_ADMIN:-http://localhost:2020}"
NETWORK=m0
DB_CONTAINER=m0-db

set -a
# shellcheck disable=SC1091
[ -f "$M0_DIR/.env" ] && . "$M0_DIR/.env"
set +a

# psql as the cluster superuser, inside the db container.
psql_admin() {
  local db="${1:-postgres}"
  shift || true
  docker exec -i "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U supabase_admin -d "$db" "$@"
}

wait_for_db() {
  for _ in $(seq 1 60); do
    if docker exec "$DB_CONTAINER" pg_isready -U postgres -h localhost >/dev/null 2>&1; then
      # the image restarts postgres once after init: make sure we reach the final instance
      if psql_admin postgres -tAc 'select 1' >/dev/null 2>&1; then return 0; fi
    fi
    sleep 1
  done
  echo "database not ready" >&2
  return 1
}

check_app_id() {
  if [[ ! "$1" =~ ^[a-z][a-z0-9]{1,20}$ ]]; then
    echo "invalid app id '$1' (expected ^[a-z][a-z0-9]{1,20}\$)" >&2
    exit 1
  fi
}
