#!/usr/bin/env bash
# Provisions an app on the shared stack (PLAN_1 §4.2, steps 1-3 and 6):
#   per-app LOGIN roles, database cloned from template_supabase, GoTrue + PostgREST
#   containers, Caddy route added through the admin JSON API.
# Usage: scripts/create-app.sh <app_id>     (idempotent: re-running reuses the secrets)
source "$(dirname "$0")/lib.sh"

APP="${1:?usage: create-app.sh <app_id>}"
check_app_id "$APP"

DB="app_${APP}"
AUTHENTICATOR="app_${APP}_authenticator"
AUTH_ADMIN="app_${APP}_auth_admin"
APP_DIR="$M0_DIR/apps/$APP"
HOST="${APP}.localhost"
PUBLIC_URL="http://${HOST}:8080"
GOTRUE_IMAGE=supabase/gotrue:v2.196.0
POSTGREST_IMAGE=postgrest/postgrest:v14.17
PGRST_POOL="${PGRST_POOL:-3}"
GOTRUE_POOL="${GOTRUE_POOL:-3}"
# PostgREST is built with -N (one GHC capability per CPU): ~90 MB on a 10-CPU host. -N2 gives ~32 MB.
PGRST_GHCRTS="${PGRST_GHCRTS:--N2}"

# 1. secrets ---------------------------------------------------------------
mkdir -p "$APP_DIR"
if [ ! -f "$APP_DIR/.env" ]; then
  node "$M0_DIR/scripts/gen-keys.mjs" "$APP" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi
set -a
# shellcheck disable=SC1091
. "$APP_DIR/.env"
set +a

# 2. roles + database -----------------------------------------------------
echo "[$APP] roles"
psql_admin postgres <<SQL
set client_min_messages = warning;
select 'create role ${AUTHENTICATOR}'
  where not exists (select from pg_roles where rolname = '${AUTHENTICATOR}') \gexec
select 'create role ${AUTH_ADMIN}'
  where not exists (select from pg_roles where rolname = '${AUTH_ADMIN}') \gexec

-- PostgREST login role: same shape as the image's "authenticator"
alter role ${AUTHENTICATOR} with login noinherit nocreaterole nocreatedb connection limit 20 password '${AUTHENTICATOR_PASSWORD}';
grant anon, authenticated, service_role to ${AUTHENTICATOR};
alter role ${AUTHENTICATOR} set session_preload_libraries = supautils, safeupdate;
alter role ${AUTHENTICATOR} set statement_timeout = '8s';
alter role ${AUTHENTICATOR} set lock_timeout = '8s';

-- GoTrue login role: same shape as "supabase_auth_admin" but WITHOUT createrole
alter role ${AUTH_ADMIN} with login noinherit nocreaterole nocreatedb connection limit 20 password '${AUTH_ADMIN_PASSWORD}';
alter role ${AUTH_ADMIN} set search_path = auth;
alter role ${AUTH_ADMIN} set idle_in_transaction_session_timeout = 60000;
alter role ${AUTH_ADMIN} set log_statement = none;

select 'create database ${DB} template template_supabase owner postgres'
  where not exists (select from pg_database where datname = '${DB}') \gexec

revoke all on database ${DB} from public;
grant connect, temporary on database ${DB} to ${AUTHENTICATOR};
grant connect on database ${DB} to ${AUTH_ADMIN};
SQL

echo "[$APP] auth schema ownership"
psql_admin "$DB" <<SQL
-- The template (cloned from the image) has auth.* owned by the global supabase_auth_admin.
-- GoTrue must own them to run its migrations: hand them to the app's own auth role.
reassign owned by supabase_auth_admin to ${AUTH_ADMIN};
drop owned by supabase_auth_admin;
drop owned by supabase_storage_admin;
grant usage, create on schema auth to ${AUTH_ADMIN};
SQL

# 3. containers -----------------------------------------------------------
run_container() {
  local name="$1" service="$2"
  shift 2
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network "$NETWORK" --restart unless-stopped \
    --label "platform.app=$APP" --label "platform.service=$service" \
    --label "com.docker.compose.project=m0" \
    --memory 256m "$@" >/dev/null
}

echo "[$APP] gotrue"
run_container "m0-${APP}-auth" gotrue \
  -e GOTRUE_API_HOST=0.0.0.0 \
  -e GOTRUE_API_PORT=9999 \
  -e API_EXTERNAL_URL="${PUBLIC_URL}/auth/v1" \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://${AUTH_ADMIN}:${AUTH_ADMIN_PASSWORD}@db:5432/${DB}?sslmode=disable" \
  -e GOTRUE_DB_MAX_POOL_SIZE="$GOTRUE_POOL" \
  -e GOTRUE_SITE_URL="$PUBLIC_URL" \
  -e GOTRUE_URI_ALLOW_LIST="${PUBLIC_URL}/**" \
  -e GOTRUE_DISABLE_SIGNUP=false \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role \
  -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_JWT_EXP=3600 \
  -e GOTRUE_JWT_ISSUER="${PUBLIC_URL}/auth/v1" \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" \
  -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  -e GOTRUE_MAILER_AUTOCONFIRM=true \
  -e GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false \
  -e GOTRUE_EXTERNAL_PHONE_ENABLED=false \
  "$GOTRUE_IMAGE" auth

echo "[$APP] postgrest"
run_container "m0-${APP}-rest" postgrest \
  -e PGRST_DB_URI="postgres://${AUTHENTICATOR}:${AUTHENTICATOR_PASSWORD}@db:5432/${DB}" \
  -e PGRST_DB_SCHEMAS=public,graphql_public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_DB_POOL="$PGRST_POOL" \
  -e PGRST_DB_USE_LEGACY_GUCS=false \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_APP_SETTINGS_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_APP_SETTINGS_JWT_EXP=3600 \
  -e PGRST_ADMIN_SERVER_PORT=3001 \
  -e GHCRTS="$PGRST_GHCRTS" \
  "$POSTGREST_IMAGE"

# 4. static placeholder ----------------------------------------------------
mkdir -p "$M0_DIR/sites/$APP"
[ -f "$M0_DIR/sites/$APP/index.html" ] || echo "<!doctype html><title>${APP}</title><h1>${APP}</h1>" > "$M0_DIR/sites/$APP/index.html"

# 6. caddy route (admin JSON API, no reload) ---------------------------------
echo "[$APP] caddy route"
ROUTE_ID="app-${APP}"
curl -fsS -X DELETE "$CADDY_ADMIN/id/$ROUTE_ID" >/dev/null 2>&1 || true
curl -fsS -X POST "$CADDY_ADMIN/id/apps/handle/0/routes" \
  -H 'Content-Type: application/json' -d @- <<JSON
{
  "@id": "${ROUTE_ID}",
  "match": [{ "host": ["${HOST}"] }],
  "terminal": true,
  "handle": [{
    "handler": "subroute",
    "routes": [
      {
        "match": [{ "path": ["/auth/v1/*"] }],
        "handle": [
          { "handler": "rewrite", "strip_path_prefix": "/auth/v1" },
          { "handler": "reverse_proxy", "upstreams": [{ "dial": "m0-${APP}-auth:9999" }] }
        ]
      },
      {
        "match": [{ "path": ["/rest/v1/*"] }],
        "handle": [
          { "handler": "rewrite", "strip_path_prefix": "/rest/v1" },
          { "handler": "reverse_proxy", "upstreams": [{ "dial": "m0-${APP}-rest:3000" }] }
        ]
      },
      {
        "handle": [
          { "handler": "rewrite", "uri": "{http.matchers.file.relative}" },
          { "handler": "file_server", "root": "/sites/${APP}" }
        ],
        "match": [{ "file": { "root": "/sites/${APP}", "try_files": ["{http.request.uri.path}", "/index.html"] } }]
      }
    ]
  }]
}
JSON

# wait for both services through the public origin
for _ in $(seq 1 60); do
  if curl -fsS "$PUBLIC_URL/auth/v1/health" >/dev/null 2>&1 \
    && curl -fsS "$PUBLIC_URL/rest/v1/" -H "apikey: $ANON_KEY" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$PUBLIC_URL/auth/v1/health" >/dev/null || { echo "[$APP] gotrue not healthy"; docker logs --tail 30 "m0-${APP}-auth"; exit 1; }

cat > "$APP_DIR/app.json" <<JSON
{
  "id": "${APP}",
  "url": "${PUBLIC_URL}",
  "database": "${DB}",
  "roles": { "authenticator": "${AUTHENTICATOR}", "auth_admin": "${AUTH_ADMIN}" },
  "containers": ["m0-${APP}-auth", "m0-${APP}-rest"],
  "caddy_route_id": "${ROUTE_ID}",
  "anon_key": "${ANON_KEY}"
}
JSON
echo "[$APP] ready: $PUBLIC_URL (secrets in apps/$APP/.env)"
