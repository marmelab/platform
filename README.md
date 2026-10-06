# Platform

Self-hosted hosting for the apps your team builds with Claude Code. Each app gets its own Supabase backend (Postgres database, Auth, REST API, Edge Functions) and its static frontend, all served from a single VM. Developers ("app builders") don't use a UI to deploy: they ask Claude Code to "deploy the app to the platform", through an MCP server and a Claude Code plugin. They inspect their apps in a multi-project Supabase Studio. Admins see every app, in Studio and in an admin console.

> **Status: prototype.** Milestones M0 to M3 of [PLAN_1.md](PLAN_1.md) are validated (see `spikes/*/REPORT.md`), plus Studio access for app builders, most of the admin console (M4), Storage and Realtime (M5), app emails and company SSO (M6), and operations (M7: backups, production installer with HTTPS, upgrades, security linter). It runs locally, and installs on a VM with a real domain ([docs/INSTALL.md](docs/INSTALL.md)); it has not run in production yet (see [Deploying](#deploying)).

More docs:
- [docs/INSTALL.md](docs/INSTALL.md): production installation (domain, TLS, GitHub, SMTP, backups), hardening, upgrades;
- [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md): personas, main journeys, product decisions;
- [docs/TECH_DEBT.md](docs/TECH_DEBT.md): known debt and limitations;
- [apps/control-plane/README.md](apps/control-plane/README.md): control plane, MCP tools, admin REST API, admin CLI;
- [apps/admin/README.md](apps/admin/README.md): admin console (shadcn-admin-kit);
- [plugin/README.md](plugin/README.md): Claude Code plugin.

## Repository layout

```
apps/
  control-plane/      Hono API + MCP server + admin API + provisioning (Docker, Caddy, Postgres)
  admin/              admin console: shadcn-admin-kit SPA, served by the control plane on admin.<domain>
  edge-main-worker/   Deno main worker routing Edge Functions to the right app
  studio/             vendored supabase-studio-multi-head, patched for per-app access
packages/
  shared/             zod schemas and types shared by the API and the MCP server
  sql/                template database, per-app roles, linter queries
  deploy-cli/         platform-deploy: checks or deploys an app repo (GitHub OIDC in CI, or a PAT)
plugin/               Claude Code plugin (deploy and admin-deploy skills + MCP config)
ci/                   reusable GitHub Actions deploy workflow, and an example caller for app repos
deploy/               docker-compose stack ("plat"), Caddy bootstrap, install.sh, upgrade.sh
examples/todo-app/    example app: personal todo list (Vite + React + supabase-js)
examples/notes-app/   example app: notes shared between users (Vite + React + supabase-js)
spikes/               milestone reports and prototypes
```

## Prerequisites

- macOS or Linux, with Docker (Docker Desktop: 8 GB of RAM or more allocated)
- Node 24 and pnpm 10 (`corepack enable`)
- Deno 2 (Edge Functions unit tests only)
- `openssl`, `curl`
- Claude Code, to deploy apps through the plugin
- About 16 GB of free RAM on the host to build Studio (Next.js build, ~8 GB peak)

`*.localhost` resolves to `127.0.0.1` out of the box in browsers, in `curl` and on Linux, so no DNS setup is needed. On macOS, Node does not resolve these names (`ENOTFOUND`) and `/etc/hosts` has no wildcard: the deploy CLI (and the plugin, which ships it) resolves them itself, and the e2e tests need the same shim:

```bash
export NODE_OPTIONS="--import $PWD/packages/deploy-cli/src/localhost-dns.ts"
```

## Install and run locally

```bash
pnpm install
deploy/install.sh
```

`install.sh` is safe to rerun. It:
1. generates the stack secrets in `deploy/.env`, points the platform SMTP to the local mail catcher (mailpit, `SMTP_HOST=mailpit`), and adds a mock OpenID Connect provider for the company SSO and a test S3 store (`COMPOSE_PROFILES=mail,sso-test,s3-test`);
2. builds the Studio image on the first run, and the control plane image (which includes the admin console) (`STUDIO_BUILD=1 deploy/install.sh` forces a rebuild);
3. starts the `plat` docker compose project;
4. initializes the Postgres cluster (template database, `platform` database);
5. creates the first admin, and saves their personal access token (`PLATFORM_TOKEN`) and password (`PLATFORM_ADMIN_PASSWORD`, for Studio and the admin console) in `deploy/.env.local`.

Both files are gitignored.

To start with sample data (two app builders, two deployed example apps, two app users; see [Test users](#test-users)), add `--seed`. It is safe to rerun:

```bash
deploy/install.sh --seed
```

To stop or restart the stack:

```bash
docker compose -p plat -f deploy/docker-compose.yml stop
docker compose -p plat -f deploy/docker-compose.yml start
```

## URLs

| URL | What |
|---|---|
| http://api.localhost:8100/mcp | MCP server: browser sign-in from Claude Code (OAuth), or a PAT (`Authorization: Bearer <PAT>` or `X-Platform-Token: <PAT>`). Its OAuth token endpoint is announced on http://localhost:8100/oauth/token: Claude Code only sends token requests to HTTPS or loopback hosts |
| http://studio.localhost:8100 | Studio (platform login) |
| http://admin.localhost:8100 | Admin console, admins only (`PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` from `deploy/.env.local`); its REST API is under `/api` |
| http://`<slug>`.localhost:8100 | Each app: frontend at `/`, Supabase APIs at `/auth/v1`, `/rest/v1`, `/functions/v1` |
| http://localhost:8025 | Mailpit (local installs): every email sent by the platform and its apps (sign-up confirmations, password resets, invitations, notices) |
| http://localhost:8090 | Mock OpenID Connect provider (local installs): the "company IdP" for trying the company SSO; it signs in any email (see [Company SSO](#company-sso)) |
| `127.0.0.1:54350` | Postgres (`supabase_admin`, password `POSTGRES_PASSWORD` in `deploy/.env`) |
| http://127.0.0.1:2030 | Caddy admin API |

## Test users

| User | Role | Credentials |
|---|---|---|
| `admin@example.com` | admin, sees every app | `PLATFORM_ADMIN_PASSWORD` (Studio and admin console) and `PLATFORM_TOKEN` (MCP, admin API) in `deploy/.env.local` |
| `alice@example.com` (seed) | app builder, sees `todo-app` only | `alice-password` (Studio, and the browser sign-in from Claude Code), or `SEED_ALICE_TOKEN` (a PAT) in `deploy/.env.local` |
| `bob@example.com` (seed) | app builder, sees `notes-app` only | `bob-password` (Studio, and the browser sign-in from Claude Code), or `SEED_BOB_TOKEN` (a PAT) in `deploy/.env.local` |
| `demo-user@example.com` (seed) | app user of `todo-app` (3 todos) and `notes-app` (3 notes, 2 of them shared with `demo-user-2`) | `demo-password`, on http://todo-app.localhost:8100 and http://notes-app.localhost:8100 |
| `demo-user-2@example.com` (seed) | app user of `notes-app`, with one note shared read-only and one shared for editing | `demo-password`, on http://notes-app.localhost:8100 |

Seed accounts exist only after `deploy/install.sh --seed`. Their passwords are fixed development credentials for the local stack only.

### Trying the seeded apps

`todo-app` ([examples/todo-app](examples/todo-app)) and `notes-app` ([examples/notes-app](examples/notes-app)) are two different example apps. Each is a separate instance with its own database and its own user accounts.

- **todo-app, as an app user**: open http://todo-app.localhost:8100 and sign in as `demo-user@example.com` / `demo-password`. You can add, check and delete todos; the "x of y done" counter comes from the `summary` Edge Function. You can also sign up with a new account (the seed turns email confirmation off for its example apps; on other apps, open the confirmation email in mailpit, http://localhost:8025): it won't see `demo-user`'s todos (RLS), and it won't exist in `notes-app`.
- **notes-app, sharing between users**: open http://notes-app.localhost:8100 and sign in as `demo-user@example.com` / `demo-password`. "My notes" lists three notes: "Team offsite ideas" (shared read-only with `demo-user-2`), "Release checklist" (shared for editing) and "Personal reminders" (private). Open a note to edit it and to manage its sharing: share it with `demo-user-2@example.com`, change the permission, or remove the share. Sharing with an email that has no account in the app is refused. Then sign out, sign in as `demo-user-2@example.com` / `demo-password` and open "Shared with me": the shared notes are there, with their permission. You can edit "Release checklist" (the editor then shows you as the last editor), but "Team offsite ideas" is read-only, and you can neither delete a shared note nor reshare it. A new account sees no notes at all. `node apps/control-plane/scripts/verify-notes-app.ts` runs the same checks against the API.
- **As an app builder, in Studio**: sign in to http://studio.localhost:8100 as alice (only `todo-app` is listed) or bob (only `notes-app`). Users are under Auth > Users; the data is under Table editor (`todos` for `todo-app`; `notes`, `note_shares` and `profiles` for `notes-app`). The admin sees every app.
- **As an app builder, with Claude Code**: install the plugin without `PLATFORM_TOKEN` (see [Deploy an app with Claude Code](#deploy-an-app-with-claude-code)), sign in as `alice@example.com` / `alice-password` in the browser when Claude Code asks, then ask for instance "show me the logs of todo-app" or "add a priority column to the todos and redeploy". As alice, `notes-app` is reported as not found. The admin console's Tokens screen lists the connection ("Claude Code connection"), and revoking it makes Claude ask to sign in again. With a PAT instead: `export PLATFORM_TOKEN=<SEED_ALICE_TOKEN>` before starting Claude Code.

### Admin console

Open http://admin.localhost:8100 and sign in with `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` from `deploy/.env.local` (app builders are refused). It lists every app with its owners, linked repository, last release and flags (deployed outside CI, schema drift, accepted lints), and lets you stop, start or delete an app, roll back a deployment, manage its members, and manage platform accounts and tokens; every action is in the audit log. Screenshots: [apps/admin/screenshots](apps/admin/screenshots). Details: [apps/admin/README.md](apps/admin/README.md).

### Company SSO

The platform can delegate its logins (Studio, admin console) to the company's OpenID Connect provider, and apps can let their users sign in with it (M6 part 2). Local installs run a mock provider that signs in any email. To try it:

1. In the admin console, open **SSO** and set: issuer `https://idp.sso.test:8443`, discovery URL `http://idp:8090/.well-known/openid-configuration`, client ID `platform`, client secret `platform-secret`, then check **Enabled** and save.
2. Open http://studio.localhost:8100, click **Sign in with company SSO**, type `alice@example.com` (seed) or your admin email in the mock provider's form: you are signed in to Studio as alice (an unknown email is refused, unless "Unknown users" creates developers). The admin console's login page has the same button, for admins.
3. For an app's users, ask Claude (or call `configure_auth`) to enable company SSO on the app (`sso: {provider: "company"}`); the app then signs in with `supabase.auth.signInWithOAuth({ provider: "custom:company" })`.

Details, security checks and limits: [apps/control-plane/README.md](apps/control-plane/README.md#company-sso-m6-part-2).

To create other app builders for manual testing, use the admin console (Users, with a password: that is all a builder needs), or the CLI inside the control plane container:

```bash
docker exec plat-control-plane node src/cli.ts create-user carol@example.com developer   # prints a PAT
docker exec plat-control-plane node src/cli.ts set-password carol@example.com --generate  # prints a password
docker exec plat-control-plane node src/cli.ts add-member <slug> carol@example.com collaborator
```

An app builder only sees, in Studio and through MCP, the apps they are a member of.

## Deploy an app with Claude Code

1. Install the plugin (details in [plugin/README.md](plugin/README.md)):

   ```bash
   claude plugin marketplace add "$PWD"
   claude plugin install platform@platform-local
   ```

   At the first use, the `deploy` skill asks you to sign in: type `/mcp`, choose `plugin:platform:platform`, then **Authenticate**; the browser opens on the platform's login page (an account of the [test users](#test-users), e.g. alice), then asks you to allow the access. To use a PAT instead (admins, scripts), `export PLATFORM_TOKEN=...` (from `deploy/.env.local`) before starting Claude Code.

2. Copy the example app outside the repo, then ask Claude to deploy it:

   ```bash
   cp -R examples/todo-app /tmp/todo-app && cd /tmp/todo-app && git init -q && git add -A && git commit -qm init
   claude "deploy the app to the platform"
   ```

On a local install (`DIRECT_DEPLOY=everyone`, no CI configured), the `deploy` skill takes the direct path: it creates the app, writes and commits `.platform.json`, checks the secrets the functions read, runs `platform-deploy check` (migrations dry run with the security linter, build), then `platform-deploy deploy` (migrations, Edge Functions, frontend, smoke test), and prints the app URL (for instance http://todo-app.localhost:8100) and its Studio link.

> In production (`DIRECT_DEPLOY=admins`, `CI_ALLOWED_WORKFLOWS` set), the same request takes the CI path: the skill creates or links the GitHub repository, installs the workflow that calls the platform's reusable workflow, opens a PR and watches the GitHub Actions run; direct deployment is reserved to admins (`admin-deploy` skill, with a reason). See [docs/USER_JOURNEYS.md](docs/USER_JOURNEYS.md) B2 and A10, and [PLAN_1.md](PLAN_1.md) §6. The CI path has not run against GitHub yet.

Without Claude, the same deployment runs from a terminal with the deploy CLI (it reads `.platform.json`, which the skill writes):

```bash
PLATFORM_URL=http://api.localhost:8100 PLATFORM_TOKEN=... node packages/deploy-cli/src/main.ts deploy --dir /tmp/todo-app
```

In GitHub Actions, the app repo calls the reusable workflow `ci/.github/workflows/deploy.yml` (example caller: `ci/examples/platform.yml`), which runs the same CLI with a GitHub OIDC token; see [packages/deploy-cli/README.md](packages/deploy-cli/README.md). It has not run on GitHub yet: the e2e suite simulates the runner's token endpoint.

## Tests

The stack must be running, and `deploy/.env.local` must exist.

```bash
pnpm typecheck                                     # all workspace packages (Studio's upstream typecheck excluded)
pnpm --filter @platform/control-plane test         # unit: Studio access policy and CSRF guard, login throttling, access log reader
pnpm --filter @platform/control-plane e2e          # MCP end to end: provisioning, migrations, deployments, isolation; CI API; platform-deploy
pnpm --filter @platform/control-plane e2e:studio   # Studio: login and throttling, CSRF, per-app filtering, bypass attempts
pnpm e2e:admin                                     # admin REST API, load metrics, then the admin console in Chromium (Playwright)
pnpm --filter @platform/control-plane e2e:sso      # company SSO with the mock IdP (also part of e2e)
pnpm --filter @platform/control-plane e2e:lints    # security linter rules and stored results (also part of e2e)
pnpm --filter @platform/control-plane e2e:tls      # on-demand TLS ask endpoint (also part of e2e); HTTPS checks on a production-mode stack
node apps/control-plane/scripts/verify-notes-app.ts # seeded notes-app: sharing rules, as its app users (after --seed)
(cd apps/edge-main-worker && deno test --allow-read --allow-write)
```

The end-to-end suites create throwaway apps and users and delete them at the end. `E2E_KEEP=1` keeps them for inspection.

## Deploying

`deploy/install.sh --production --domain <domain> --acme-email <email> --admin-email <email>` installs the platform on
a Linux VM: HTTPS on `api.`, `admin.`, `studio.` and `<app>.<domain>` with certificates obtained on demand by Caddy
(Let's Encrypt) for the hosts the control plane approves, publishing through GitHub Actions only
(`DIRECT_DEPLOY=admins`), no test service. `deploy/upgrade.sh` upgrades it (backups first, apps recycled without
downtime, verification, rollback instructions). The whole procedure (prerequisites, DNS, firewall, GitHub
organization, SMTP, backups and the master key, first login, hardening checklist, upgrades and measured downtime) is in
[docs/INSTALL.md](docs/INSTALL.md).

Not yet done: centralized logs (Loki), a run on a public VM with Let's Encrypt and a real GitHub organization (the CI
path has only run against a simulated GitHub). Production blockers are tracked as P1 in
[docs/TECH_DEBT.md](docs/TECH_DEBT.md).
