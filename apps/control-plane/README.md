# Control plane

Node 24 + TypeScript (run directly, without a build step, thanks to type stripping), Hono, `pg`, dockerode, MCP SDK (Streamable HTTP, stateless mode).

## Getting started

```bash
deploy/install.sh          # generates deploy/.env, starts the "plat" compose project, initializes the cluster, creates the admin
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
- Tools: `whoami`, `list_apps`, `get_app`, `create_app`, `apply_migrations`, `execute_sql`, `create_deployment`, `finalize_deployment`, `list_deployments`, `rollback`, `set_secrets`, `list_secrets`, `get_logs`.
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
docker exec plat-control-plane node src/cli.ts set-password bob@example.com --generate         # prints a Studio password
docker exec -i plat-control-plane node src/cli.ts set-password bob@example.com < password.txt  # or reads it from stdin
docker exec plat-control-plane node src/cli.ts add-member demo bob@example.com developer
docker exec plat-control-plane node src/cli.ts init                                     # idempotent, also run at startup
```

## Tests

```bash
pnpm -r typecheck
pnpm --filter @platform/control-plane test        # Studio access policy (unit)
pnpm --filter @platform/control-plane e2e         # requires the running stack and deploy/.env.local
pnpm --filter @platform/control-plane e2e:studio  # Studio: login, filtering, isolation (creates alice and bob)
```

## Technical access (dev)

| Item | Value |
|---|---|
| Postgres | `127.0.0.1:54350`, `supabase_admin` / `POSTGRES_PASSWORD` from `deploy/.env`; `platform` database |
| Caddy admin | `http://127.0.0.1:2030` (routes `app-<slug>` and `app-<slug>-internal`) |
| Volumes | `plat_sites`, `plat_functions`, `plat_apps-config`, `plat_uploads`, `plat_deno-cache`, `plat_db-data` |
| Containers | `plat-db`, `plat-caddy`, `plat-edge`, `plat-control-plane`, `plat-studio`, `plat-studio-meta`, and per app `plat-<slug>-auth` and `plat-<slug>-rest` |
