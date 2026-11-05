#!/usr/bin/env bash
# Usage: PLATFORM_PREVIEW_TOKEN=<create_preview_token token> preview.sh <preview url> <local Supabase API url>
#        (from the app's root; both URLs from create_preview_token and `supabase status -o env`)
# Serves the app of a Claude Code session on the web, which has no port forwarding, through the platform's preview
# tunnel. Idempotent: run it again after a container restart. Prints the URL once the tunnel is up, LOCAL outside a
# session on the web, OLD_VITE_CONFIG (merge the template's vite.config.ts) or NO_TUNNEL (logs in
# ~/.platform-preview/<subdomain>/). Never prints or writes the token.
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
# an app made before the preview keeps its old vite.config (init-app.sh never overwrites)
grep -qs PREVIEW_SUPABASE_API vite.config.* || {
  echo "vite.config does not read PREVIEW_SUPABASE_API: merge the template's vite.config.ts" >&2
  echo OLD_VITE_CONFIG
  exit 1
}
command -v frpc > /dev/null || { echo "frpc is not installed (the environment's setup script installs it)" >&2; echo NO_TUNNEL; exit 1; }

origin="$("$(dirname "${BASH_SOURCE[0]}")/../../deploy/scripts/platform-url.sh")"
origin="${origin%/mcp}"
server="${origin#*://}"
case "$origin" in https://*) protocol=wss port=443 ;; *) protocol=websocket port=80 ;; esac
[[ "$server" == *:* ]] && port="${server##*:}"
server="${server%%:*}"

dir="$HOME/.platform-preview/$subdomain"
mkdir -p "$dir"
# stop <name> <pattern>: the previous run's process group, unless a container restart gave its pid to another process
stop() {
  local pid
  pid="$(cat "$dir/$1.pid" 2> /dev/null)" || return 0
  if ps -p "$pid" -o args= 2> /dev/null | grep -q -- "$2"; then kill -- "-$pid" 2> /dev/null || true; fi
  rm -f "$dir/$1.pid"
}
stop vite "--port 5173"
stop frpc "$dir/frpc.toml"

# the browser reaches the API through the preview host (vite.config.ts relays it)
touch .env.local
grep -vE '^(VITE_SUPABASE_URL|PREVIEW_SUPABASE_API)=' .env.local > "$dir/env" || true
{ cat "$dir/env"; echo "VITE_SUPABASE_URL=$url"; echo "PREVIEW_SUPABASE_API=$api"; } > .env.local

cat > "$dir/frpc.toml" << EOF
serverAddr = "$server"
serverPort = $port
transport.protocol = "$protocol"
loginFailExit = false
# frps checks the token again at each ping (deploy/frps/frps.toml)
transport.heartbeatInterval = 30
metadatas.token = "{{ .Envs.PLATFORM_PREVIEW_TOKEN }}"

[[proxies]]
name = "$subdomain"
type = "http"
localIP = "127.0.0.1"
localPort = 5173
subdomain = "$subdomain"
EOF

# frp takes the sandbox's proxy from `http_proxy` only (lowercase), websockets included. Read at each run: its port
# changes when the sandbox restarts.
setsid nohup npm run dev -- --host 127.0.0.1 --port 5173 --strictPort < /dev/null > "$dir/vite.log" 2>&1 &
echo $! > "$dir/vite.pid"
http_proxy="${HTTPS_PROXY:-${https_proxy:-}}" setsid nohup frpc -c "$dir/frpc.toml" < /dev/null > "$dir/frpc.log" 2>&1 &
echo $! > "$dir/frpc.pid"

# the preview URL itself requires a sign-in: check frpc's log and the dev server instead
for _ in $(seq 45); do
  sleep 2
  if grep -qs "start proxy success" "$dir/frpc.log" &&
    [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:5173/)" = 200 ]; then
    echo "$url"
    exit 0
  fi
done
echo NO_TUNNEL
exit 1
