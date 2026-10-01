#!/usr/bin/env bash
# Stops the m0bis stack and removes the studio.localhost Caddy route. The m0 stack is left untouched.
# --purge: also drops the Studio databases/roles, hands the app databases back to "postgres",
#          drops the app_<id>_owner roles and deletes data/ and apps/ (secrets).
source "$(dirname "$0")/lib.sh"
cd "$M0BIS_DIR"
curl -fsS -X DELETE "$CADDY_ADMIN/id/studio" >/dev/null 2>&1 || true
docker compose down --remove-orphans

if [ "${1:-}" = "--purge" ]; then
  for d in apps/*/; do
    APP=$(basename "$d"); OWNER="app_${APP}_owner"
    psql_admin "app_${APP}" -c "reassign owned by ${OWNER} to postgres; drop owned by ${OWNER};" || true
    psql_admin postgres -c "alter database app_${APP} owner to postgres; drop role if exists ${OWNER};" || true
  done
  psql_admin postgres <<'SQL'
drop database if exists studio_auth with (force);
drop database if exists studio_meta_default with (force);
drop role if exists studio_auth_admin;
drop role if exists studio_meta_default;
SQL
  rm -rf data apps .env
fi
