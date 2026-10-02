# "platform" Claude Code plugin

Deploys a Vite + Supabase app (migrations, edge functions, static frontend) to the platform from Claude Code: "deploy the app to the platform".

Contents:

```
plugin/
  .claude-plugin/plugin.json
  .mcp.json                      # "platform" MCP server (HTTP), URL and token from env variables
  skills/deploy/SKILL.md         # deployment workflow
  skills/deploy/scripts/
    migrations.sh                # supabase/migrations/*.sql -> JSON for apply_migrations
    pack.sh                      # tar.gz of dist/ or supabase/functions (+ config.toml), COPYFILE_DISABLE=1
    upload.sh                    # pack.sh + curl PUT to the presigned URL
```

The marketplace (`platform-local`) is declared in `.claude-plugin/marketplace.json` at the repo root.

## Installation

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

1. reads `.platform.json` (or creates the app with `create_app`, writes the file and commits it);
2. checks that the project is a Vite SPA;
3. reviews the new migrations, then runs `apply_migrations`; the linter runs inside the transaction and rejects any new `ERROR`, which is only accepted (`accept_lints`) with the user's explicit consent;
4. deploys `supabase/functions` (archive + presigned URL + `finalize_deployment`, which warms each function up before switching);
5. builds with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `get_app`;
6. deploys `dist/`;
7. checks the URL and prints a summary; on errors, calls `get_logs` and diagnoses.

Expected repo conventions:

- `supabase/migrations/<version>_<name>.sql` (numeric version, e.g. `20261001100000_create_todos.sql`);
- `supabase/functions/<name>/index.ts`, `supabase/config.toml` (`[functions.<name>] verify_jwt`);
- the frontend reads `import.meta.env.VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`;
- `.platform.json` at the root: `{ "app": "<slug>", "url": "..." }`, committed.

## Headless usage (CI, tests)

```bash
PLATFORM_TOKEN=... claude -p "deploy the app to the platform" \
  --plugin-dir /path/to/platform/plugin \
  --allowedTools "mcp__plugin_platform_platform__*" "Bash(npm *)" "Bash(git *)" "Bash(curl *)" \
                 "Bash(/path/to/platform/plugin/skills/deploy/scripts/*)" Read Write Edit Glob Grep Skill
```
