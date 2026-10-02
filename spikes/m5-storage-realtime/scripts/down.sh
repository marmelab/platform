#!/usr/bin/env bash
# Removes everything scripts/up.sh created: containers, volume, spike databases and roles (the platform's own
# platform_storage / platform_realtime roles and supabase_realtime_admin are kept: the platform uses them since M5).
set -euo pipefail
cd "$(dirname "$0")/.."
docker rm -f m5-storage m5-realtime m5-caddy >/dev/null 2>&1 || true
docker volume rm m5-storage-data >/dev/null 2>&1 || true
psql() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' plat-db psql -v ON_ERROR_STOP=1 -U supabase_admin -h localhost -q -d postgres "$@"; }
psql <<'SQL'
select format('drop database %I with (force)', datname) from pg_database
  where datname like 'spike\_%' \gexec
select format('revoke set on parameter log_min_messages from %I', rolname) from pg_roles
  where rolname ~ '^app_(m5[a-z]|s[0-9]+)_realtime$' \gexec
select format('drop role %I', rolname) from pg_roles
  where rolname ~ '^app_(m5[a-z]|s[0-9]+)_(owner|storage_admin|realtime)$' or rolname in ('spike_realtime_migrator', 'spike_storage', 'spike_realtime') \gexec
SQL
echo "spike removed"
