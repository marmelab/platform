#!/usr/bin/env bash
# Creates app_<id>_owner for an app provisioned by spikes/m0-tenancy and registers the app in
# multi-head Studio through POST /api/platform/projects/import (external mode, no containers).
# Usage: scripts/register-app.sh <app_id>     (idempotent: re-running re-imports only if absent)
source "$(dirname "$0")/lib.sh"
APP="${1:?usage: register-app.sh <app_id>}"
[[ "$APP" =~ ^[a-z][a-z0-9]{1,20}$ ]] || { echo "invalid app id"; exit 1; }
OWNER="app_${APP}_owner"
APP_ENV="$M0_DIR/apps/$APP/.env"
[ -f "$APP_ENV" ] || { echo "unknown app $APP (no $APP_ENV)"; exit 1; }

mkdir -p "$M0BIS_DIR/apps/$APP"
OWNER_ENV="$M0BIS_DIR/apps/$APP/.env"
if [ ! -f "$OWNER_ENV" ]; then
  echo "OWNER_PASSWORD=$(openssl rand -hex 16)" > "$OWNER_ENV"
  chmod 600 "$OWNER_ENV"
fi
set -a; . "$APP_ENV"; . "$OWNER_ENV"; set +a

echo "[$APP] role $OWNER"
psql_admin postgres -v app="$APP" -v owner="$OWNER" -v pw="$OWNER_PASSWORD" < "$M0BIS_DIR/sql/owner.sql"
psql_admin "app_${APP}" -v owner="$OWNER" < "$M0BIS_DIR/sql/owner-db.sql"

fwd_login
EXISTING=$(studio_curl -fsS "$STUDIO_URL/api/platform/projects" | jq -r --arg n "$APP" '.projects[] | select(.name == $n) | .ref')
if [ -n "$EXISTING" ]; then
  echo "[$APP] already registered: ref $EXISTING"
  REF="$EXISTING"
else
  echo "[$APP] import into Studio"
  BODY=$(jq -n --arg name "$APP" --arg url "http://${APP}.localhost:8080" --arg db "app_${APP}" \
    --arg user "$OWNER" --arg pw "$OWNER_PASSWORD" --arg anon "$ANON_KEY" --arg svc "$SERVICE_ROLE_KEY" --arg jwt "$JWT_SECRET" \
    '{name: $name, public_url: $url, db_host: "db", db_port: 5432, db_user: $user, db_name: $db,
      db_password: $pw, anon_key: $anon, service_key: $svc, jwt_secret: $jwt}')
  REF=$(echo "$BODY" | studio_curl -fsS -X POST "$STUDIO_URL/api/platform/projects/import" \
    -H 'Content-Type: application/json' -d @- | jq -r .ref)
fi
# pg-meta connection for the patched proxy routes (see patch/Dockerfile): same AES format as
# crypto-js AES.encrypt(conn, PG_META_CRYPTO_KEY), i.e. OpenSSL "Salted__" + EVP_BytesToKey(MD5)
CONN="postgresql://${OWNER}:${OWNER_PASSWORD}@db:5432/app_${APP}"
ENC=$(printf '%s' "$CONN" | openssl enc -aes-256-cbc -md md5 -salt -a -A -pass pass:"$PG_META_CRYPTO_KEY" 2>/dev/null)
PROJECTS="$M0BIS_DIR/data/studio/projects.json"
jq --arg ref "$REF" --arg enc "$ENC" 'map(if .ref == $ref then . + {pg_meta_conn: $enc} else . end)' "$PROJECTS" > "$PROJECTS.tmp"
mv "$PROJECTS.tmp" "$PROJECTS"

jq -n --arg app "$APP" --arg ref "$REF" --arg owner "$OWNER" \
  '{app: $app, studio_ref: $ref, db_user: $owner, studio_url: "http://studio.localhost:8080/project/\($ref)"}' > "$M0BIS_DIR/apps/$APP/studio.json"
echo "[$APP] Studio project: $STUDIO_URL/project/$REF"
