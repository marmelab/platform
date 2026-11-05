#!/usr/bin/env bash
# Usage: init-app.sh <slug> [<uses> <default_branch>]  (run from the project root)
# Writes the platform's app template into the current project, missing files only (never overwrites), and prints
# each file written:
#   app/      the skeleton of a new app, only when there is no package.json yet
#   project/  CLAUDE.md, the target architecture, on any project
#   ci/       with <uses> (whoami's ci.uses) and the default branch: the caller workflow .github/workflows/platform.yml,
#             and .claude/settings.json, which offers the platform plugin to whoever opens the repository
set -euo pipefail
slug="${1:?usage: init-app.sh <slug> [<uses> <default_branch>]}"
uses="${2:-}"
branch=""
[[ "$slug" =~ ^[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] || { echo "invalid slug: $slug" >&2; exit 2; }
layers=(project)
[ -e package.json ] || layers=(app project)
if [ -n "$uses" ]; then
  branch="${3:?missing default_branch}"
  [[ "$uses" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml@[A-Za-z0-9_./-]+$ ]] ||
    { echo "invalid workflow reference: $uses" >&2; exit 2; }
  [[ "$branch" =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "invalid branch: $branch" >&2; exit 2; }
  layers+=(ci)
fi
template="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# the marketplace the platform serves next to its MCP endpoint
mcp_url="$("$template/../skills/deploy/scripts/platform-url.sh")"
marketplace="${mcp_url%/mcp}/plugin/marketplace.json"
for layer in "${layers[@]}"; do
  (cd "$template/$layer" && find . -type f | sort) | while read -r file; do
    file="${file#./}"
    if [ -e "$file" ]; then echo "$file already exists: left unchanged" >&2; continue; fi
    mkdir -p "$(dirname "$file")"
    sed -e "s|__APP__|$slug|g" -e "s|__USES__|$uses|g" -e "s|__BRANCH__|$branch|g" -e "s|__MARKETPLACE__|$marketplace|g" \
      -e "s|__PLATFORM_URL__|${mcp_url%/mcp}|g" \
      "$template/$layer/$file" > "$file"
    echo "$file"
  done
done
