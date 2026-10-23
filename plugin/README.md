# "platform" Claude Code plugin

Builds apps in the platform's target architecture ("build me a notes app for my team") and deploys a Vite + Supabase app (migrations, edge functions, static frontend) to the platform from Claude Code: "deploy the app to the platform". In production the deployment goes through the app's GitHub Actions CI (ARCHITECTURE §6); a direct deployment from the machine stays available when the platform allows it (`DIRECT_DEPLOY`).

Contents:

```
plugin/
  .claude-plugin/plugin.json
  .mcp.json                        # "platform" MCP server (HTTP): browser sign-in (OAuth), or a PAT from PLATFORM_TOKEN
  deploy-cli/                      # platform-deploy, the CLI the CI runs, and its composite action (action.yml)
  skills/build/SKILL.md            # builder: creates or extends an app in the target architecture, local preview (no script)
  skills/deploy/SKILL.md           # builder: sets up the CI and pushes, or deploys directly when allowed
  skills/deploy/assets/platform.yml   # caller workflow template
  skills/deploy/scripts/
    platform-deploy                # runs deploy-cli/main.ts with a deploy token or the PAT (check | deploy [--reason])
    check-connection.sh            # step 0: OK | NOT_SIGNED_IN | ACCOUNT_REFUSED | UNREACHABLE, never a secret
    function-secrets.sh            # secrets read by supabase/functions (Deno.env.get), platform ones excluded
    install-workflow.sh            # writes .github/workflows/platform.yml from the template, never overwrites
    platform-url.sh                # the MCP URL the scripts use: PLATFORM_URL, else the plugin option, else the local stack
  skills/admin-deploy/SKILL.md     # admins: audited direct deployment of a pushed commit, with a reason
  skills/admin-deploy/scripts/
    preflight.sh                   # refuses a dirty tree, an unpushed commit, a checkout of another repository
  test/scripts.test.sh             # checks the skills' scripts and the MCP tools they name, without the platform
```

The marketplace (`platform-local`) is declared in `.claude-plugin/marketplace.json` at the repo root, so any clone of this repository is a marketplace: the company's internal copy (which also serves the reusable workflow) needs no change: each builder enters the platform's URL when the plugin is enabled ([INSTALL.md](../docs/INSTALL.md) §7). The plugin directory holds real files only (no symlink: a git marketplace ships none) and is self-contained once installed.

## Installation

Prerequisites: Node.js ≥ 22.18 (`platform-deploy` runs TypeScript directly) and, for the CI path, the GitHub CLI (`gh`) logged in with the right to create repositories in the company organization (or an existing repository there). No token to get, no file to edit.

1. Add the marketplace and install the plugin:

   ```bash
   claude plugin marketplace add <org>/<platform repo>   # the company's marketplace repository; or a local checkout's path
   claude plugin install platform@platform-local
   ```

   In an interactive session: `/plugin marketplace add <path or URL>` then `/plugin install platform@platform-local`.
   Claude Code asks for the **Platform MCP URL**: `https://api.<domain>/mcp`, given in your welcome email (the
   default is the local stack). Later: `/plugin configure platform@platform-local`, or from a shell
   `claude plugin install platform@platform-local --config platform_url=<url>`.

2. Sign in, once: ask Claude to deploy (the `deploy` skill explains what to do), or type `/mcp`, choose `plugin:platform:platform` (shown as "needs authentication"), then **Authenticate** (from a shell: `claude mcp login plugin:platform:platform`). The browser opens on the platform's login page (password or company SSO), then asks to allow Claude Code to access your apps. Claude Code keeps the tokens in the system keychain and refreshes them; `/mcp` then shows the server as connected. When an admin revokes the connection, the server shows **Re-authenticate**.

The platform URL is the plugin's `platform_url` option (`userConfig` in `plugin.json`, default `http://api.localhost:8100/mcp`, the local stack): `.mcp.json` references it as `${user_config.platform_url}`, and `check-connection.sh` and `platform-deploy` read the stored value (`pluginConfigs` in `settings.json`, through `platform-url.sh`). `PLATFORM_URL` exported in the environment overrides it for the scripts.

To try it without installing: `claude --plugin-dir /path/to/platform/plugin`.

### With a personal access token (admins, scripts, tests)

Export a PAT (admin console, Tokens) before starting Claude Code:

```bash
export PLATFORM_TOKEN=plat_...
export PLATFORM_URL=https://api.<domain>/mcp   # optional: overrides the plugin option for the scripts
```

`.mcp.json` sends it in the `X-Platform-Token` header, empty when `PLATFORM_TOKEN` is unset. Not in `Authorization`: Claude Code never falls back to the browser sign-in when a configured `Authorization` header is refused, and the plugin's `headersHelper` cannot read the user's environment (Claude Code runs it with a cleaned one). With a PAT set, the server connects at once and OAuth is not used; a revoked PAT makes it ask for the browser sign-in. `platform-deploy` uses `PLATFORM_TOKEN` directly. Without the plugin: `claude mcp add --transport http platform <url> --header "X-Platform-Token: $PLATFORM_TOKEN"`.

## Usage

In a Vite + supabase-js repo (see `examples/todo-app`):

```
> deploy the app to the platform
```

The `platform:deploy` skill:

0. checks the connection when the platform tools are missing or `whoami` fails (`check-connection.sh`), and explains in plain words how to sign in, that the account is refused, or that the platform is unreachable;
1. reads `whoami` (`credential`, `direct_deploy`, and `ci`: the reusable workflow to call and the company organization, or null when CI is not set up on the platform) and `.platform.json` (or creates the app with `create_app` and writes the file);
2. chooses the path: **CI** when the platform has CI and the project has (or the user wants) a repository in the organization; **direct** when `direct_deploy` is true and there is no repository or CI, or when the user asks for it; otherwise it explains why it cannot deploy;
3. sets the function secrets the code reads and the platform does not have (asks the user for the values, `set_secrets`);
4. reviews the new migrations and runs `platform-deploy check` (migrations dry run with the security linter, build); a blocking lint stops it, and a lint is added to `acceptedLints` only with the user's explicit consent;
5. CI path: `gh repo create` if needed, `link_repo`, checks that the default branch is protected (the platform only deploys from a protected branch) and proposes a minimal protection, sets the `PLATFORM_URL` repository variable if the organization has none, installs `.github/workflows/platform.yml`, commits, opens a PR and watches its check, then watches the deploy run after the merge (`gh run watch`);
6. direct path: `platform-deploy deploy` (release with the commit, migrations, functions, build, frontend, smoke test). Signed in through the browser, the skill first gets a deploy token (`create_deploy_token`: 15 minutes, this app and the publishing tools only) and passes it in `PLATFORM_DEPLOY_TOKEN`, a new one for each command; with a PAT, the script uses `PLATFORM_TOKEN`;
7. reports the app URL, the Studio link and the run or release; on errors, reads the run logs and `get_logs`, and diagnoses.

The `platform:build` skill is used before the first deployment, from an empty folder or an existing app ("build me a notes app for my team", "add file attachments to the notes"). It holds the target architecture: Vite + React + TypeScript single-page app with supabase-js, migrations in `supabase/migrations` with row level security on every table, edge functions only for what needs a secret or extra privileges, email and password auth that handles invitation and password reset links (app users are usually invited by the builder). It is written for builders who are not developers: it keeps every technical decision on Claude's side and talks about what the app does and who sees what, without jargon, commands to run or files to edit. It builds the app, checks `npm run build`, commits, then runs a local preview (`supabase start` on free ports, two demo accounts and sample data, the dev server declared in `.claude/launch.json` so that Claude Desktop shows it in its preview pane) and offers to deploy it with `platform:deploy`.

The `platform:admin-deploy` skill (admins only) is the audited exception of ARCHITECTURE §6.3: it asks for a reason, runs `preflight.sh` (clean tree, commit on the remote, checkout of the linked repository), then `platform-deploy deploy --reason "..."`.

Expected repo conventions:

- `supabase/migrations/<version>_<name>.sql` (numeric version, e.g. `20261001100000_create_todos.sql`);
- `supabase/functions/<name>/index.ts`, `supabase/config.toml` (`[functions.<name>] verify_jwt`);
- the frontend reads `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`;
- `.platform.json` at the root: `{ "app": "<slug>", "acceptedLints": [] }`, committed.

## Tests

- `plugin/test/scripts.test.sh` (also run by `pnpm --filter @platform/control-plane test`): from a copy of the plugin, every `${CLAUDE_PLUGIN_ROOT}` path of the skills exists, every MCP tool they name exists in the control plane, `.mcp.json` has no `Authorization` header, and the scripts behave (secrets scan, workflow template, preflight refusals, `platform-deploy` with a deploy token or a PAT, `check-connection.sh` against a fake platform; `actionlint` on the generated caller and the reusable workflow when installed), the reusable workflow (`$/plugin/deploy-cli`, `workflow_call` only), and the platform URL (`.mcp.json` references the plugin option, the scripts read the stored value, `PLATFORM_URL` wins, the local stack by default).
- `apps/control-plane/test/plugin.e2e.test.ts` (`e2e:plugin`): the commands of the direct path of `deploy` (with a PAT, then with deploy tokens and `check-connection.sh`), then of `admin-deploy`, on a copy of `examples/todo-app` against the running stack.
- `apps/control-plane/test/oauth.e2e.test.ts` (`e2e:oauth`): the browser sign-in, with a simulated client.
- By hand, with Claude Code 2.1.290: `claude mcp list` shows "Needs authentication" without `PLATFORM_TOKEN` and "Connected" with it; `claude mcp login plugin:platform:platform` completes the browser sign-in, then `whoami` answers with `credential: "oauth"`.
- The CI path needs GitHub and has not run yet (TECH_DEBT PLG-4).

## Headless usage (tests)

`claude -p` cannot run the browser sign-in: sign in once interactively (`claude mcp login plugin:platform:platform`), or export `PLATFORM_TOKEN`.

```bash
claude -p "deploy the app to the platform" \
  --plugin-dir /path/to/platform/plugin \
  --allowedTools "mcp__plugin_platform_platform__*" "Bash(npm *)" "Bash(git *)" "Bash(gh *)" "Bash(curl *)" \
                 "Bash(/path/to/platform/plugin/skills/deploy/scripts/*)" \
                 "Bash(PLATFORM_DEPLOY_TOKEN=* /path/to/platform/plugin/skills/deploy/scripts/platform-deploy *)" \
                 Read Write Edit Glob Grep Skill
```
