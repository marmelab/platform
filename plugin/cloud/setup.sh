#!/usr/bin/env bash
# Setup script of the platform's claude.ai cloud environment (INSTALL.md §7), served with this platform's URL in place
# of the local stack's:
#   curl -fsSL https://api.<domain>/plugin/cloud-setup.sh | bash
# Runs as root before Claude starts; claude.ai caches the result for about a week. Steps only warn on failure: a
# failing setup script would block every session.
set -uo pipefail
mcp="${PLATFORM_URL:-http://api.localhost:8100/mcp}"
# pinned by sha256, as a release asset can be replaced; on a bump, from the release's checksums or GitHub's API
FRP_VERSION=0.71.1
FRP_SHA256=1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803
SUPABASE_VERSION=2.122.0
SUPABASE_SHA256=119a0f7123f381846f80cf3c4efe96cffb943db55b747177c411f2ac705a5942
warn() { echo "platform setup: $1 failed" >&2; }
fetch() { curl -fsSL -o "$3" "$1" && echo "$2  $3" | sha256sum -c --quiet; }
work="$(mktemp -d)"

# frpc: the preview tunnel's client (preview.sh)
{ fetch "https://github.com/fatedier/frp/releases/download/v$FRP_VERSION/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
  "$FRP_SHA256" "$work/frp.tar.gz" && tar -xzf "$work/frp.tar.gz" -C "$work" &&
  install -m 755 "$work/frp_${FRP_VERSION}_linux_amd64/frpc" /usr/local/bin/frpc; } || warn frpc

# Supabase CLI: the preview's local database and API
{ fetch "https://github.com/supabase/cli/releases/download/v$SUPABASE_VERSION/supabase_${SUPABASE_VERSION}_linux_amd64.deb" \
  "$SUPABASE_SHA256" "$work/supabase.deb" && dpkg -i "$work/supabase.deb" > /dev/null; } || warn "the Supabase CLI"

{ claude plugin marketplace add "${mcp%/mcp}/plugin/marketplace.json" && claude plugin install platform@platform; } ||
  warn "the platform plugin"

rm -rf "$work"
exit 0
