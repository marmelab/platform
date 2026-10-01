#!/usr/bin/env bash
# Builds template_supabase by cloning the image's "postgres" database (identical to
# what `supabase start` gives), then applies sql/template.sql. Idempotent.
source "$(dirname "$0")/lib.sh"

if [ "$(psql_admin postgres -tAc "select count(*) from pg_database where datname='template_supabase'")" = "1" ]; then
  echo "template_supabase already exists"
  exit 0
fi

# CREATE DATABASE ... TEMPLATE requires no other session on the source database.
# pg_net and pg_cron keep a background worker connected to "postgres": block new
# connections, terminate them, clone, then re-open (both workers restart by themselves).
psql_admin template1 <<'SQL'
alter database postgres allow_connections false;
select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = 'postgres';
select pg_sleep(0.5);
create database template_supabase template postgres;
alter database postgres allow_connections true;
SQL

psql_admin template_supabase < "$M0_DIR/sql/template.sql"

psql_admin template1 <<'SQL'
revoke all on database template_supabase from public;
alter database template_supabase is_template true allow_connections false;
SQL
echo "template_supabase created"
