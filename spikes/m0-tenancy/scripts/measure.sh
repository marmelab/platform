#!/usr/bin/env bash
# Snapshot of memory per container (docker stats) and Postgres connections per app.
source "$(dirname "$0")/lib.sh"

echo "## docker stats"
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' \
  $(docker ps -q --filter "label=com.docker.compose.project=m0") | sort

echo
echo "## connections per database / role"
psql_admin postgres -P pager=off <<'SQL'
select coalesce(datname, '(none)') as datname, coalesce(usename, '(bg)') as usename,
       backend_type, count(*) as conns,
       count(*) filter (where state = 'idle') as idle
from pg_stat_activity
where pid <> pg_backend_pid()
group by 1, 2, 3 order by 1, 2, 3;
select count(*) filter (where backend_type = 'client backend') as client_conns,
       count(*) as all_backends,
       current_setting('max_connections') as max_connections
from pg_stat_activity where pid <> pg_backend_pid();
SQL

echo
echo "## database sizes"
psql_admin postgres -P pager=off -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database order by 1"
