#!/usr/bin/env bash
# M5 spike: shared multi-tenant Storage API and Realtime next to the running "plat" stack (deploy/install.sh).
# Creates two spike tenants (databases spike_<id> cloned from template_supabase, with per-tenant roles), the metadata
# databases of both services, starts m5-storage, m5-realtime and m5-caddy on the plat network, registers the tenants.
# Secrets are generated into .env (gitignored). Idempotent. Teardown: scripts/down.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

STORAGE_IMAGE=${STORAGE_IMAGE:-supabase/storage-api:v1.74.0}
REALTIME_IMAGE=${REALTIME_IMAGE:-supabase/realtime:v2.134.10}
TENANTS=${TENANTS:-"m5a m5b"}

rand() { openssl rand -hex "$1"; }
if [ ! -f .env ]; then
  {
    echo "STORAGE_META_PASSWORD=$(rand 16)"
    echo "REALTIME_META_PASSWORD=$(rand 16)"
    echo "STORAGE_ADMIN_KEY=$(rand 24)"
    echo "STORAGE_ENCRYPTION_KEY=$(rand 16)"
    echo "REALTIME_API_JWT_SECRET=$(rand 32)"
    echo "REALTIME_DB_ENC_KEY=$(rand 8)"
    echo "REALTIME_SECRET_KEY_BASE=$(rand 32)"
    echo "REALTIME_MIGRATOR_PASSWORD=$(rand 16)"
  } > .env
  chmod 600 .env
fi
for t in $TENANTS; do
  grep -q "^${t}_JWT_SECRET=" .env || {
    echo "${t}_JWT_SECRET=$(rand 32)"
    echo "${t}_OWNER_PASSWORD=$(rand 16)"
    echo "${t}_STORAGE_PASSWORD=$(rand 16)"
    echo "${t}_REALTIME_PASSWORD=$(rand 16)"
  } >> .env
done
set -a; . ./.env; set +a

psql() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' plat-db psql -v ON_ERROR_STOP=1 -U supabase_admin -h localhost -q "$@"; }

# --- metadata databases (one per service, owned by a dedicated platform role) ---
psql -d postgres <<SQL
select 'create role spike_storage' where not exists (select from pg_roles where rolname = 'spike_storage') \gexec
alter role spike_storage with login nosuperuser nocreatedb nocreaterole connection limit 20 password '${STORAGE_META_PASSWORD}';
select 'create database spike_storage_meta owner spike_storage' where not exists (select from pg_database where datname = 'spike_storage_meta') \gexec
revoke all on database spike_storage_meta from public;
select 'create role spike_realtime' where not exists (select from pg_roles where rolname = 'spike_realtime') \gexec
alter role spike_realtime with login nosuperuser nocreatedb nocreaterole connection limit 30 password '${REALTIME_META_PASSWORD}';
select 'create database spike_realtime_meta owner spike_realtime' where not exists (select from pg_database where datname = 'spike_realtime_meta') \gexec
revoke all on database spike_realtime_meta from public;
SQL
# Realtime's tenant migrations create (if missing) and GRANT the reserved role supabase_realtime_admin: superuser only.
# The spike creates the role once, and a superuser used only to register (and migrate) tenants.
psql -d postgres <<SQL
select 'create role supabase_realtime_admin noinherit nologin noreplication' where not exists (select from pg_roles where rolname = 'supabase_realtime_admin') \gexec
select 'create role spike_realtime_migrator' where not exists (select from pg_roles where rolname = 'spike_realtime_migrator') \gexec
alter role spike_realtime_migrator with login superuser connection limit 5 password '${REALTIME_MIGRATOR_PASSWORD}';
SQL
# Realtime's own migrations need their schema (created by the supabase/postgres image init in the official setup)
psql -d spike_realtime_meta -c "create schema if not exists _realtime authorization spike_realtime"

# --- tenants ---
for t in $TENANTS; do
  jwt=${t}_JWT_SECRET owner=${t}_OWNER_PASSWORD st=${t}_STORAGE_PASSWORD rt=${t}_REALTIME_PASSWORD
  psql -d postgres <<SQL
select 'create role app_${t}_owner' where not exists (select from pg_roles where rolname = 'app_${t}_owner') \gexec
alter role app_${t}_owner with login inherit connection limit 15 password '${!owner}';
grant anon, authenticated, service_role to app_${t}_owner with inherit false, set true;
-- Storage: like supabase_storage_admin (noinherit, member of the API roles: storage SET ROLEs to the JWT role)
select 'create role app_${t}_storage_admin' where not exists (select from pg_roles where rolname = 'app_${t}_storage_admin') \gexec
alter role app_${t}_storage_admin with login noinherit nocreaterole nocreatedb connection limit 20 password '${!st}';
grant anon, authenticated, service_role to app_${t}_storage_admin;
alter role app_${t}_storage_admin set search_path = storage;
-- Realtime: REPLICATION for logical decoding of its own database (pg_hba has no "replication" line: no physical
-- streaming), member of the API roles (RLS of postgres_changes and of realtime.messages are checked with SET ROLE)
select 'create role app_${t}_realtime' where not exists (select from pg_roles where rolname = 'app_${t}_realtime') \gexec
alter role app_${t}_realtime with login noinherit nocreaterole nocreatedb replication connection limit 20 password '${!rt}';
grant anon, authenticated, service_role to app_${t}_realtime;
-- owner of the realtime objects after the tenant migrations; list_changes() sets log_min_messages (superuser GUC)
grant supabase_realtime_admin to app_${t}_realtime with inherit true;
grant set on parameter log_min_messages to app_${t}_realtime;
select 'create database spike_${t} template template_supabase owner app_${t}_owner' where not exists (select from pg_database where datname = 'spike_${t}') \gexec
revoke all on database spike_${t} from public;
grant connect on database spike_${t} to app_${t}_storage_admin, app_${t}_realtime;
SQL
  psql -d "spike_${t}" <<SQL
alter schema public owner to app_${t}_owner;
drop owned by supabase_storage_admin;
-- storage.* : created by Storage's own migrations, run as app_<id>_storage_admin when the tenant is registered
alter schema storage owner to app_${t}_storage_admin;
grant usage on schema storage to anon, authenticated, service_role, app_${t}_owner;
-- the owner writes storage policies (create policy on storage.objects needs the table owner's privileges)
grant app_${t}_storage_admin to app_${t}_owner;
-- realtime.* : created by Realtime's tenant migrations, run as app_<id>_realtime
alter schema realtime owner to app_${t}_realtime;
grant usage on schema realtime to anon, authenticated, service_role, app_${t}_owner;
-- the owner adds its tables to the publication (alter publication ... add table needs the publication owner)
alter publication supabase_realtime owner to app_${t}_owner;
grant usage on schema auth to app_${t}_storage_admin, app_${t}_realtime;
-- no GoTrue in the spike: auth.uid() as GoTrue's migrations leave it (also reads request.jwt.claims, as Realtime sets)
create or replace function auth.uid() returns uuid language sql stable as \$\$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
\$\$;
SQL
done

# --- services ---
docker rm -f m5-storage m5-realtime m5-caddy >/dev/null 2>&1 || true
docker volume create m5-storage-data >/dev/null
docker run -d --name m5-storage --network plat --memory 512m -p 127.0.0.1:15001:5001 \
  -e IS_MULTITENANT=true \
  -e MULTITENANT_DATABASE_URL="postgres://spike_storage:${STORAGE_META_PASSWORD}@db:5432/spike_storage_meta" \
  -e ADMIN_API_KEYS="${STORAGE_ADMIN_KEY}" -e ENCRYPTION_KEY="${STORAGE_ENCRYPTION_KEY}" \
  -e REQUEST_X_FORWARDED_HOST_REGEXP='^([a-z][a-z0-9-]{1,30}[a-z0-9])$' \
  -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/var/lib/storage -e GLOBAL_S3_BUCKET=tenants \
  -e FILE_SIZE_LIMIT=52428800 -e REGION=local -e DATABASE_MAX_CONNECTIONS="${DATABASE_MAX_CONNECTIONS:-4}" \
  -e DATABASE_FREE_POOL_AFTER_INACTIVITY=60000 -e S3_PROTOCOL_ENABLED=false -e DB_INSTALL_ROLES=false \
  -e DB_SUPER_USER="${STORAGE_DB_SUPER_USER:-postgres}" \
  -e PG_QUEUE_ENABLE=false -e LOG_LEVEL=info -e NODE_OPTIONS="${STORAGE_NODE_OPTIONS:-}" \
  -v m5-storage-data:/var/lib/storage \
  --label platform.service=m5-storage "$STORAGE_IMAGE" >/dev/null
docker run -d --name m5-realtime --network plat --memory 1g -p 127.0.0.1:14000:4000 \
  -e PORT=4000 -e DB_HOST=db -e DB_PORT=5432 -e DB_USER=spike_realtime -e DB_PASSWORD="${REALTIME_META_PASSWORD}" \
  -e DB_NAME=spike_realtime_meta -e DB_AFTER_CONNECT_QUERY='SET search_path TO _realtime' -e DB_ENC_KEY="${REALTIME_DB_ENC_KEY}" \
  -e API_JWT_SECRET="${REALTIME_API_JWT_SECRET}" -e METRICS_JWT_SECRET="${REALTIME_API_JWT_SECRET}" -e SECRET_KEY_BASE="${REALTIME_SECRET_KEY_BASE}" \
  -e ERL_AFLAGS='-proto_dist inet_tcp' -e DNS_NODES="''" -e RLIMIT_NOFILE=10000 -e APP_NAME=realtime \
  -e SEED_SELF_HOST=false -e RUN_JANITOR=true -e DISABLE_HEALTHCHECK_LOGGING=true \
  --label platform.service=m5-realtime "$REALTIME_IMAGE" >/dev/null
docker run -d --name m5-caddy --network plat -p 127.0.0.1:8105:8105 \
  -v "$PWD/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" --label platform.service=m5-caddy caddy:2-alpine >/dev/null

wait_http() { for _ in $(seq 1 90); do docker exec plat-control-plane node -e "fetch('$1').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))" && return 0; sleep 1; done; echo "timeout $1"; return 1; }
wait_http http://m5-storage:5000/status
wait_http http://m5-realtime:4000/healthcheck

echo "services up; registering tenants"
node scripts/register.ts $TENANTS
