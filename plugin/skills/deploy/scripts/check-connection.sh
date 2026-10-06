#!/usr/bin/env bash
# Usage: check-connection.sh [--after-auth-error]
# Why Claude cannot use the platform, in one word (step 0 of the deploy skill): OK, NOT_SIGNED_IN (Claude Code is not
# signed in to the platform yet), ACCOUNT_REFUSED (the platform refuses the account: disabled, or its access revoked)
# or UNREACHABLE (network, VPN, platform down), on stdout; the API URL it checked on stderr, for the admin. Never
# prints a token.
# --after-auth-error: the platform tools were rejected after working (Claude Code then needs to sign in again): with a
# browser sign-in, only an admin's revocation or a disabled account does that.
set -uo pipefail
url="${PLATFORM_URL:-http://api.localhost:8100/mcp}"
origin="$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')"
after_auth_error=false
[ "${1:-}" = "--after-auth-error" ] && after_auth_error=true
echo "api: $url" >&2

status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$origin/.well-known/oauth-protected-resource/mcp")"
if [ "$status" != "200" ]; then echo UNREACHABLE; exit 1; fi

if [ -n "${PLATFORM_TOKEN:-}" ]; then
  # personal access token (admins, scripts): ask whoami with it, the header read from stdin (not in the process list)
  status="$(printf 'Authorization: Bearer %s' "$PLATFORM_TOKEN" | curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H @- -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' "$url")"
  case "$status" in
    200) echo OK; exit 0 ;;
    401|403) echo ACCOUNT_REFUSED; exit 1 ;;
    *) echo UNREACHABLE; exit 1 ;;
  esac
fi

if $after_auth_error; then echo ACCOUNT_REFUSED; else echo NOT_SIGNED_IN; fi
exit 1
