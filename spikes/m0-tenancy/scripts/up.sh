#!/usr/bin/env bash
# Starts the shared stack (Postgres + Caddy) and prepares the cluster.
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" > .env
fi
mkdir -p data sites
docker compose up -d
source scripts/lib.sh
wait_for_db
psql_admin postgres < sql/bootstrap.sql
scripts/init-template.sh
