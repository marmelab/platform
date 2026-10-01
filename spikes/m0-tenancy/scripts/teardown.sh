#!/usr/bin/env bash
# Removes every app and the shared stack. --purge also deletes the Postgres/Caddy data.
cd "$(dirname "$0")/.."
source scripts/lib.sh

for dir in apps/*/; do
  [ -d "$dir" ] || continue
  app="$(basename "$dir")"
  scripts/delete-app.sh "$app" || true
done
# app containers whose local folder is already gone
docker ps -aq --filter "label=com.docker.compose.project=m0" --filter "label=platform.app" | xargs -r docker rm -f >/dev/null

docker compose down
if [ "${1:-}" = "--purge" ]; then
  rm -rf data .env
  echo "data purged"
fi
