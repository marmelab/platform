# "platform" Claude Code plugin

Deploys a Vite + Supabase app (migrations, edge functions, static frontend) to the platform from Claude Code: "deploy the app to the platform". In production the deployment goes through the app's GitHub Actions CI (PLAN_1 §6); a direct deployment from the machine stays available when the platform allows it (`DIRECT_DEPLOY`).

Contents:

```
plugin/
  .claude-plugin/plugin.json
  .mcp.json                        # "platform" MCP server (HTTP), URL and token from env variables
  deploy-cli -> ../packages/deploy-cli/src   # platform-deploy, the CLI the CI runs (symlink, copied at install)
  skills/deploy/SKILL.md           # builder: sets up the CI and pushes, or deploys directly when allowed
  skills/deploy/assets/platform.yml -> ci/examples/platform.yml   # caller workflow template (symlink)
  skills/deploy/scripts/
    platform-deploy                # runs deploy-cli/main.ts with the PAT (check | deploy [--reason])
    function-secrets.sh            # secrets read by supabase/functions (Deno.env.get), platform ones excluded
    install-workflow.sh            # writes .github/workflows/platform.yml from the template, never overwrites
  skills/admin-deploy/SKILL.md     # admins: audited direct deployment of a pushed commit, with a reason
  skills/admin-deploy/scripts/
    preflight.sh                   # refuses a dirty tree, an unpushed commit, a checkout of another repository
  test/scripts.test.sh             # checks the skills' scripts and the MCP tools they name, without the platform
```

The marketplace (`platform-local`) is declared in `.claude-plugin/marketplace.json` at the repo root. Claude Code copies an installed plugin into its cache and resolves the two symlinks then (checked with a local marketplace): the plugin is self-contained once installed.

## Installation

Prerequisites: Node.js ≥ 22.18 (`platform-deploy` runs TypeScript directly) and, for the CI path, the GitHub CLI (`gh`) logged in with the right to create repositories in the company organization (or an existing repository there).

1. Get a token (PAT) from a platform admin, then export it in the shell that starts Claude Code (for instance in `~/.zshrc`):

   ```bash
   export PLATFORM_TOKEN=plat_...
   # optional, defaults to http://api.localhost:8100/mcp
   export PLATFORM_URL=https://api.<domain>/mcp
   ```

2. Add the marketplace and install the plugin:

   ```bash
   claude plugin marketplace add /path/to/platform     # or the repo's git URL
   claude plugin install platform@platform-local
   ```

   In an interactive session: `/plugin marketplace add <path or URL>` then `/plugin install platform@platform-local`.

3. Check: `/mcp` should list `plugin:platform:platform` as "connected". Otherwise, check that `PLATFORM_TOKEN` is exported in Claude Code's environment.

To try it without installing: `claude --plugin-dir /path/to/platform/plugin`.

## Usage

In a Vite + supabase-js repo (see `examples/todo-app`):

```
> deploy the app to the platform
```

The `platform:deploy` skill:

1. reads `whoami` (`direct_deploy`, and `ci`: the reusable workflow to call and the company organization, or null when CI is not set up on the platform) and `.platform.json` (or creates the app with `create_app` and writes the file);
2. chooses the path: **CI** when the platform has CI and the project has (or the user wants) a repository in the organization; **direct** when `direct_deploy` is true and there is no repository or CI, or when the user asks for it; otherwise it explains why it cannot deploy;
3. sets the function secrets the code reads and the platform does not have (asks the user for the values, `set_secrets`);
4. reviews the new migrations and runs `platform-deploy check` (migrations dry run with the security linter, build); a blocking lint stops it, and a lint is added to `acceptedLints` only with the user's explicit consent;
5. CI path: `gh repo create` if needed, `link_repo`, checks that the default branch is protected (the platform only deploys from a protected branch) and proposes a minimal protection, sets the `PLATFORM_URL` repository variable if the organization has none, installs `.github/workflows/platform.yml`, commits, opens a PR and watches its check, then watches the deploy run after the merge (`gh run watch`);
6. direct path: `platform-deploy deploy` (release with the commit, migrations, functions, build, frontend, smoke test);
7. reports the app URL, the Studio link and the run or release; on errors, reads the run logs and `get_logs`, and diagnoses.

The `platform:admin-deploy` skill (admins only) is the audited exception of PLAN_1 §6.3: it asks for a reason, runs `preflight.sh` (clean tree, commit on the remote, checkout of the linked repository), then `platform-deploy deploy --reason "..."`.

Expected repo conventions:

- `supabase/migrations/<version>_<name>.sql` (numeric version, e.g. `20261001100000_create_todos.sql`);
- `supabase/functions/<name>/index.ts`, `supabase/config.toml` (`[functions.<name>] verify_jwt`);
- the frontend reads `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`;
- `.platform.json` at the root: `{ "app": "<slug>", "acceptedLints": [] }`, committed.

## Tests

- `plugin/test/scripts.test.sh` (also run by `pnpm --filter @platform/control-plane test`): from a copy of the plugin with its symlinks resolved, every `${CLAUDE_PLUGIN_ROOT}` path of the skills exists, every MCP tool they name exists in the control plane, and the scripts behave (secrets scan, workflow template, preflight refusals; `actionlint` on the generated caller when installed).
- `apps/control-plane/test/plugin.e2e.test.ts` (`e2e:plugin`): the commands of the direct path of `deploy`, then of `admin-deploy`, on a copy of `examples/todo-app` against the running stack.
- The CI path needs GitHub and has not run yet (TECH_DEBT PLG-4).

## Headless usage (tests)

```bash
PLATFORM_TOKEN=... claude -p "deploy the app to the platform" \
  --plugin-dir /path/to/platform/plugin \
  --allowedTools "mcp__plugin_platform_platform__*" "Bash(npm *)" "Bash(git *)" "Bash(gh *)" "Bash(curl *)" \
                 "Bash(/path/to/platform/plugin/skills/deploy/scripts/*)" Read Write Edit Glob Grep Skill
```
