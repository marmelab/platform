---
name: deploy
description: Deploy the current Vite + Supabase project to the internal platform (database migrations, edge functions, static frontend). Use when the user asks to deploy, publish, ship or put the app online "on the platform", or to redeploy after changes.
allowed-tools: mcp__plugin_platform_platform__*, Bash(npm *), Bash(git *), Bash(${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/*), Read, Glob, Grep, Write
---

# Deploy to the platform

The platform hosts Supabase-style apps: one Postgres database, Auth (GoTrue), REST (PostgREST), edge functions and a static SPA per app, served at `http://<slug>.<domain>`. You drive it through the `platform` MCP server tools (`whoami`, `get_app`, `create_app`, `apply_migrations`, `execute_sql`, `create_deployment`, `finalize_deployment`, `list_deployments`, `rollback`, `set_secrets`, `list_secrets`, `get_logs`).

Helper scripts (run them from the project root, call them by absolute path):

- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/migrations.sh` prints `supabase/migrations/*.sql` as the JSON array `apply_migrations` expects.
- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/upload.sh <frontend|functions> <upload_url>` packs the bundle (`tar` with `COPYFILE_DISABLE=1`) and uploads it with `curl -X PUT`.

Never pass archives or file contents other than migration SQL through MCP arguments. Never print or write the platform token.

## Workflow

Follow these steps in order. Keep the user informed with one short line per step.

### 1. Identify the app

- Read `.platform.json` at the repository root. It looks like `{ "app": "<slug>" }`.
- If it is missing:
  1. Pick a name from `package.json` `name` (or the directory name). The slug must match `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`.
  2. Call `create_app` with `name` (and `slug`). It is idempotent.
  3. Write `.platform.json` with `{ "app": "<slug>", "url": "<url>" }` and commit it alone: `git add .platform.json && git commit -m "Add platform app config"`. If there is no git repository or the commit fails, say so and continue.
- If it exists, call `get_app` to check the app is reachable. If access is denied, stop and tell the user.

### 2. Check the project

- It must be a Vite SPA: `package.json` with a `build` script and `vite` in the dependencies, `index.html` at the root. Otherwise stop and explain that only Vite SPAs are supported.
- Locate `supabase/migrations/` and `supabase/functions/` (both optional).
- Migration files must be named `<version>_<name>.sql` with a numeric version (e.g. `20261001100000_create_todos.sql`). Report and stop on any other `.sql` file name.

### 3. Database migrations (skip if there is no migration)

1. Find which versions are already applied:
   `execute_sql` with `sql: "select version from supabase_migrations.schema_migrations order by version"`.
2. **Pre-flight review of the new migrations** (versions not in that list). Read each of them. If one creates a table (or view) in the `public` schema without `alter table ... enable row level security` in the same set of new migrations, **stop before applying anything**: name the file and table, explain that the table would be readable and writable by anyone holding the anon key, and propose the fix (enable RLS and add policies). Only continue if the user explicitly consents in this conversation.
3. Run `migrations.sh` and call `apply_migrations` with `app` and the full array (already applied versions are skipped by the server, so sending all files is safe and keeps ordering checks on the server).
4. Report `applied` and `skipped`.
5. Read `lints`:
   - Any `ERROR` (e.g. `rls_disabled_in_public`, `policy_exists_rls_disabled`, `security_definer_view`): **stop the deployment here** unless the user has explicitly consented. Show each lint (`name`, `object`, `detail`), explain the risk, and propose a corrective migration (a new file, never edit an applied one). The migrations are already committed in the database, so say that the frontend and functions were *not* deployed.
   - `WARN` / `INFO`: list them briefly and continue.
6. If `apply_migrations` fails, the whole batch is rolled back: show the SQL error, fix nothing silently, stop.

### 4. Edge functions (skip if `supabase/functions/` has no `<name>/index.ts`)

1. Look for secrets the functions need: grep for `Deno.env.get("...")` in `supabase/functions`. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` are provided by the platform. For the others, call `list_secrets`; ask the user for any missing value, then `set_secrets`. Never invent a secret value. In a non-interactive session, report the missing names and continue.
2. `create_deployment` with `kind: "functions"`.
3. Run `upload.sh functions '<upload_url>'` (the URL is single-use and expires after 15 minutes: upload right away).
4. `finalize_deployment` with the `deployment_id`. It returns the deployed function names and the version.

### 5. Build the frontend

1. `get_app` to obtain `supabase_url` and `anon_key`.
2. Install dependencies if `node_modules` is missing (`npm ci` when `package-lock.json` exists, otherwise `npm install`).
3. Build with the variables inline, without writing them to a file:
   `VITE_SUPABASE_URL='<supabase_url>' VITE_SUPABASE_ANON_KEY='<anon_key>' npm run build`
   The anon key is public (it ships in the bundle), but do not commit it.
4. If the build fails, show the error and stop.

### 6. Deploy the frontend

1. `create_deployment` with `kind: "frontend"`.
2. `upload.sh frontend '<upload_url>'` (packs the *content* of `dist/`, with `index.html` at the root).
3. `finalize_deployment`.

### 7. Verify and report

1. `curl -fsS -o /dev/null -w '%{http_code}' <url>` must return 200.
2. Final message, short:
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
