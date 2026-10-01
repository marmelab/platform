# Spike patch: the pg-meta proxy routes (GET /tables, /policies, /types, ...) ignore the connection of
# projects imported in external mode (db_host) and fall back to pg-meta's DEFAULT database.
# This makes getPgMetaProxyConfig send the project's precomputed x-connection-encrypted header
# (field pg_meta_conn in projects.json, written by scripts/register-app.sh).
FROM ghcr.io/flamingrubberduck/supabase-studio-multi-head@sha256:24b2e1ba6ce1b6ed84266d5403d4af2a98ef941c066ef709a5b6d7e32a20ee89
RUN set -e; files=$(grep -rl 'getPgMetaProxyConfig' /app/apps/studio/.next/server); \
    for f in $files; do \
      sed -i 's|Authorization:`Bearer ${t.service_key}`}}}return{pgMetaBase:|Authorization:`Bearer ${t.service_key}`}};if(t?.db_host\&\&t?.pg_meta_conn)return{pgMetaBase:process.env.STUDIO_PG_META_URL,projectHeaders:{"x-connection-encrypted":t.pg_meta_conn}}}return{pgMetaBase:|' "$f"; \
    done; \
    test "$(grep -rl 'pg_meta_conn' /app/apps/studio/.next/server | wc -l)" -ge 20
