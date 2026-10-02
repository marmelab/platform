# Control plane

Node 24 + TypeScript (run directly, without a build step, thanks to type stripping), Hono, `pg`, dockerode, MCP SDK (Streamable HTTP, stateless mode).

## Getting started

```bash
deploy/install.sh          # generates deploy/.env, starts the "plat" compose project, initializes the cluster, creates the admin
deploy/install.sh --seed   # same, then scripts/seed.ts: builders alice and bob, todo-app and notes-app deployed through MCP
```

The script is safe to rerun. On the first run it prints the admin's PAT (`admin@example.com`, configurable with `ADMIN_EMAIL=`) and also saves it to **`deploy/.env.local`** (gitignored):

```
PLATFORM_URL=http://api.localhost:8100/mcp
PLATFORM_ADMIN_EMAIL=admin@example.com
PLATFORM_TOKEN=plat_...
```

After a code change: `docker compose -p plat -f deploy/docker-compose.yml up -d --build control-plane`.

## MCP

- URL: `http://api.localhost:8100/mcp`, with the `Authorization: Bearer <PAT>` header.
- Claude Code: `claude mcp add --transport http platform http://api.localhost:8100/mcp --header "Authorization: Bearer $PLATFORM_TOKEN"`
- Tools: `whoami`, `list_apps`, `get_app`, `create_app`, `apply_migrations`, `execute_sql`, `create_deployment`, `finalize_deployment`, `list_deployments`, `rollback`, `set_secrets`, `list_secrets`, `list_members`, `add_member`, `remove_member`, `get_logs`.
- Archives don't go through MCP: `create_deployment` returns a `PUT http://api.localhost:8100/uploads/<token>` URL (single use, 15 min) and a ready-to-use `tar` + `curl` command.

## Apps

Each `<slug>` app is served at `http://<slug>.localhost:8100`: `/` (static, SPA fallback), `/auth/v1`, `/rest/v1`, `/functions/v1`.

## Studio

`http://studio.localhost:8100`: multi-head Studio (`apps/studio`), project ref = app slug, `studio_url` deep link in `get_app`. Platform login on `/_platform/login` (local account with password), then forward auth (`/studio/verify` on the internal `:3001` listener): a builder only sees the apps they are a member of, an admin sees everything. Details: `spikes/m0ter-studio-builders/REPORT.md`.

Studio and `execute_sql` connect as `app_<id>_owner`, which does **not** have `BYPASSRLS`. It owns the `public` tables, so their RLS does not apply to it (as for Supabase's `postgres`). In `auth`, it only reads `auth.users` and `auth.identities` (Auth > Users), through a `platform_owner_read` policy (`FOR SELECT TO app_<id>_owner`); every other `auth` table is denied. `register` (app creation, `syncAll` at control plane startup) re-applies the grants and recreates missing policies: after a GoTrue upgrade whose migrations recreate an `auth` table, restart the control plane (or re-run `create_app`) to repair them.

## Admin CLI (inside the container)

```bash
docker exec plat-control-plane node src/cli.ts create-user bob@example.com developer   # prints a new PAT
docker exec plat-control-plane node src/cli.ts delete-app demo
docker exec plat-control-plane node src/cli.ts delete-user bob@example.com             # also deletes their sessions, tokens and memberships
docker exec plat-control-plane node src/cli.ts set-password bob@example.com --generate         # prints a Studio password
docker exec -i plat-control-plane node src/cli.ts set-password bob@example.com < password.txt  # or reads it from stdin
docker exec plat-control-plane node src/cli.ts add-member demo bob@example.com collaborator   # owner|collaborator
docker exec plat-control-plane node src/cli.ts remove-member demo bob@example.com          # idempotent, refuses to remove the last owner
docker exec plat-control-plane node src/cli.ts init                                     # idempotent, also run at startup
```

App roles: a `collaborator` deploys, inspects the app and manages its users; an `owner` can also manage members, stop, start and delete the app; platform admins can do everything on every app. Memberships created with the former `developer` role are renamed `collaborator` by the idempotent schema migration run at startup.

Membership changes apply to open Studio sessions and PATs on their next request: Studio forward auth and MCP read the user's apps from the database on every request. Member changes are recorded in `audit_log` (`add_member`, `remove_member`), with the acting user for MCP calls and no user for the CLI, which acts as the operator. `add_member` and `remove_member` (MCP and CLI) refuse any change that would leave the app without an owner; through MCP, only an owner of the app or an admin can call them, and the target account must already exist.

## Tests

```bash
pnpm -r typecheck
pnpm --filter @platform/control-plane test        # Studio access policy (unit)
pnpm --filter @platform/control-plane e2e         # requires the running stack and deploy/.env.local
pnpm --filter @platform/control-plane e2e:studio  # Studio: login, filtering, isolation
```

The e2e suites never touch existing apps or users. Each run creates disposable resources named after a run id: one app `e2e-<id>` for `e2e`, two apps `e2e-<id>-a` / `e2e-<id>-b` and two builders `e2e-<id>-alice@example.com` / `e2e-<id>-bob@example.com` (random passwords, kept in memory) for `e2e:studio`. They are deleted at the end of the run, even when a test fails, with `delete-app` and `delete-user`; the `after` hook then checks that nothing is left (platform rows, sessions, tokens, memberships, containers, Caddy routes, database and roles) and fails the suite otherwise. Set `E2E_KEEP=1` to keep the apps for inspection (their slugs are printed), then remove them with `delete-app`.

## Technical access (dev)

| Item | Value |
|---|---|
| Postgres | `127.0.0.1:54350`, `supabase_admin` / `POSTGRES_PASSWORD` from `deploy/.env`; `platform` database |
| Caddy admin | `http://127.0.0.1:2030` (routes `app-<slug>` and `app-<slug>-internal`) |
| Volumes | `plat_sites`, `plat_functions`, `plat_apps-config`, `plat_uploads`, `plat_deno-cache`, `plat_db-data` |
| Containers | `plat-db`, `plat-caddy`, `plat-edge`, `plat-control-plane`, `plat-studio`, `plat-studio-meta`, and per app `plat-<slug>-auth` and `plat-<slug>-rest` |
