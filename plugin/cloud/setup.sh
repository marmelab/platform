#!/usr/bin/env bash
# Setup script of the claude.ai cloud environment of the platform's builders (Claude Code on the web, INSTALL.md §7),
# served by each platform with its own URL in place of the local stack's. The environment's setup script is one line:
#   curl -fsSL https://api.<domain>/plugin/cloud-setup.sh | bash
# It runs as root before Claude starts, and claude.ai caches its result (a snapshot of the disk, about a week, or until
# the environment changes). Each step only warns when it fails: a failing setup script would block every session.
set -uo pipefail
mcp="${PLATFORM_URL:-http://api.localhost:8100/mcp}"
FRP_VERSION=0.71.1
SUPABASE_VERSION=2.122.0
warn() { echo "platform setup: $1 failed" >&2; }
work="$(mktemp -d)"

# frpc: the preview tunnel's client (build skill, preview.sh)
{ curl -fsSL "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/frp_${FRP_VERSION}_linux_amd64.tar.gz" |
  tar -xz -C "$work" && install -m 755 "$work/frp_${FRP_VERSION}_linux_amd64/frpc" /usr/local/bin/frpc; } || warn frpc

# Supabase CLI: the preview's local database and API (build skill)
{ curl -fsSL -o "$work/supabase.deb" \
  "https://github.com/supabase/cli/releases/download/v$SUPABASE_VERSION/supabase_${SUPABASE_VERSION}_linux_amd64.deb" &&
  dpkg -i "$work/supabase.deb" > /dev/null; } || warn "the Supabase CLI"

# the platform plugin (skills), from the marketplace this platform serves
{ claude plugin marketplace add "${mcp%/mcp}/plugin/marketplace.json" && claude plugin install platform@platform; } ||
  warn "the platform plugin"

rm -rf "$work"
exit 0
