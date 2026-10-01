#!/usr/bin/env bash
# Symmetric of create-app.sh: Caddy route, containers, database, roles, local secrets.
source "$(dirname "$0")/lib.sh"

APP="${1:?usage: delete-app.sh <app_id>}"
check_app_id "$APP"

curl -fsS -X DELETE "$CADDY_ADMIN/id/app-${APP}" >/dev/null 2>&1 || true
docker ps -aq --filter "label=platform.app=${APP}" | xargs -r docker rm -f >/dev/null

psql_admin postgres <<SQL
drop database if exists app_${APP} with (force);
drop role if exists app_${APP}_authenticator;
drop role if exists app_${APP}_auth_admin;
SQL

rm -rf "$M0_DIR/apps/$APP" "$M0_DIR/sites/$APP"
echo "[$APP] deleted"
