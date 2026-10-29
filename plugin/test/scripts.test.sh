#!/usr/bin/env bash
# Checks the plugin's skills without the platform: every script a SKILL.md references exists and runs from a copy of
# the plugin (as the plugin cache does), every MCP tool it names exists, and the helper scripts behave. The direct deployment itself runs against the stack in apps/control-plane/test/plugin.e2e.test.ts.
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

# 1. A copy of the plugin: what an installed plugin sees. Real files only: a git marketplace ships no symlink
plugin="$tmp/plugin"
cp -R "$ROOT/plugin" "$plugin"
check "plugin has no symlink" test -z "$(find "$ROOT/plugin" -type l)"
check "deploy-cli and its action are shipped in the plugin" test -f "$plugin/deploy-cli/main.ts" -a -f "$plugin/deploy-cli/action.yml"
check "plugin version is the platform version" grep -qF "\"version\": \"$(tr -d '[:space:]' < "$ROOT/VERSION")\"" "$plugin/.claude-plugin/plugin.json"
check "workflow template is shipped in the plugin" grep -q "uses: __USES__" "$plugin/template/ci/.github/workflows/platform.yml"

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
  email_confirmation_effective redirect_urls callback_url service_role user_metadata shadow_port email_confirm
  claude_code_url"
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
check "check-connection.sh: connector not connected (web)" env CLAUDE_CODE_REMOTE=true bash -c "$(declare -f expect); scripts='$scripts' tmp='$tmp' fake_url='$fake_url' expect NOT_CONNECTED_WEB ''"
check "check-connection.sh: refused after an auth error" expect ACCOUNT_REFUSED "" --after-auth-error
check "check-connection.sh: PAT accepted" expect OK plat_good
check "check-connection.sh: PAT refused" expect ACCOUNT_REFUSED plat_revoked
check "check-connection.sh never prints the token" bash -c "! grep -q plat_ '$tmp/word' '$tmp/api'"
check "check-connection.sh: unreachable" bash -c "test \"\$(env -u PLATFORM_TOKEN PLATFORM_URL=http://127.0.0.1:9/mcp '$scripts/check-connection.sh' 2> /dev/null)\" = UNREACHABLE"

# 4d. preview.sh (build skill): the local preview outside the web; on the web, a token and frpc first
preview="$plugin/skills/build/scripts/preview.sh"
check "preview.sh outside the web: LOCAL" bash -c "test \"\$(env -u CLAUDE_CODE_REMOTE '$preview')\" = LOCAL"
refuses "preview.sh on the web needs a preview token" "PLATFORM_PREVIEW_TOKEN is not set" env -u PLATFORM_PREVIEW_TOKEN CLAUDE_CODE_REMOTE=true "$preview" https://preview-demo.acme.test http://127.0.0.1:54321
refuses "preview.sh refuses another host" "not a preview URL" bash -c "cd '$plugin/template/app' && CLAUDE_CODE_REMOTE=true PLATFORM_PREVIEW_TOKEN=x '$preview' https://demo.acme.test http://127.0.0.1:54321"
refuses "preview.sh without frpc: NO_TUNNEL" "NO_TUNNEL" bash -c "cd '$plugin/template/app' && PATH=/usr/bin:/bin CLAUDE_CODE_REMOTE=true PLATFORM_PREVIEW_TOKEN=x '$preview' https://preview-demo.acme.test http://127.0.0.1:54321"
old_vite="$tmp/old-vite"
mkdir -p "$old_vite"
echo '{}' > "$old_vite/package.json"
echo 'export default defineConfig({ plugins: [react()] });' > "$old_vite/vite.config.ts"
refuses "preview.sh on an app made before the preview: OLD_VITE_CONFIG" "^OLD_VITE_CONFIG$" bash -c "cd '$old_vite' && CLAUDE_CODE_REMOTE=true PLATFORM_PREVIEW_TOKEN=x '$preview' https://preview-demo.acme.test http://127.0.0.1:54321"

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

# 6. init-app.sh: the app template, missing files only
init="$plugin/template/init-app.sh"
new="$tmp/new"
mkdir "$new"
check "init-app.sh writes a new app" bash -c "cd '$new' && '$init' demo-app"
check "new app is named after its slug" grep -q '"name": "demo-app"' "$new/package.json"
check "new app has the target architecture" grep -q "# demo-app" "$new/CLAUDE.md"
check "no CI file without a workflow reference" test ! -e "$new/.github" -a ! -e "$new/.claude/settings.json"
uses="acme/platform/.github/workflows/deploy.yml@v1"
check "init-app.sh adds only the CI files to an app" bash -c "cd '$new' && test \"\$(PLATFORM_URL=https://api.acme.test/mcp '$init' demo-app '$uses' trunk 2> /dev/null | tr '\n' ' ')\" = '.claude/settings.json .github/workflows/platform.yml '"
check "caller calls the allowed workflow" grep -qx "    uses: $uses" "$new/.github/workflows/platform.yml"
check "caller deploys from the default branch" grep -q "branches: \[trunk\]" "$new/.github/workflows/platform.yml"
check "caller asks for an OIDC token" grep -q "id-token: write" "$new/.github/workflows/platform.yml"
check "caller targets the platform" grep -qx "      platform-url: https://api.acme.test" "$new/.github/workflows/platform.yml"
check "repository settings offer the plugin the platform serves" node -e '
  const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const source = s.extraKnownMarketplaces.platform.source;
  if (source.source !== "url" || source.url !== "https://api.acme.test/plugin/marketplace.json" || s.enabledPlugins["platform@platform"] !== true) process.exit(1);
' "$new/.claude/settings.json"
check "no placeholder left" bash -c "! grep -rqE '__[A-Z]+__' '$new'"
check "every template file is written" test "$(cd "$plugin/template" && find app project ci -type f | wc -l)" -eq "$(find "$new" -type f | wc -l)"
echo "# custom" > "$tmp/custom.yml"
cp "$tmp/custom.yml" "$new/.github/workflows/platform.yml"
check "init-app.sh never overwrites" bash -c "cd '$new' && '$init' demo-app '$uses' main && cmp -s '$tmp/custom.yml' .github/workflows/platform.yml"
check "an existing app only gets the project files" bash -c "cd '$app' && echo '{}' > package.json && test \"\$('$init' demo-app)\" = CLAUDE.md && test ! -e src"
refuses "init-app.sh rejects an invalid slug" "invalid slug" bash -c "cd '$tmp' && '$init' 'Demo App'"
refuses "init-app.sh rejects an invalid reference" "invalid workflow reference" bash -c "cd '$tmp' && '$init' demo-app 'acme/platform@main; rm -rf /' main"
if command -v actionlint > /dev/null; then
  rm "$new/.github/workflows/platform.yml"
  (cd "$new" && "$init" demo-app "$uses" main > /dev/null 2>&1)
  check "actionlint accepts the caller" actionlint "$new/.github/workflows/platform.yml"
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

# 8. The reusable workflow runs the action shipped in the plugin, from its own repository
workflow="$ROOT/.github/workflows/deploy.yml"
check "reusable workflow uses the plugin's action at the running commit" grep -qx '        uses: $/plugin/deploy-cli' "$workflow"
check "reusable workflow is workflow_call only" bash -c "grep -qx '  workflow_call:' '$workflow' && ! grep -qE '^  (push|pull_request|schedule|workflow_dispatch):' '$workflow'"
if command -v actionlint > /dev/null; then check "actionlint accepts the reusable workflow" actionlint "$workflow"; fi

# 9. The platform URL: PLATFORM_URL when exported, else the local stack. The platform serves the plugin with its own
# URL in place of the local one (apps/control-plane/src/plugin.ts)
check ".mcp.json takes PLATFORM_URL, the local stack by default" grep -qF '"url": "${PLATFORM_URL:-http://api.localhost:8100/mcp}"' "$plugin/.mcp.json"
check "platform-url.sh has the same default" grep -qF 'echo "${PLATFORM_URL:-http://api.localhost:8100/mcp}"' "$scripts/platform-url.sh"
if command -v claude > /dev/null; then check "claude plugin validate" claude plugin validate "$ROOT/plugin"; fi
echo 'console.log(process.env.PLATFORM_URL)' > "$plugin/deploy-cli/main.ts"
check "platform-deploy uses an exported PLATFORM_URL" bash -c "cd '$tmp' && test \"\$(PLATFORM_URL=http://other.invalid/mcp PLATFORM_TOKEN=x '$scripts/platform-deploy' check)\" = 'http://other.invalid/mcp'"
check "without it, the local stack" bash -c "cd '$tmp' && test \"\$(env -u PLATFORM_URL PLATFORM_TOKEN=x '$scripts/platform-deploy' check)\" = 'http://api.localhost:8100/mcp'"

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed" >&2; exit 1; fi
echo "all checks passed"
