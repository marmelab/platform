#!/usr/bin/env bash
# Usage: pack.sh frontend|functions  (run from the project root)
# Prints the path of a .tar.gz ready to upload.
set -euo pipefail
kind="${1:?usage: pack.sh frontend|functions}"
out="$(mktemp -t "platform-${kind}.XXXXXX").tar.gz"
export COPYFILE_DISABLE=1

case "$kind" in
  frontend)
    [ -f dist/index.html ] || { echo "dist/index.html not found: run the build first" >&2; exit 1; }
    tar -czf "$out" -C dist .
    ;;
  functions)
    [ -d supabase/functions ] || { echo "supabase/functions not found" >&2; exit 1; }
    paths=(supabase/functions)
    [ -f supabase/config.toml ] && paths+=(supabase/config.toml)
    tar -czf "$out" --exclude node_modules --exclude .env --exclude '.env.*' "${paths[@]}"
    ;;
  *)
    echo "unknown kind: $kind (frontend|functions)" >&2
    exit 1
    ;;
esac

echo "$out"
