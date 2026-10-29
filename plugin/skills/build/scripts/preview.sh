#!/usr/bin/env bash
# Usage: PLATFORM_PREVIEW_TOKEN=<create_preview_token token> preview.sh <preview url> <local Supabase API url>
#        (from the app's root; both URLs from create_preview_token and `supabase status -o env`)
# The app preview of a Claude Code session on the web, which has no port forwarding: starts the dev server and frpc,
# which serves it through the platform's preview tunnel at <preview url> (https://preview-<slug>.<domain>). The dev
# server also relays the local Supabase API on that host (PREVIEW_SUPABASE_API, vite.config.ts). Idempotent: run it
# again after a container restart (every process is gone, files stay). Prints the URL once it answers, LOCAL outside a
# session on the web (use the local preview), or NO_TUNNEL (the logs are in ~/.platform-preview/<subdomain>/). Never
# prints or writes the token.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = true ] || { echo LOCAL; exit 0; }
url="${1:?usage: preview.sh <preview url> <local Supabase API url>}"
api="${2:?usage: preview.sh <preview url> <local Supabase API url>}"
[ -n "${PLATFORM_PREVIEW_TOKEN:-}" ] || { echo "PLATFORM_PREVIEW_TOKEN is not set: call create_preview_token" >&2; exit 2; }
[ -f package.json ] || { echo "run it from the app's root" >&2; exit 2; }
host="${url#*://}"
host="${host%%[:/]*}"
subdomain="${host%%.*}"
[[ "$subdomain" =~ ^preview-[a-z][a-z0-9-]{1,30}[a-z0-9]$ ]] || { echo "not a preview URL: $url" >&2; exit 2; }
command -v frpc > /dev/null || { echo "frpc is not installed (the environment's setup script installs it)" >&2; echo NO_TUNNEL; exit 1; }

# the tunnel server: the platform's API host, over a websocket (TLS on HTTPS platforms)
origin="$("$(dirname "${BASH_SOURCE[0]}")/../../deploy/scripts/platform-url.sh")"
origin="${origin%/mcp}"
server="${origin#*://}"
case "$origin" in https://*) protocol=wss port=443 ;; *) protocol=websocket port=80 ;; esac
[[ "$server" == *:* ]] && port="${server##*:}"
server="${server%%:*}"

dir="$HOME/.platform-preview/$subdomain"
mkdir -p "$dir"
# stop <name> <pattern>: the previous run's process group (setsid below), if its leader is still that process (after
# a container restart, the pid may be another one's)
stop() {
  local pid
  pid="$(cat "$dir/$1.pid" 2> /dev/null)" || return 0
  if ps -p "$pid" -o args= 2> /dev/null | grep -q -- "$2"; then kill -- "-$pid" 2> /dev/null || true; fi
  rm -f "$dir/$1.pid"
}
stop vite "--port 5173"
stop frpc "$dir/frpc.toml"

# the browser reaches the app and its API on the preview host; the other .env.local lines (anon key) are kept
touch .env.local
grep -vE '^(VITE_SUPABASE_URL|PREVIEW_SUPABASE_API)=' .env.local > "$dir/env" || true
{ cat "$dir/env"; echo "VITE_SUPABASE_URL=$url"; echo "PREVIEW_SUPABASE_API=$api"; } > .env.local

cat > "$dir/frpc.toml" << EOF
serverAddr = "$server"
serverPort = $port
transport.protocol = "$protocol"
loginFailExit = false
metadatas.token = "{{ .Envs.PLATFORM_PREVIEW_TOKEN }}"

[[proxies]]
name = "$subdomain"
type = "http"
localIP = "127.0.0.1"
localPort = 5173
subdomain = "$subdomain"
EOF

# detached (setsid, no stdin): they outlive this command. frpc reaches the platform through the sandbox's proxy, read
# again at each run (its port changes when the sandbox restarts): frp takes it from `http_proxy` (lowercase only) and
# uses it for websockets too
setsid nohup npm run dev -- --host 127.0.0.1 --port 5173 --strictPort < /dev/null > "$dir/vite.log" 2>&1 &
echo $! > "$dir/vite.pid"
http_proxy="${HTTPS_PROXY:-${https_proxy:-}}" setsid nohup frpc -c "$dir/frpc.toml" < /dev/null > "$dir/frpc.log" 2>&1 &
echo $! > "$dir/frpc.pid"

for _ in $(seq 45); do
  sleep 2
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url/")" = 200 ]; then echo "$url"; exit 0; fi
done
echo NO_TUNNEL
exit 1
