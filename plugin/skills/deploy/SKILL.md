---
name: deploy
description: Deploy the current Vite + Supabase project to the internal platform (database migrations, edge functions, static frontend). Use when the user asks to deploy, publish, ship or put the app online "on the platform", or to redeploy after changes.
allowed-tools: mcp__plugin_platform_platform__*, Bash(npm *), Bash(git *), Bash(curl *), Bash(${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/*), Read, Glob, Grep, Write, Edit
---

# Deploy to the platform

The platform hosts Supabase-style apps: one Postgres database, Auth (GoTrue), REST (PostgREST), edge functions and a static SPA per app, served at `http://<slug>.<domain>`. You drive it through the `platform` MCP server tools (`whoami`, `get_app`, `create_app`, `apply_migrations`, `execute_sql`, `create_deployment`, `finalize_deployment`, `list_deployments`, `rollback`, `set_secrets`, `list_secrets`, `get_logs`).

Helper scripts (run them from the project root, call them by absolute path):

- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/migrations.sh` prints `supabase/migrations/*.sql` as the JSON array `apply_migrations` expects.
- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/build.sh <supabase_url> <anon_key>` installs dependencies if needed and runs `npm run build` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/upload.sh <frontend|functions> <upload_url>` packs the bundle (`tar` with `COPYFILE_DISABLE=1`) and uploads it with `curl -X PUT`.

Shell hygiene, so that permission rules match: run **one command per Bash call** (no `&&`, `;`, pipes or `VAR=value cmd` prefixes), call the scripts directly by their absolute path, and create or edit files with the Write/Edit tools rather than shell redirections.

Never pass archives or file contents other than migration SQL through MCP arguments. Never print or write the platform token.

## Workflow

Follow these steps in order. Keep the user informed with one short line per step, in the user's language.

### 1. Identify the app

- Read `.platform.json` at the repository root. It looks like `{ "app": "<slug>" }`.
- If it is missing:
  1. Pick a name from `package.json` `name` (or the directory name). The slug must match `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`.
  2. Call `create_app` with `name` (and `slug`). It is idempotent.
  3. Write `.platform.json` (Write tool) with `{ "app": "<slug>", "url": "<url>" }` and commit it alone: `git add .platform.json`, then `git commit -m "Add platform app config"` (two Bash calls). If there is no git repository or the commit fails, say so and continue.
- If it exists, call `get_app` to check the app is reachable. If access is denied, stop and tell the user.

### 2. Check the project

- It must be a Vite SPA: `package.json` with a `build` script and `vite` in the dependencies, `index.html` at the root. Otherwise stop and explain that only Vite SPAs are supported.
- Locate `supabase/migrations/` and `supabase/functions/` (both optional).
- Migration files must be named `<version>_<name>.sql` with a numeric version (e.g. `20261001100000_create_todos.sql`). Report and stop on any other `.sql` file name.

### 3. Database migrations (skip if there is no migration)

1. Find which versions are already applied:
   `execute_sql` with `sql: "select version from supabase_migrations.schema_migrations order by version"`.
2. **Pre-flight review of the new migrations** (versions not in that list), as a help for the user: read them and point out anything risky (a `public` table or view without RLS, a `security definer` view or function). The server enforces the linter anyway. When in doubt, call `apply_migrations` with `dry_run: true` first: it applies, lints and always rolls back.
3. Run `migrations.sh` and call `apply_migrations` with `app` and the full array (already applied versions are skipped by the server, so sending all files is safe and keeps ordering checks on the server).
4. The linter runs inside the transaction:
   - **Rejected** (tool error with `status: "rejected"`, `applied: []`): the batch introduces at least one `ERROR` lint (e.g. `rls_disabled_in_public`, `policy_exists_rls_disabled`, `security_definer_view`) and **nothing was applied**. Stop the deployment here: show each lint of `blocking_lints` (`name`, `object`, `detail`), explain the risk, and propose a corrective change (the migrations were not applied, so fixing the new files is fine). Say that the frontend and functions were *not* deployed.
   - Only if the user explicitly consents in this conversation to keep a flagged object, call `apply_migrations` again with `accept_lints` listing exactly those lints as `{ "name": ..., "object": ... }` (the acceptance is audited). Never use `accept_lints` on your own initiative.
   - **Applied**: report `applied` and `skipped`; list `WARN` / `INFO` lints briefly and continue.
5. If `apply_migrations` fails with an SQL error, the whole batch is rolled back: show the SQL error, fix nothing silently, stop.

### 4. Edge functions (skip if `supabase/functions/` has no `<name>/index.ts`)

1. Look for secrets the functions need: grep for `Deno.env.get("...")` in `supabase/functions`. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` are provided by the platform. For the others, call `list_secrets`; ask the user for any missing value, then `set_secrets`. Never invent a secret value. If a secret is still missing and the function reads it at boot, do not deploy the functions (they would fail to start): say which secret is missing and ask whether to deploy the frontend alone.
2. `create_deployment` with `kind: "functions"`.
3. Run `upload.sh functions '<upload_url>'` (the URL is single-use and expires after 15 minutes: upload right away).
4. `finalize_deployment` with the `deployment_id`. It boots every function on the new version before publishing it, and returns the deployed function names and the version. If it fails (e.g. `BOOT_ERROR`: missing npm package, missing secret read at boot), the live functions are unchanged: **stop before the frontend**, follow **On errors** with `service: "functions"`, and report that nothing was published.

### 5. Build the frontend

1. `get_app` to obtain `supabase_url` and `anon_key`.
2. Run `build.sh '<supabase_url>' '<anon_key>'`. It installs dependencies when `node_modules` is missing and builds with the variables passed inline, never written to a file. The anon key is public (it ships in the bundle), but do not commit it.
3. If the build fails, show the error and stop.

### 6. Deploy the frontend

1. `create_deployment` with `kind: "frontend"`.
2. `upload.sh frontend '<upload_url>'` (packs the *content* of `dist/`, with `index.html` at the root).
3. `finalize_deployment`.

### 7. Verify and report

1. `curl -sS -o /dev/null -w '%{http_code}' <url>` must return 200.
2. For each deployed function, `curl -sS -X OPTIONS -w ' %{http_code}' <url>/functions/v1/<name>` (preflight requests skip JWT checks). `finalize_deployment` already checked that the functions boot; this smoke test goes through the public route. A 5xx or a `BOOT_ERROR` / `WORKER_ERROR` body means something is broken: follow **On errors** below with `service: "functions"`.
3. Final message, short:
   - app URL;
   - migrations applied / skipped, frontend version, functions version and names;
   - linter warnings, if any;
   - anything skipped and why.

## On errors

Whenever a platform call, an upload or the final check fails:

1. Call `get_logs` for the app, scoped to the relevant service (`functions` for a function boot or runtime error, `postgrest` for a REST/schema problem, `gotrue` for auth, `postgres` for SQL), `since_minutes: 15`, and a `query` filter when you have a keyword.
2. Give a diagnosis in two or three sentences, with the relevant log lines, and the fix you propose.
3. Do not retry blindly more than once. An upload URL can only be used once: on a failed upload, call `create_deployment` again.
4. To undo a bad frontend or functions release, propose `rollback` (it does not undo migrations).
