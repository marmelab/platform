#!/usr/bin/env bash
# Exercises the Studio API (the same endpoints the UI calls) for every registered app and checks
# that each project ref reaches its own database. Output: results/check-api.txt
source "$(dirname "$0")/lib.sh"
fwd_login
STUDIO_TOKEN=$(studio_token)
q() { # q <ref> <sql>
  jq -n --arg q "$2" '{query: $q}' | studio_curl -s -X POST "$STUDIO_URL/api/platform/pg-meta/$1/query" -H 'Content-Type: application/json' -d @-
}
code() { studio_curl -s -o /tmp/m0bis-body -w '%{http_code}' "$@"; echo " $(head -c 220 /tmp/m0bis-body)"; }

for f in "$M0BIS_DIR"/apps/*/studio.json; do
  APP=$(jq -r .app "$f"); REF=$(jq -r .studio_ref "$f")
  echo "=== $APP (ref $REF)"
  echo "-- identity:        $(q "$REF" 'select current_user, current_database()' | jq -c .)"
  echo "-- tables (query):  $(q "$REF" "select string_agg(tablename, ',') t from pg_tables where schemaname='public'" | jq -c .)"
  echo "-- tables (pg-meta GET /tables): $(code "$STUDIO_URL/api/platform/pg-meta/$REF/tables?included_schemas=public")"
  echo "-- policies GET:    $(code "$STUDIO_URL/api/platform/pg-meta/$REF/policies?included_schemas=public")"
  echo "-- todos count:     $(q "$REF" 'select count(*) from public.todos' | jq -c .)"
  echo "-- auth.users (SQL, Studio users page): $(q "$REF" 'select count(*) n, string_agg(email, chr(44)) from auth.users' | jq -c .)"
  echo "-- databases list:  $(q "$REF" "select string_agg(datname, ',') from pg_database" | jq -c .)"
  echo "-- app roles seen:  $(q "$REF" "select string_agg(rolname, ',') from pg_roles where rolname like 'app_%'" | jq -c .)"
  echo "-- connect other DB via dblink-free check: $(q "$REF" "select has_database_privilege('app_app2','connect') app2, has_database_privilege('app_app1','connect') app1" | jq -c .)"
  echo "-- set role postgres: $(q "$REF" 'set role postgres' | jq -c .)"
  echo "-- auth users API:  $(code "$STUDIO_URL/api/platform/auth/$REF/users")"
  echo "-- storage buckets: $(code "$STUDIO_URL/api/platform/storage/$REF/buckets")"
  echo "-- functions:       $(code "$STUDIO_URL/api/v1/projects/$REF/functions")"
  echo "-- logs:            $(code "$STUDIO_URL/api/platform/projects/$REF/analytics/endpoints/logs.all?sql=select%201")"
  echo "-- settings:        $(code "$STUDIO_URL/api/platform/projects/$REF/settings")"
  # the browser receives the app's service_role key in clear: print only its claims
  echo "-- api keys (temp): $(studio_curl -s -X POST "$STUDIO_URL/api/platform/projects/$REF/api-keys/temporary" | jq -r .api_key | cut -d. -f2 | base64 -d 2>/dev/null)"
done
echo "=== unknown ref"
echo "-- query on ref 'nope': $(q nope 'select current_user, current_database()' | jq -c .)"
echo "-- query on ref 'default': $(q default 'select current_user, current_database()' | jq -c .)"
echo "=== Studio API without Studio login (forward-auth cookie only)"
echo "-- GET projects:     $(fwd_curl -s -o /dev/null -w '%{http_code}' "$STUDIO_URL/api/platform/projects")"
REF1=$(jq -r .studio_ref "$M0BIS_DIR/apps/app1/studio.json")
echo "-- POST query app1:  $(fwd_curl -s -w ' %{http_code}' -X POST "$STUDIO_URL/api/platform/pg-meta/$REF1/query" -H 'Content-Type: application/json' -d '{"query":"select current_user"}')"
echo "-- POST import (empty body): $(fwd_curl -s -w ' %{http_code}' -X POST "$STUDIO_URL/api/platform/projects/import" -H 'Content-Type: application/json' -d '{}')"
echo "=== without forward auth"
echo "-- POST query app1:  $(curl -s -w ' %{http_code}' -X POST "$STUDIO_URL/api/platform/pg-meta/$REF1/query" -H 'Content-Type: application/json' -d '{"query":"select current_user"}')"
echo "=== writes on app1 (what the table editor / policy editor / user dialog send)"
echo "-- update row:      $(q "$REF1" "update public.todos set title = title where id = (select min(id) from public.todos) returning id" | jq -c .)"
echo "-- create table:    $(q "$REF1" "create table if not exists public.studio_probe (id int primary key, note text); alter table public.studio_probe enable row level security" | jq -c .)"
echo "-- grants via default privileges: $(q "$REF1" "select string_agg(grantee || ':' || privilege_type, ',') from information_schema.role_table_grants where table_name = 'studio_probe' and grantee in ('anon','authenticated','service_role') and privilege_type = 'SELECT'" | jq -c .)"
echo "-- create policy:   $(q "$REF1" "create policy probe_read on public.studio_probe for select to authenticated using (true)" | jq -c .)"
echo "-- drop table:      $(q "$REF1" "drop table public.studio_probe" | jq -c .)"
echo "-- create auth user (POST /api/platform/auth/<ref>/users): $(code -X POST "$STUDIO_URL/api/platform/auth/$REF1/users" -H 'Content-Type: application/json' -d '{"email":"studio-probe@app1.test","password":"probe-password-1","email_confirm":true}')"
echo "-- create role:     $(q "$REF1" "create role studio_probe_role" | jq -c .)"
