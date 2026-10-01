#!/usr/bin/env bash
# RAM of the m0bis containers + Postgres connections opened by Studio/pg-meta.
source "$(dirname "$0")/lib.sh"
date
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' m0bis-studio m0bis-meta m0bis-auth m0bis-fwd-auth
psql_admin postgres -c "select usename, datname, count(*) from pg_stat_activity where usename like 'app_%_owner' or usename like 'studio%' group by 1, 2 order by 1"
