#!/usr/bin/env bash
# Usage: build.sh <supabase_url> <anon_key>  (run from the project root)
# Installs dependencies if needed, then runs `npm run build` with VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
set -euo pipefail
url="${1:?usage: build.sh <supabase_url> <anon_key>}"
key="${2:?missing anon_key}"
[ -f package.json ] || { echo "package.json not found: run from the project root" >&2; exit 1; }
if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
fi
VITE_SUPABASE_URL="$url" VITE_SUPABASE_ANON_KEY="$key" npm run build
[ -f dist/index.html ] || { echo "build did not produce dist/index.html" >&2; exit 1; }
