# Platform

Self-hosted hosting for the apps your team builds with Claude Code. Each app gets its own Supabase backend (Postgres database, Auth, REST API, Edge Functions) and its static frontend, all served from a single VM. Developers ("app builders") don't use a UI to deploy: they ask Claude Code to "deploy the app to the platform", through an MCP server and a Claude Code plugin. They inspect their apps in a multi-project Supabase Studio. Admins see every app.

> **Status: prototype.** Milestones M0 to M3 of [PLAN_1.md](PLAN_1.md) are validated (see `spikes/*/REPORT.md`), plus Studio access for app builders. It runs locally; production deployment is not ready yet (see [Deploying](#deploying)).

More docs:
- [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md): personas, main journeys, product decisions;
- [docs/TECH_DEBT.md](docs/TECH_DEBT.md): known debt and limitations;
- [apps/control-plane/README.md](apps/control-plane/README.md): control plane, MCP tools, admin CLI;
- [plugin/README.md](plugin/README.md): Claude Code plugin.

## Repository layout

```
apps/
  control-plane/      Hono API + MCP server + provisioning (Docker, Caddy, Postgres)
  edge-main-worker/   Deno main worker routing Edge Functions to the right app
  studio/             vendored supabase-studio-multi-head, patched for per-app access
packages/
  shared/             zod schemas and types shared by the API and the MCP server
  sql/                template database, per-app roles, linter queries
plugin/               Claude Code plugin (deploy skill + MCP config)
deploy/               docker-compose stack ("plat"), Caddy bootstrap, install.sh
examples/todo-app/    Vite + React + supabase-js example app
spikes/               milestone reports and prototypes
```

## Prerequisites

- macOS or Linux, with Docker (Docker Desktop: 8 GB of RAM or more allocated)
- Node 24 and pnpm 10 (`corepack enable`)
- Deno 2 (Edge Functions unit tests only)
- `openssl`, `curl`
- Claude Code, to deploy apps through the plugin
- About 16 GB of free RAM on the host to build Studio (Next.js build, ~8 GB peak)

`*.localhost` resolves to `127.0.0.1` out of the box, so no DNS setup is needed.

## Install and run locally

```bash
pnpm install
deploy/install.sh
```

`install.sh` is safe to rerun. It:
1. generates the stack secrets in `deploy/.env`;
2. builds the Studio image on the first run (`STUDIO_BUILD=1 deploy/install.sh` forces a rebuild);
3. starts the `plat` docker compose project;
4. initializes the Postgres cluster (template database, `platform` database);
5. creates the first admin, and saves their personal access token (`PLATFORM_TOKEN`) and Studio password (`PLATFORM_ADMIN_PASSWORD`) in `deploy/.env.local`.

With `--seed` (or `SEED=1`), `install.sh` then runs [apps/control-plane/scripts/seed.ts](apps/control-plane/scripts/seed.ts), so you can try the platform as an app builder right away:

```bash
deploy/install.sh --seed
```

The seed is idempotent and goes through the real API (MCP with each builder's PAT, pre-signed upload, `finalize_deployment`). It:
1. creates the app builders `alice@example.com` and `bob@example.com` (developer role), resets their Studio password to `alice-password` / `bob-password` (override with `SEED_ALICE_PASSWORD` / `SEED_BOB_PASSWORD`), and issues a PAT for each unless the one saved in `deploy/.env.local` still works;
2. deploys [examples/todo-app](examples/todo-app) as `todo-app` (owner alice) and again as `notes-app` (owner bob): migrations, the `summary` function, and the frontend built against the app's URL and anon key;
3. signs up `demo-user@example.com` / `demo-password` in each app's Auth and adds a few todos for them.

On a rerun, existing apps are redeployed (migrations already applied are skipped, new frontend and functions versions) and existing demo rows are kept. The seed never changes memberships or other apps: if a seed slug already belongs to another user, it is skipped with a warning, and the seed warns when a seed builder is also a member of other apps. It prints a summary of the URLs and accounts at the end.

Both files are gitignored. To stop or restart the stack:

```bash
docker compose -p plat -f deploy/docker-compose.yml stop
docker compose -p plat -f deploy/docker-compose.yml start
```

## URLs

| URL | What |
|---|---|
| http://api.localhost:8100/mcp | MCP server (`Authorization: Bearer <PAT>`) |
| http://studio.localhost:8100 | Studio (platform login) |
| http://`<slug>`.localhost:8100 | Each app: frontend at `/`, Supabase APIs at `/auth/v1`, `/rest/v1`, `/functions/v1` |
| `127.0.0.1:54350` | Postgres (`supabase_admin`, password `POSTGRES_PASSWORD` in `deploy/.env`) |
| http://127.0.0.1:2030 | Caddy admin API |

## Test users

| User | Role | Credentials |
|---|---|---|
| `admin@example.com` | admin, sees every app | `PLATFORM_ADMIN_PASSWORD` (Studio) and `PLATFORM_TOKEN` (MCP) in `deploy/.env.local` |
| `alice@example.com` (seed) | app builder, sees `todo-app` only | `alice-password` (Studio), `SEED_ALICE_TOKEN` (MCP) in `deploy/.env.local` |
| `bob@example.com` (seed) | app builder, sees `notes-app` only | `bob-password` (Studio), `SEED_BOB_TOKEN` (MCP) in `deploy/.env.local` |
| `demo-user@example.com` (seed) | app user of `todo-app` and `notes-app`, sees their own todos | `demo-password`, on http://todo-app.localhost:8100 and http://notes-app.localhost:8100 |

The seed passwords are fixed development credentials for the local stack only. Seed accounts are created by `deploy/install.sh --seed`; on a stack where alice or bob were already given other memberships by hand, they also see those apps.

To create other app builders for manual testing (the CLI runs inside the control plane container):

```bash
docker exec plat-control-plane node src/cli.ts create-user carol@example.com developer   # prints a PAT
docker exec plat-control-plane node src/cli.ts set-password carol@example.com --generate  # prints a password
docker exec plat-control-plane node src/cli.ts add-member <slug> carol@example.com developer
```

An app builder only sees, in Studio and through MCP, the apps they are a member of.

## Deploy an app with Claude Code

1. Export the token and install the plugin (details in [plugin/README.md](plugin/README.md)):

   ```bash
   export PLATFORM_TOKEN=...   # from deploy/.env.local, or a builder's PAT
   claude plugin marketplace add "$PWD"
   claude plugin install platform@platform-local
   ```

2. Copy the example app outside the repo, then ask Claude to deploy it:

   ```bash
   cp -R examples/todo-app /tmp/todo-app && cd /tmp/todo-app && git init -q && git add -A && git commit -qm init
   claude "deploy the app to the platform"
   ```

Claude creates the app, applies the migrations (the linter rejects unsafe ones), deploys the Edge Functions, builds and deploys the frontend, then prints the app URL (for instance http://todo-app.localhost:8100) and its Studio link.

## Tests

The stack must be running, and `deploy/.env.local` must exist.

```bash
pnpm typecheck                                     # all workspace packages (Studio's upstream typecheck excluded)
pnpm --filter @platform/control-plane test         # Studio access policy, unit
pnpm --filter @platform/control-plane e2e          # MCP end to end: provisioning, migrations, deployments, isolation
pnpm --filter @platform/control-plane e2e:studio   # Studio: login, per-app filtering, bypass attempts
(cd apps/edge-main-worker && deno test --allow-read --allow-write)
```

The end-to-end suites create throwaway apps and users and delete them at the end. `E2E_KEEP=1` keeps them for inspection.

## Deploying

Not production ready yet. The stack runs on a single VM with docker compose, as it does locally, but a few pieces are still missing:
- the domain is hardcoded to `*.localhost` (`deploy/caddy/caddy.json`, `install.sh`);
- there is no TLS: on-demand TLS with an `ask` endpoint on the control plane is planned;
- there are no backups, no centralized logs (Loki) and no admin UI.

Target setup ([PLAN_1.md](PLAN_1.md) §9): a Linux VM with 16 GB of RAM or more, a wildcard DNS record `*.<domain>` pointing to it, ports 80 and 443 open, an SMTP relay and an optional S3 bucket for backups, then `install.sh`. Production blockers are tracked as P1 in [docs/TECH_DEBT.md](docs/TECH_DEBT.md).
