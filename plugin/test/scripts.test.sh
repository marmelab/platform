#!/usr/bin/env bash
# Checks the plugin's skills without the platform: every script a SKILL.md references exists and runs from a copy of
# the plugin with its symlinks resolved (as the plugin cache does), every MCP tool it names exists, and the helper
# scripts behave. The direct deployment itself runs against the stack in apps/control-plane/test/plugin.e2e.test.ts.
# Usage: plugin/test/scripts.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }
check() { local name="$1"; shift; if "$@" > "$tmp/out" 2>&1; then pass "$name"; else fail "$name"; cat "$tmp/out" >&2; fi; }
refuses() { local name="$1" pattern="$2"; shift 2; if "$@" > "$tmp/out" 2>&1; then fail "$name (accepted)"; cat "$tmp/out" >&2; elif grep -qE "$pattern" "$tmp/out"; then pass "$name"; else fail "$name"; cat "$tmp/out" >&2; fi; }

# 1. A copy of the plugin with symlinks resolved (deploy-cli, assets/platform.yml): what an installed plugin sees
plugin="$tmp/plugin"
cp -RL "$ROOT/plugin" "$plugin"
check "deploy-cli is shipped in the plugin" test -f "$plugin/deploy-cli/main.ts"
check "workflow template is shipped in the plugin" grep -q "YOUR-ORG/platform/.github/workflows/deploy.yml@main" "$plugin/skills/deploy/assets/platform.yml"

# 2. Every ${CLAUDE_PLUGIN_ROOT}/... path of the skills exists, and scripts are executable
for skill in "$plugin"/skills/*/SKILL.md; do
  name="$(basename "$(dirname "$skill")")"
  for path in $(grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[A-Za-z0-9_./-]+' "$skill" | sed 's/^\${CLAUDE_PLUGIN_ROOT}//' | sed 's/\*$//' | sort -u); do
    target="$plugin$path"
    if [ -d "$target" ] || [ -x "$target" ]; then pass "$name references $path"; else fail "$name references $path: missing or not executable"; fi
  done
done

# 3. Every MCP tool named in the skills is registered by the control plane
tools="$(tr '\n' ' ' < "$ROOT/apps/control-plane/src/mcp.ts" | grep -oE 'registerTool\(\s*"[a-z_]+"' | grep -oE '"[a-z_]+"' | tr -d '"' | sort -u)"
# backticked snake_case words that are fields or options, not tools
fields="direct_deploy direct_deploy_setting api_url github_org github_repo default_branch studio_url last_release
  admin_exception schema_drift since_minutes repository_id required_approving_review_count
  email_confirmation_effective redirect_urls callback_url service_role user_metadata shadow_port email_confirm"
for skill in "$plugin"/skills/*/SKILL.md; do
  name="$(basename "$(dirname "$skill")")"
  for word in $(grep -oE '`[a-z]+(_[a-z]+)+`' "$skill" | tr -d '`' | sort -u); do
    if grep -qx "$word" <<< "$tools"; then pass "$name calls $word"
    elif grep -qw "$word" <<< "$fields"; then :
    else fail "$name names $word: not an MCP tool of the control plane (or add it to the fields list)"; fi
  done
done

# 4. platform-deploy wrapper: runs the shipped CLI with a deploy token or a PAT, refuses to run without either
scripts="$plugin/skills/deploy/scripts"
check "platform-deploy --help (copied plugin)" bash -c "PLATFORM_TOKEN=x '$scripts/platform-deploy' --help 2>&1 | grep -q 'Usage: platform-deploy'"
check "platform-deploy accepts a deploy token" bash -c "env -u PLATFORM_TOKEN PLATFORM_DEPLOY_TOKEN=x '$scripts/platform-deploy' --help 2>&1 | grep -q 'Usage: platform-deploy'"
refuses "platform-deploy without a token" "no platform token" env -u PLATFORM_TOKEN -u PLATFORM_DEPLOY_TOKEN "$scripts/platform-deploy" check

# 4b. MCP server: the PAT, when PLATFORM_TOKEN is set, goes in X-Platform-Token (empty otherwise); a static
# Authorization header would disable the browser sign-in (OAuth)
check ".mcp.json sends PLATFORM_TOKEN in X-Platform-Token" grep -q '"X-Platform-Token": "${PLATFORM_TOKEN:-}"' "$plugin/.mcp.json"
check ".mcp.json has no Authorization header" bash -c "! grep -qi authorization '$plugin/.mcp.json'"

# 4c. check-connection.sh, against a fake platform (OAuth metadata, and /mcp accepting one PAT)
port_file="$tmp/port"
node -e '
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/oauth-protected-resource/mcp") return res.end("{}");
    if (req.url === "/mcp" && req.method === "POST") {
      res.statusCode = req.headers.authorization === "Bearer plat_good" ? 200 : 401;
      return res.end("{}");
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1", () => require("node:fs").writeFileSync(process.argv[1], String(server.address().port)));
' "$port_file" &
fake=$!
trap 'kill $fake 2> /dev/null; wait $fake 2> /dev/null || true; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [ -s "$port_file" ] && break; sleep 0.1; done
fake_url="http://127.0.0.1:$(cat "$port_file")/mcp"
# expect <word> <PLATFORM_TOKEN value, or ""> [script argument]
expect() {
  local word="$1" token="$2"; shift 2
  env -u PLATFORM_TOKEN PLATFORM_URL="$fake_url" ${token:+PLATFORM_TOKEN="$token"} "$scripts/check-connection.sh" "$@" > "$tmp/word" 2> "$tmp/api"
  test "$(cat "$tmp/word")" = "$word" && test "$(cat "$tmp/api")" = "api: $fake_url"
}
check "check-connection.sh: not signed in" expect NOT_SIGNED_IN ""
check "check-connection.sh: refused after an auth error" expect ACCOUNT_REFUSED "" --after-auth-error
check "check-connection.sh: PAT accepted" expect OK plat_good
check "check-connection.sh: PAT refused" expect ACCOUNT_REFUSED plat_revoked
check "check-connection.sh never prints the token" bash -c "! grep -q plat_ '$tmp/word' '$tmp/api'"
check "check-connection.sh: unreachable" bash -c "test \"\$(env -u PLATFORM_TOKEN PLATFORM_URL=http://127.0.0.1:9/mcp '$scripts/check-connection.sh' 2> /dev/null)\" = UNREACHABLE"

# 5. function-secrets.sh
app="$tmp/app"
mkdir -p "$app/supabase/functions/hello" "$app/supabase/functions/_shared"
cat > "$app/supabase/functions/hello/index.ts" <<'TS'
const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get('STRIPE_KEY');
const greeting = Deno.env.get(`GREETING`) ?? "hi";
TS
echo 'export const x = Deno.env.get("SHARED_TOKEN");' > "$app/supabase/functions/_shared/util.ts"
check "function-secrets.sh lists the secrets to set" bash -c "cd '$app' && test \"\$('$scripts/function-secrets.sh' | tr '\n' ' ')\" = 'GREETING SHARED_TOKEN STRIPE_KEY '"
check "function-secrets.sh without functions" bash -c "cd '$tmp' && test -z \"\$('$scripts/function-secrets.sh')\""

# 6. install-workflow.sh
uses="acme/platform/.github/workflows/deploy.yml@v1"
check "install-workflow.sh writes the caller" bash -c "cd '$app' && '$scripts/install-workflow.sh' '$uses' trunk"
check "caller calls the allowed workflow" grep -qx "    uses: $uses" "$app/.github/workflows/platform.yml"
check "caller deploys from the default branch" grep -q "branches: \[trunk\]" "$app/.github/workflows/platform.yml"
check "caller asks for an OIDC token" grep -q "id-token: write" "$app/.github/workflows/platform.yml"
check "caller has no placeholder left" bash -c "! grep -q YOUR-ORG '$app/.github/workflows/platform.yml'"
echo "# custom" > "$tmp/custom.yml"
cp "$tmp/custom.yml" "$app/.github/workflows/platform.yml"
check "install-workflow.sh never overwrites" bash -c "cd '$app' && '$scripts/install-workflow.sh' '$uses' main && cmp -s '$tmp/custom.yml' .github/workflows/platform.yml"
refuses "install-workflow.sh rejects an invalid reference" "invalid workflow reference" bash -c "cd '$tmp' && '$scripts/install-workflow.sh' 'acme/platform@main; rm -rf /' main"
if command -v actionlint > /dev/null; then
  rm "$app/.github/workflows/platform.yml"
  (cd "$app" && "$scripts/install-workflow.sh" "$uses" main > /dev/null)
  check "actionlint accepts the caller" actionlint "$app/.github/workflows/platform.yml"
fi

# 7. admin-deploy preflight.sh: clean tree, pushed commit, linked repository
preflight="$plugin/skills/admin-deploy/scripts/preflight.sh"
git() { command git -c user.email=test@example.com -c user.name=test -c init.defaultBranch=main "$@"; }
git init -q --bare "$tmp/acme/app.git"
git clone -q "$tmp/acme/app.git" "$tmp/checkout" 2> /dev/null
cd "$tmp/checkout"
echo '{ "app": "demo" }' > .platform.json
git add .platform.json
git commit -qm init
refuses "preflight refuses an unpushed commit" "is not on the remote" "$preflight"
git push -q origin main 2> /dev/null
check "preflight accepts a pushed commit" "$preflight"
check "preflight accepts the linked repository" "$preflight" acme/app
refuses "preflight refuses another repository" "no remote points to the linked repository" "$preflight" acme/other
echo change >> .platform.json
refuses "preflight refuses a modified file" "uncommitted changes" "$preflight"
git checkout -q .platform.json
touch untracked.txt
refuses "preflight refuses an untracked file" "uncommitted changes" "$preflight"
rm untracked.txt
mkdir sub
refuses "preflight must run from the repository root" "repository root" bash -c "cd sub && '$preflight'"
cd "$tmp"
refuses "preflight outside a git checkout" "not a git checkout" "$preflight"

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed" >&2; exit 1; fi
echo "all checks passed"
