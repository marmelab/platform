#!/usr/bin/env bash
# Usage: install-workflow.sh <uses> <default_branch>  (run from the project root)
# Writes .github/workflows/platform.yml, the caller of the platform's reusable deploy workflow, from the plugin's
# template (ci/examples/platform.yml). <uses> is whoami's ci.uses. Never overwrites an existing file.
set -euo pipefail
uses="${1:?usage: install-workflow.sh <uses> <default_branch>}"
branch="${2:?missing default_branch}"
[[ "$uses" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml@[A-Za-z0-9_./-]+$ ]] ||
  { echo "invalid workflow reference: $uses" >&2; exit 2; }
[[ "$branch" =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "invalid branch: $branch" >&2; exit 2; }
out=.github/workflows/platform.yml
if [ -e "$out" ]; then echo "$out already exists: left unchanged" >&2; exit 0; fi
template="$(dirname "${BASH_SOURCE[0]}")/../assets/platform.yml"
mkdir -p .github/workflows
sed -e "s|uses: YOUR-ORG/platform/.github/workflows/deploy.yml@main|uses: $uses|" \
    -e "s|branches: \[main\]|branches: [$branch]|" \
    -e "/# replace YOUR-ORG\/platform/d" "$template" > "$out"
grep -q "uses: $uses" "$out" || { rm -f "$out"; echo "template mismatch: $template" >&2; exit 1; }
echo "$out"
