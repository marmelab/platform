#!/usr/bin/env bash
# Usage: run.sh <workdir> <out.jsonl> <prompt> [extra claude args...]
set -uo pipefail
ROOT=/Users/francois/Documents/git/platform
work="$1"; out="$2"; prompt="$3"; shift 3
set -a; . "$ROOT/deploy/.env.local"; set +a
unset PLATFORM_URL
export ENABLE_CLAUDEAI_MCP_SERVERS=false
SCRIPTS="$ROOT/plugin/skills/deploy/scripts"
cd "$work"
start=$(date +%s)
perl -e 'alarm shift; exec @ARGV' 900 claude -p "$prompt" \
  --plugin-dir "$ROOT/plugin" \
  --setting-sources project,local \
  --output-format stream-json --verbose \
  --allowedTools "mcp__plugin_platform_platform__*" "Bash(npm *)" "Bash(npx *)" "Bash(tar *)" "Bash(curl *)" "Bash(git *)" "Bash($SCRIPTS/*)" "Bash(ls *)" "Bash(cat *)" "Bash(grep *)" "Read" "Edit" "Write" "Glob" "Grep" "Skill" \
  "$@" > "$out" 2> "${out%.jsonl}.stderr"
code=$?
echo "exit=$code duration=$(( $(date +%s) - start ))s"
