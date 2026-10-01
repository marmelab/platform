#!/usr/bin/env bash
# Usage: migrations.sh  (run from the project root)
# Prints supabase/migrations/<version>_<name>.sql as the JSON array expected by apply_migrations.
set -euo pipefail
dir=supabase/migrations
[ -d "$dir" ] || { echo "[]"; exit 0; }
node -e '
const fs = require("node:fs");
const dir = process.argv[1];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const out = [];
for (const file of files) {
  const m = /^(\d+)_(.+)\.sql$/.exec(file);
  if (!m) { console.error(`ignored (not <version>_<name>.sql): ${file}`); continue; }
  out.push({ version: m[1], name: m[2], sql: fs.readFileSync(`${dir}/${file}`, "utf8") });
}
console.log(JSON.stringify(out, null, 2));
' "$dir"
