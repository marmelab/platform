#!/usr/bin/env bash
# Usage: function-secrets.sh  (run from the project root)
# Prints, one per line, the environment variables read by supabase/functions (Deno.env.get("NAME")) that the
# platform does not provide: compare them with list_secrets.
set -euo pipefail
dir=supabase/functions
[ -d "$dir" ] || exit 0
grep -rhoE --include='*.ts' --include='*.js' --include='*.tsx' --include='*.mjs' \
  "Deno\.env\.get\(\s*['\"\`][A-Za-z_][A-Za-z0-9_]*['\"\`]" "$dir" |
  sed -E "s/.*['\"\`]([A-Za-z_][A-Za-z0-9_]*)['\"\`]$/\1/" |
  grep -vxE 'SUPABASE_URL|SUPABASE_PUBLIC_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_URL' |
  sort -u || true
