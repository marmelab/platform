# Supabase app hosting platform for Claude Code teams — Architecture

> The platform's design: decisions, how each part works, and the known risks. Milestone tags (M0 to M7) name the development step that delivered a feature. Limitations and remaining work: [TECH_DEBT.md](TECH_DEBT.md).

## 1. Vision

SMBs that equip their staff with Claude Code end up with dozens of apps (SPA + Supabase backend) and no serious place to host them. The platform provides, **installed on the customer's premises (self-hosted)** on a VM:

- "Supabase instances" created on the fly (Postgres, Auth, REST, Storage, Realtime, Edge Functions);
- static hosting for the SPAs;
- **no UI for developers**: an MCP server + a Claude Code skill ("Claude, deploy the app to the platform");
- **deployment always done by the company's GitHub CI**, after its checks (security, review): the skill installs the job, it does not deploy by itself. Direct deployment from the developer's machine remains possible when the platform allows it (`DIRECT_DEPLOY` setting, §6.3): local installs and e2e tests without GitHub;
- an **admin console** (shadcn-admin-kit) to manage accounts, tokens, apps and instances.

Sizing target: **40 to 60 apps** per install (several apps per employee), on a single VM.

## 2. Decisions

| Topic | Decision |
|---|---|
| Distribution | Self-hosted at the customer's (docker compose + installer) |
| Tenancy | **Shared option B**: one Postgres cluster, one *database* per app, Supabase services shared when they are multi-tenant |
| Admin | **shadcn-admin-kit** (Marmelab) |
| Edge Functions | **In the MVP** (business logic lives there, not in stored procedures) |
| App auth | Supabase Auth (GoTrue), internal and public apps, company SSO through SAML / OAuth (Entra ID, Google, Keycloak…) |
| Developer interface | Remote MCP + skill, packaged as a **Claude Code plugin** |
| Frontend build | **In CI** (GitHub Actions), upload of `dist/` |
| Deployment path | **Always GitHub CI**, from the default branch of the repo linked to the app, through a reusable workflow maintained by the admin. Direct deployment governed by `DIRECT_DEPLOY` (§6.3): `admins` in production (audited exception), `everyone` for a local install (deployment from the developer's machine remains possible, e2e tests run without GitHub) |
| Source code | Each app is linked to a repo of the company's GitHub organization. The admin reads the code on GitHub: **no code interface in the platform** |
| CI auth | **GitHub OIDC**: no long-lived deployment secret (§5.1) |
| Language | TypeScript everywhere (Deno for the Edge Functions main worker) |

## 3. Target architecture

```
                         ┌──────────────────────────── Customer VM ───────────────────────────┐
 Claude Code ──MCP/HTTPS──► Caddy (on-demand TLS, routing by host + path)                       │
 (plugin: skill + .mcp.json)   │                                                               │
 GitHub Actions ─HTTPS+OIDC─►  │  (deployments, §5.1)                                         │
 Browsers ──HTTPS──────────►   ├── admin.<domain>         → Admin (shadcn-admin-kit, static)    │
                               ├── api.<domain>           → Control plane (REST API + /mcp)     │
                               ├── studio.<domain>        → Multi-head Studio (1 instance)      │
                               └── <app>.<domain>                                               │
                                     /                    → static files /sites/<app>/current
                                     /auth/v1/*           → GoTrue <app>        (1 container/app)
                                     /rest/v1/*           → PostgREST <app>     (1 container/app)
                                     /storage/v1/*        → Storage (multi-tenant, shared)
                                     /realtime/v1/*       → Realtime (multi-tenant, shared)
                                     /functions/v1/*      → Edge Runtime (shared, router main worker)
                                                                                                │
   Postgres (supabase/postgres image): 1 database per app + 1 "platform" database               │
   PgBouncer (transaction mode) in front of the app databases: PostgREST and Storage            │
   Loki + Vector (logs)   ·   shared postgres-meta (used by Studio)                             │
   pg_dump backups → customer's S3                                                              │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key point**: each app's Supabase API is served **on the same origin as the SPA** (`SUPABASE_URL = https://<app>.<domain>`). There is no CORS to handle, and `supabase-js` works as is thanks to the `/auth/v1`, `/rest/v1`, etc. prefixes.

### 3.1 Shared Postgres

- A **template database** `template_supabase`, prepared once: extensions, schemas (`auth`, `storage`, `extensions`, `supabase_migrations`…), standard grants. Creating an app comes down to `CREATE DATABASE app_<id> TEMPLATE template_supabase`, in a few seconds.
- **Postgres roles are global to the cluster.** The NOLOGIN roles `anon`, `authenticated` and `service_role` are shared, which is not a problem since grants are per object, hence per database. **LOGIN roles are per app** (`app_<id>_authenticator`, `app_<id>_auth_admin`, `app_<id>_storage_admin`), with `REVOKE CONNECT ... FROM PUBLIC` on each database. GoTrue, Storage and the template's migrations run with these per-app role names instead of the fixed ones (`supabase_auth_admin`, `authenticator`).
- Application migrations are tracked in `supabase_migrations.schema_migrations`, **the same table as the Supabase CLI**, to stay compatible with the local `supabase start` / `supabase migration new` workflow.
- **Connections**: about 50 apps × (PostgREST pool + GoTrue + Storage + Realtime) risks saturating `max_connections`. **Done** (`apps/control-plane/README.md`, section "Connection pooler"): a single PgBouncer in transaction mode (preferred over Supavisor: a process of a few MB, with no metadata database nor tenant API; authentication through `auth_query` with the per-app roles) carries PostgREST and Storage; GoTrue, Realtime (replication slots tied to the session) and the owner role stay direct. An app without traffic no longer holds a PostgREST or Storage server connection; PostgREST's schema cache is reloaded by a `LISTEN pgrst` relay in the control plane (one connection per started app).
- `log_line_prefix` with `%d` to attribute Postgres logs to an app.

### 3.2 Per-app vs shared services

| Service | Mode | Notes |
|---|---|---|
| GoTrue | 1 container / app | Lightweight (a few tens of MB). Runs its migrations in the app's DB. SMTP, providers and SSO config per app |
| PostgREST | 1 container / app | Single-database by design. JWT secret specific to the app |
| Storage API | Shared, multi-tenant mode | Tenants registered through Storage's admin API (tenant = slug, passed by Caddy in `X-Forwarded-Host`), role `app_<id>_storage_admin`, `storage.*` migrations run by Storage. Local file backend in V1 (`tenants/<slug>/`, customer S3 as an option). Validated in M5: ~0.12 GB in total, connections released when idle |
| Realtime | Shared, multi-tenant | Tenants registered through the Realtime API (tenant = first label of the `Host`, set by Caddy), role `app_<id>_realtime` (`REPLICATION`), temporary logical slot per app for `postgres_changes`. Validated in M5: ~0.2 GB in total; tenant migrations run with an ephemeral superuser (accepted trade-off); "Broadcast from Database" for every app thanks to a patched image (slot named after the tenant, `patches/realtime`, upstream PR to propose); direct connections, without the pooler |
| Edge Runtime | Shared | See 3.3 |
| Studio | 1 shared instance (multi-head fork) | See 3.6 |
| postgres-meta | 1 shared instance | Target connection passed by Studio in an encrypted header |

Memory estimate: 50 apps × (GoTrue + PostgREST) ≈ 2.5 to 3 GB, plus the shared services and Postgres. A 16 GB VM is recommended; the measurements were made on Docker Desktop, not yet on a VM with 50 apps (TECH_DEBT DEP-2).

Each app has its own **JWT secret**, and the `anon` and `service_role` keys are generated at creation. They use the "legacy" JWT key format, the best supported in self-hosted; the new publishable/secret keys are not supported (TECH_DEBT EDGE-5).

### 3.3 Multi-tenant Edge Functions (MVP)

- A single `supabase/edge-runtime` container, with a **custom main worker** (Deno, TS) that:
  1. reads the target app from a header injected by Caddy (`X-Platform-App`), never from the client request;
  2. resolves `/functions/<app>/current/<function>/index.ts`;
  3. creates a **user worker** with the app's env variables (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, plus the secrets defined through `set_secrets`), memory and CPU limits, and a timeout.
- Per-app envs are read from a read-only mounted JSON file that the control plane regenerates, or through an internal call to the control plane with a cache.
- Deployments are versioned like the frontend (`/functions/<app>/<version>/`, `current` symlink).
- `npm:` / `jsr:` dependencies are downloaded on first call, hence a persistent Deno cache. Behavior behind a corporate proxy is untested (TECH_DEBT DEP-3).
- Isolation by V8 isolate, not by container. It is acceptable for code written by trusted employees (§11).
- JWT verification (`verify_jwt`) is configured per function through `supabase/config.toml` or `deno.json`, as on Supabase Cloud.

### 3.4 Static frontend

- Upload of a `tar.gz` of `dist/` into `/sites/<app>/<version>/`, then atomic switch of the `current` symlink. Rollback means repointing the symlink.
- Caddy serves the files with an SPA fallback (`try_files {path} /index.html`), a long cache on hashed assets and `no-cache` on `index.html`.
- Build variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) are provided by `get_app` and injected at build time by the skill. The `service_role` key **never** appears in the frontend.

### 3.5 Routing and TLS

- **Caddy** is the single entry point, configured by the control plane through its **JSON admin API**. Adding or removing an app requires no restart.
- **On-demand TLS** with an `ask` endpoint on the control plane, which only allows the hosts of known apps. This avoids depending on a DNS API at the customer's: a wildcard DNS record `*.<domain>` pointing to the VM is enough. Custom domains become possible later.
- A stopped app serves a maintenance page.

### 3.6 Supabase Studio: multi-head fork

The official Studio is open source (Apache 2.0) but **single-project in self-hosted**, and one Studio per app costs too much RAM per open instance. The platform therefore vendors the **[supabase-studio-multi-head](https://github.com/flamingrubberduck/supabase-studio-multi-head)** fork in `apps/studio/`: **a single instance** that handles every app. The vendored commit is in `apps/studio/UPSTREAM.md`, and the platform's changes, one commit each, in `apps/studio/PLATFORM_PATCHES.md`.

- **Projects come from the control plane**: Studio fetches the project configs (external mode: database connection, `public_url`, keys) from the control plane's internal API instead of the fork's `projects.json`, scoped to the identity of the request. Project ref = app slug. Registering an app (`StudioRegistry.register`) only prepares the database grants of its owner role.
- **postgres-meta is shared**: Studio passes the target connection string in the `x-connection-encrypted` header (key `PG_META_CRYPTO_KEY`).
- **Access**: Studio on `studio.<domain>` behind the control plane's forward auth (platform login, local account or company SSO). Caddy passes the identity to Studio in signed headers. A builder only sees the apps they are a member of; an admin sees every app.
- **The fork's provisioning modes are not used**: the `stack` mode creates a full Docker Compose stack per project, and the `embedded` mode only creates a database that shares the default stack's GoTrue and PostgREST. The platform's provisioning (§4.2) does that job. The fork's backups, replicas, failover, PocketBase and Authelia features are not used either; backups are in the control plane (§3.9).
- **No app key in the browser**: the features that would call the app's API from the browser with a "temporary" key (which the fork serves as the permanent `service_role` key) go through Studio's server instead.
- **What does not work**: the Functions tab (the fork's functions folder is global) and the Logs tab (no Logflare). Builders use the MCP tool `get_logs` and their repository instead.
- **License**: the multi-head additions are under a **Sustainable Use License** (the upstream code stays Apache 2.0). It allows internal use, and hosting for one's direct customers as long as the multi-head features are not the core of a resold offering. It is not an OSI open source license.
- Studio stays **replaceable** behind the `StudioRegistry` interface (`register(app)`, `unregister(app)`, `deepLink(app)`): the official Studio started on demand, one instance per app, or an official multi-project Studio if upstream adds one.

### 3.7 App auth, SSO and emails

- **Shared SMTP** (customer relay or Brevo, Scaleway TEM…) injected by default into each GoTrue, with a sender and templates per app.
- **SSO**:
  - OAuth / OIDC through GoTrue providers (Azure/Entra ID, Google, Keycloak, WorkOS…), configured per app;
  - SAML 2.0 through GoTrue (enabled by env, providers added through the GoTrue admin API): not wired yet (TECH_DEBT SSO-1).
  - On the admin side: a **"company SSO" defined once at the platform level** and enabled in one click on an app. This is the typical case of an internal app.
- For internal apps, a complementary option: restrict signup to an email domain or disable signup.
- **Done (M6, part 1)**: platform SMTP (env + `settings` table, encrypted password, never returned) injected into each GoTrue (`GOTRUE_SMTP_*`, confirmation mandatory as soon as an SMTP is configured, links on the app's `/auth/v1/verify`); sender = app name and platform address, overridable per app; default GoTrue templates (custom templates: debt CP-17). MCP tool `configure_auth` (owner or admin, audited): signup on/off, confirmation, allowed email domains (GoTrue `before-user-created` hook, Postgres function in the app's database), redirect URLs, sender. Mailpit locally and in e2e tests. See `apps/control-plane/README.md`, section "Email". Remaining: simple OAuth providers, platform SSO.
- **Done (M6, part 2)**: company **OIDC** SSO, one provider for the platform, configured by the admin (SSO screen of the admin console or `sso_*` settings: issuer, client, encrypted secret, allowed domains, `email_verified` required, on-the-fly creation of unknown users as developers disabled by default, password login reserved to admins as an option). Login to Studio and to the admin console: authorization code with PKCE, state and nonce in an encrypted cookie, ID token verified with the issuer's JWKS (`jose`), accounts linked by verified email on first login then by the IdP's `sub`, logins audited. For apps: `configure_auth({ sso: { provider: "company" } })` adds the provider to the app's GoTrue as the custom provider `custom:company` (GoTrue v2.196 `/admin/custom-providers` admin API), platform client, app callback to register at the IdP; supabase-js `signInWithOAuth({ provider: "custom:company" })`. Simulated OIDC provider in the local stack and e2e tests (`plat-idp`). Remaining: SAML (platform and apps), per-app clients, revocation from the IdP (debt SSO-1 to SSO-4). See `apps/control-plane/README.md`, section "Company SSO".

### 3.8 Logs

- Vector collects Docker logs (labels `platform.app=<id>`, `platform.service=<gotrue|postgrest|…>`), Caddy access logs, Postgres logs (`%d` prefix) and Edge Runtime logs (prefixed by app by the main worker), then ships them to **Loki**.
- These logs are exposed in the admin (per-app log view) and through the MCP tool `get_logs`, essential for Claude Code to debug autonomously.

### 3.9 Backups

- Daily `pg_dump` per database to the customer's S3, with configurable retention, plus an archive of Storage files.
- Restore from the admin (into the same app or a new app). Also useful to clone an environment.
- **Done (M7, part 1)**: daily backup of each app (`backup_hour` UTC, one at a time, advisory lock): `pg_dump -Fc`, Storage files, live versions of the frontend and functions (older versions can be rebuilt from the repo), app keys and secrets encrypted with the master key; `backups` table (types scheduled, manual, pre_restore, final; status, size, location, error). `backups` volume by default, or an S3-compatible bucket (`backup_s3_*` settings, SigV4 client `aws4fetch`, the volume then only serves as a staging area). Retention: N daily and M weekly, manual backups by age, final backups from `delete_app` kept separately. Failures: admin dashboard and email to admins. Restore (admins only, console and CLI, audited) into the same app, after a backup of the current state: `pg_restore` into a fresh database created from `template0` then name swap, files, live versions and secrets put back, app restarted; or re-creation of a deleted app under the same slug, with the same keys. MCP: `list_backups`, `create_backup`. See `apps/control-plane/README.md`, section "Backups". Remaining: restore into another app (cloning), PITR, client-side dump encryption (TECH_DEBT CP-19 to CP-22).

## 4. Control plane

- **Stack**: Node + TypeScript, **Hono**, Postgres (`platform` database of the same cluster), Drizzle or Kysely, **dockerode** to drive the containers.
- **`Orchestrator` abstraction** (create, start, stop, remove, status, stats) with a Docker implementation in V1. Nomad or K8s possible later.
- **`Router` abstraction** (Caddy admin API).
- **Secrets** (JWT secrets, service keys, app secrets) encrypted at rest (AES-GCM, master key in the VM's env).
- **Jobs** (provisioning, backups): simple queue in the database (pg-boss or equivalent). For now (M7): backup scheduler in the control plane (one run per day claimed in the database, one backup at a time); manual backups and restores are synchronous (TECH_DEBT CP-5, CP-20).

### 4.1 Data model (`platform` database)

- `users` (id, email, name, role `admin | developer`, active)
- `tokens` (id, user_id, name, hash, scopes, optional allowed apps, expires_at, last_used_at, revoked_at)
- `apps` (id, slug, name, owner_id, status `provisioning | running | stopped | error | deleted`, db_name, studio_ref, github_repo `owner/name`, github_repo_id, default_branch, created_at)
- `app_members` (app_id, user_id, role)
- `app_secrets` (app_id, key, encrypted value), for edge functions
- `app_auth_config` (app_id, signup on/off, email confirmation, allowed email domains, redirect URLs, sender; providers and SSO to come): the app's auth policy (`configure_auth`, M6), no row = defaults
- `releases` (id, app_id, source `ci | direct`, status `running | succeeded | failed`, commit_sha, ref, ci_run_id, ci_run_url, github_actor, created_by (PAT of a direct deployment), admin_exception, reason, started_at, finished_at): one CI run (one attempt) = one release, which groups its deployments; a direct deployment creates a `direct` release, marked `admin_exception` when it is an admin while `DIRECT_DEPLOY=admins`
- `settings` (key, value): platform settings changed on the fly (CLI), taking precedence over the control plane's env (including the platform SMTP `smtp_*`, encrypted password)
- `deployments` (id, app_id, release_id, kind `frontend | functions | migrations`, version, status, created_by, created_at, manifest)
- `app_metrics` (app_id, hour, requests, 5xx responses, DB size, container memory): sampled by the control plane for the admin's app view (§8)
- `uploads` (id, deployment_id, single-use token, expires_at)
- Company SSO (M6): a single OIDC provider, in the `sso_*` settings of `settings` (encrypted secret); `users.sso_issuer` and `users.sso_subject` (IdP identity linked to the account); `app_auth_config.sso_provider` (`company`)
- `backups` (id, app_id, slug, type `scheduled | manual | pre_restore | final`, status `running | succeeded | failed`, started_at, finished_at, size, location: volume path or `s3://...`, files, manifest, error, author) and `backup_state` (day claimed by the scheduler, summary of the last run): M7, §3.9
- `audit_log` (who, what, when, on which app)

### 4.2 App provisioning (`create_app`)

1. Create the app's LOGIN roles and `CREATE DATABASE ... TEMPLATE template_supabase`.
2. Generate the JWT secret and the anon and service_role keys.
3. Start the GoTrue and PostgREST containers (labels, internal network, memory limits).
4. Register the tenant in Storage and Realtime (M5: roles `app_<id>_storage_admin` and `app_<id>_realtime`; Storage migrates `storage.*` at registration; the Realtime tenant is created with an ephemeral superuser then switched to the app's role).
5. Create `/sites/<app>/` and `/functions/<app>/` with a placeholder page.
6. Add the Caddy routes.
7. Register the app in Studio (`StudioRegistry.register`: database grants of the owner role; Studio then fetches the app's config from the control plane).
8. Status `running`, then return the URL and anon key.

Each step must be idempotent, with resume on error and a symmetric `delete` operation.

## 5. MCP server

- Exposed as **Streamable HTTP** on `https://api.<domain>/mcp`, auth through the `Authorization: Bearer <token>` header. The token is a PAT created by an admin, stored hashed in the database.
- The official TypeScript MCP SDK is mounted in the control plane, and each tool checks user → app rights.

| Tool | Description |
|---|---|
| `whoami` | User, accessible apps, `direct_deploy` (can this user publish with their PAT) and `ci` (the `uses:` of the reusable workflow to call and the company's GitHub organization, derived from `CI_ALLOWED_WORKFLOWS`) |
| `list_apps` / `get_app` | Status, URL, `SUPABASE_URL`, anon key, latest version; `get_app` also returns `schema_drift` (schema changes outside releases since the last successful release, §7) |
| `list_schema_changes(app, all?)` | Schema changes recorded by the DDL event trigger: those outside releases by default, all of them with `all` |
| `create_app(name)` | Provisioning (§4.2) |
| `link_repo(app, repo, repository_id, default_branch)` | Links the app to its GitHub repo (app owner; change audited) |
| `apply_migrations(app, migrations[], dry_run?, release_id?)` | SQL content of the `supabase/migrations/*` files. Applies only the new ones, in a transaction. Then runs the **security linter** (§7) and returns its alerts. With `DIRECT_DEPLOY=admins`, a builder only has `dry_run`; actual application goes through CI (§5.1) |
| `execute_sql(app, sql, write=false)` | Read-only by default. Writing is explicit and logged |
| `list_tables(app)` / `generate_types(app)` | Introspection, generation of the database's TS types |
| `create_deployment(app, kind, release_id?)` | Returns a **pre-signed upload URL** (single use, short TTL). Admins only if `DIRECT_DEPLOY=admins` |
| `finalize_deployment(deployment_id)` | Verifies, extracts, switches `current`, reloads the functions. Admins only if `DIRECT_DEPLOY=admins` |
| `begin_release(app, commit_sha?, reason?)` / `finish_release(release_id, status)` | Direct deployment: groups the following publications into a `direct` release. Without a release, each publication is its own release |
| `list_deployments` / `rollback(app, version)` | History (with commit and CI run) and rollback to a version already deployed by CI |
| `set_secrets(app, secrets)` / `list_secrets(app)` | Edge function secrets (values never returned) |
| `configure_auth(app, …)` | Providers, platform SSO on/off, signup, redirect URLs |
| `get_logs(app, service?, since?, query?)` | Filtered Loki query |
| `stop_app` / `start_app` | For the app owner |

**Files do not go through MCP arguments**, which would bloat the context. `dist/` and `supabase/functions/` are archived and sent with `curl` to the pre-signed URL.

**Rights per identity**, depending on the `DIRECT_DEPLOY` setting (§6.3): with `admins` (production), a builder PAT no longer has access to the publishing tools (`apply_migrations` without `dry_run`, `create_deployment`, `finalize_deployment`, `begin_release`): the call is refused with a message pointing to CI. It keeps reading, logs, `execute_sql`, `set_secrets`, `configure_auth`, member management, `rollback` and `stop_app` / `start_app`. Admins keep everything. With `everyone` (local install), builders also keep the publishing tools.

### 5.1 Deployment API for CI

- Same operations as the MCP deployment tools, exposed as REST on `api.<domain>/ci/apps/<app>/…` (`GET` = `get_app`, `migrations`, `release` and `release/finish`, `deployments` and `deployments/<id>/finalize`; details in `apps/control-plane/README.md`) and called by a **deployment CLI** (`platform-deploy`, TypeScript), itself called by the reusable workflow (§6.2). The admin also uses it for a direct deployment, with their PAT (MCP).
- Auth: **GitHub OIDC token** (`permissions: id-token: write`, audience = platform URL). The control plane verifies the signature (JWKS of the configured issuer: github.com or GHES) and the claims:
  - `repository_id` = `apps.github_repo_id` (stable even if the repo is renamed);
  - to publish: `ref` = the app's default branch;
  - `job_workflow_ref` in the list of reusable workflows allowed by the admin (`CI_ALLOWED_WORKFLOWS`: an entry `…/deploy.yml@refs/heads/main` requires that exact ref, an entry without `@` accepts every ref of the file; pin a ref in production). This is what guarantees that the company's checks ran: modifying the workflow in the app's repo is not enough to bypass them.
  - signature verified with `jose` (issuer's JWKS cached), `iss`, `aud` (the API URL by default), `exp`.
- **Check** mode (pull requests, any ref of the linked repo): `get_app` and `apply_migrations` in `dry_run` only.
- Each run creates a `release` (commit, run, GitHub actor), identified by the token's `run_id` and `run_attempt`: a token from another run cannot publish to it. Accepted lints come from `.platform.json` (`acceptedLints`), hence from code review, and remain audited.
- A stopped app (`stop_app`) refuses any publication by CI; `get_app` and `dry_run` remain possible.
- Function secrets stay on the platform (`set_secrets` by the builder): nothing to store in GitHub. Fallback without OIDC (old GHES, another forge): one deployment token per app as a GitHub environment secret restricted to the default branch. Out of V1.

## 6. Claude Code plugin, CI and deployment

```
plugin/
  .claude-plugin/plugin.json
  .mcp.json                     # url: ${user_config.platform_url}, asked when the plugin is enabled; browser sign-in (OAuth), or a PAT in X-Platform-Token
  deploy-cli/                   # platform-deploy shipped in the plugin, with its composite action (action.yml)
  skills/build/SKILL.md         # target architecture of the apps (Vite + React, supabase-js, migrations with RLS, functions)
  skills/deploy/SKILL.md        # CI setup, then push and run follow-up; direct deployment if allowed
  skills/admin-deploy/SKILL.md  # direct deployment, admins only (§6.3)
.github/workflows/deploy.yml    # reusable workflow maintained by the admin (§6.2), `workflow_call` only: never runs here
packages/deploy-cli/            # package of platform-deploy (typecheck, tests): src -> ../../plugin/deploy-cli
```

The plugin and the reusable workflow live in the **same internal repo** of the company (the plugin marketplace), whose Actions access is open to the organization's other repos: a copy of this repository pushed by the admin, with no change: each builder enters the instance's URL when the plugin is enabled (INSTALL.md §7). The workflow runs the composite action of its own repository at the running commit (`uses: $/plugin/deploy-cli`), so the copy needs no patching and upgrades are a pull and a push.

### 6.1 `deploy` skill (builder)

"Deploy the app to the platform" goes through CI whenever possible: the skill checks and installs what is missing, then lets CI publish. Direct deployment from the developer's machine (`platform-deploy` with the PAT) remains available when `whoami` returns `direct_deploy: true` (`DIRECT_DEPLOY=everyone`, or an admin), if there is neither a repo nor CI, or if the user asks for it.

1. Read `.platform.json` at the repo root (app id, `acceptedLints`). If absent, `create_app` then write the file.
2. Check that the project is an SPA (Vite) and locate `supabase/migrations` and `supabase/functions`.
3. GitHub repo: if there is no remote in the company's organization, create it (`gh repo create`). `link_repo` with `owner/name`, `repository_id` and the default branch.
4. Function secrets: find the `Deno.env.get(...)` calls, compare with `list_secrets`, ask the user for the missing values, `set_secrets`.
5. CI, only if absent: `.github/workflows/platform.yml` that calls the reusable workflow on `push` (default branch) and `pull_request`, with `id-token: write`; `PLATFORM_URL` variable at the repo level if it does not exist at the organization level.
6. Prior review of the new migrations, and `apply_migrations` in `dry_run`: report the lints, **stop if tables are exposed without RLS**. Add a lint to `acceptedLints` only with the user's explicit consent.
7. Commit and push (or a PR if the default branch is protected), then `gh run watch`. Show the app URL, the Studio link and the run link. On failure: run logs (`gh run view --log-failed`), `get_logs`, diagnosis.

Path choice: CI if `whoami.ci` exists and the project has (or the user wants) a repo in `ci.github_org`; direct if `direct_deploy` and no repo nor CI, or on explicit request; otherwise, explanation and stop. The migration review (step 6) goes in both cases through `platform-deploy check` with the PAT (`dry_run` stays open to builders). The default branch must be protected for CI to publish: the skill checks it and offers a minimal protection (PR required). The calling workflow is written from `plugin/skills/deploy/assets/platform.yml` (shipped in the plugin) with the `uses:` from `whoami.ci`.

Distribution: a plugin marketplace internal to the customer (Git repo), installed in one command. The developer signs in through the browser at the first use (USER_JOURNEYS B1); PATs in `PLATFORM_TOKEN` stay for admins and scripts. The developer also needs the `gh` CLI logged in.

Local development stays standard (`supabase start` with the official CLI). Migrations are the contract between local and the platform.

### 6.2 Reusable workflow

Input `mode: deploy | check`. Steps:

1. **Company checks**, defined by the admin: dependency analysis, secret scanning, SAST, etc. These are those of the customer's existing CI; the platform does not impose a list.
2. `npm ci`, then `platform-deploy` with the OIDC token:
   - `check`: `dry_run` of migrations and lints, build; result in the run summary and as a PR comment;
   - `deploy`: migrations (rejection of any new `ERROR` lint absent from `acceptedLints`), functions (warmed up before the switch), build with the variables from `get_app`, frontend, smoke test.

Required reviews, required checks and branch protection remain configured by the customer on GitHub (rulesets); the platform does not check them, and the `deploy` skill does not protect the branch it creates (every push to the default branch deploys).

### 6.3 Direct deployment by an admin (exception)

The **`DIRECT_DEPLOY`** platform setting (control plane env, changeable on the fly with the `set-setting` CLI) decides who can publish with a PAT:

- `admins` (**to use in production**, default value when absent): only admins publish directly, and each direct release by an admin is marked `admin_exception` (the audited exception below);
- `everyone`: any app member publishes with their PAT, as in M3. `install.sh` writes it in `deploy/.env` for a local install: e2e tests, the seed and the direct path of the `deploy` skill run without GitHub.

`admin-deploy` skill, for an emergency (CI down), an app without CI or an app takeover (A5):

- reserved to admin PATs when `DIRECT_DEPLOY=admins`; asks for a **reason** (`begin_release`);
- runs the same `platform-deploy` as CI, from a local checkout of the linked repo; refuses a modified tree (untracked files included), a commit missing from the remote repo or a checkout of a repo other than the linked one (`preflight.sh`);
- creates a `release` with `source = direct` (`admin_exception`, reason, admin account), audited; the app is flagged "deployed outside CI" in the admin until the next deployment by CI.

## 7. Security safeguards

- **CI as the only publication path** (with `DIRECT_DEPLOY=admins`, except for the admin exception): the company's security checks before any deployment, guaranteed by the OIDC claims (`repository_id`, `ref`, `job_workflow_ref`, §5.1); code review is the organization's rulesets. The deployed code is always a commit of the linked repo, which the admin can read on GitHub.
- **Linter** after each `apply_migrations`: tables in the `public` schema without RLS, `USING (true)` policies on sensitive tables, exposed `SECURITY DEFINER` functions, etc. It relies on **splinter**, Supabase's open source linter. Result visible in the MCP response, on the PR and in the admin. **Done (M7, part 2)**: 16 rules rewritten from splinter (the splinter repository declares no license: no verbatim copy), lint names kept (`packages/sql/lints.sql`, `lints_storage.sql`); each run is recorded in `lint_runs` (after each validated batch of migrations, with its release; on demand from the admin or the CLI; sweep every 6 h for changes outside releases); "Security linter" tab of the app page, "lint errors" flag and dashboard card. See `apps/control-plane/README.md`, section "Security linter".
- **Schema changes outside CI: accepted and detected.** Studio's SQL editor and `execute_sql(write=true)` act with the owner role and can modify the schema outside CI. We keep them (data fixes, emergencies), but a DDL event trigger (in `template_supabase`) logs any change made outside a release, and the app is flagged in the admin. Implementation: `ddl_command_end` and `sql_drop` event triggers (`SECURITY DEFINER` functions of `supabase_admin`, unexposed `_platform` schema, app roles without any right on it) that record command, object, session role, `application_name` and transaction id; sessions of `supabase_admin` (provisioning) and GoTrue (`app_<id>_auth_admin`) are ignored. The control plane notes the transaction id of each migration batch it validates: a change whose transaction is not among them is "outside release" (cannot be forged by the app, unlike a session GUC). Applied at every control plane startup to the template and the existing apps. `get_app.schema_drift` counts changes outside releases since the last successful release, `list_schema_changes` details them.
- The `service_role` key is never returned by `get_app` (only injected into edge functions).
- `execute_sql` in write mode: explicit flag and logging in `audit_log`.
- Network isolation: only Caddy and the control plane are exposed, app containers are on an internal network.
- Memory and CPU limits per container and per user worker.

## 8. Admin (shadcn-admin-kit)

Static SPA served on `admin.<domain>`, REST data provider to the control plane (endpoints compatible with the format expected by the chosen data provider). Implementation (M4 phase 1): the SPA and its API are served by the control plane on `admin.<domain>` (same origin, API under `/api`, `ra-data-simple-rest` data provider), see `apps/admin/README.md` and `apps/control-plane/README.md`.

Admin auth: local accounts, and company OIDC SSO (M6, part 2); the admins' password remains the emergency access.

Screens:
- **Dashboard**: number of apps per status, VM RAM/CPU/disk, Postgres cluster size, alerts (apps in error, linter, failed backups). Linter and platform version done (M7, part 2). Failed backups done (M7): failures of the last 7 days, apps without a backup for 36 h, last daily run.
- **Users**: CRUD, role, activation.
- **Tokens**: creation (value shown only once), revocation, last use, scopes.
- **Apps**: list of **all apps**, filterable and sortable: name and URL, status, owner (name and email), **link to the GitHub repo**, last deployment (date, commit, author, run link, CI or admin source, result), **load overview** (requests and 5xx over 24 h with a 7-day sparkline, DB size, container memory, from `app_metrics`), flags (deployed outside CI, schema modified outside CI, accepted lints, abandoned). The app page includes:
  - service status, **Stop / Start / Delete** actions;
  - releases (commit, CI run, GitHub diff since the previous one) and their deployments (frontend, functions, migrations) with **rollback**;
  - edge functions, secrets (names only);
  - auth and SSO config;
  - **logs** (Loki);
  - security linter results;
  - backups and restore (done, M7: Backups tab with "Backup now" and "Restore…", global Backups screen with the deleted apps);
  - **"Open in Studio"** link (deep link to the project in multi-head Studio).
- **Platform SSO**: shared OIDC provider (done, M6 part 2: SSO screen); SAML to come.
- **Audit log**.

## 9. Installation at the customer's

- `deploy/` directory containing a `docker-compose.yml` for the core (Postgres, Caddy, control plane, admin, Storage, Realtime, Edge Runtime, multi-head Studio, postgres-meta, Loki, Vector) and an `install.sh` script, which checks the prerequisites, generates the secrets, initializes the template database and creates the first admin.
- Customer prerequisites: a Linux VM (16 GB+ recommended for 50 apps), a wildcard DNS `*.<domain>`, ports 80/443, an SMTP, an S3 bucket for backups (optional; otherwise backups stay on the VM, to be copied elsewhere), a copy of `PLATFORM_MASTER_KEY` outside the VM (without it, the keys and secrets of backed-up apps are unreadable), a **GitHub organization** (github.com or GHES with OIDC). The API must be reachable by the GitHub Actions runners (otherwise, self-hosted runners in the customer's network), and the control plane must reach the OIDC issuer.
- GitHub configuration at install: publication of the internal repo (marketplace + reusable workflow), addition of the company's checks to the workflow, list of allowed `job_workflow_ref` (`CI_ALLOWED_WORKFLOWS`), `DIRECT_DEPLOY=admins`, `PLATFORM_URL` organization variable.
- **Supabase component versions pinned**, aligned with a release of the official Supabase `docker-compose`. Platform upgrades go through a control plane migration script, then a progressive recycling of the GoTrue and PostgREST containers, app by app.
- **Done (M7, part 2)**: `install.sh --production --domain <domain>` (prerequisites, wildcard DNS checked, secrets, `DIRECT_DEPLOY=admins`, no test service nor flag, SMTP, GitHub OIDC, backup S3, first admin), on-demand TLS by Caddy with the control plane's `ask` endpoint (platform hosts and existing app hosts only), `deploy/upgrade.sh` (backups, images, migrations at startup, app-by-app recycling without downtime, `realtime-migrate`, linter, verification, rollback instructions), version recorded in `platform_versions` and shown in the admin. Guide: [INSTALL.md](INSTALL.md).

## 10. Monorepo structure

```
apps/
  control-plane/      # Hono + MCP + orchestrator + jobs
  admin/              # shadcn-admin-kit
  edge-main-worker/   # Deno main worker for the edge runtime
  studio/             # vendored multi-head Studio, patched for per-app access (§3.6)
packages/
  shared/             # types, zod schemas shared by API/MCP/admin
  sql/                # template_supabase, roles, linter
  deploy-cli/         # platform-deploy, used by CI and by admins
plugin/               # Claude Code plugin (build, deploy and admin-deploy skills + .mcp.json)
deploy/               # docker-compose, Caddy bootstrap, install.sh (--env-file: the values infra/ produces)
infra/                # provisioning modules per provider (aws/: OpenTofu), all producing the same env file
examples/todo-app/    # example app: personal todo list (Vite + supabase-js + 1 edge function)
examples/notes-app/   # example app: notes shared between users
```

## 11. Risks and open questions

- **Global Postgres roles**: the NOLOGIN roles are shared by all apps, and an app's owner role can read cluster-wide catalogs (names, settings, activity; no data). Inherent to a shared cluster (§3.1, TECH_DEBT).
- **Number of Postgres connections** at 50+ apps: lifted by the PgBouncer pooler (`apps/control-plane/README.md`, section "Connection pooler"); Realtime, connected directly, remains the main consumer (4 connections and one walsender per recently used app, TECH_DEBT PG-5).
- **Maturity of multi-tenant** Storage and Realtime in self-hosted (M5): lifted for Storage; for Realtime, tenant migrations require a superuser (worked around, accepted trade-off) and the "Broadcast from Database" slot was shared by the whole instance (fixed by a patched image, upstream fix to propose). Plan B rejected (memory).
- **Noisy neighbour**: an app that loads the cluster impacts all the others. Mitigation through per-role `statement_timeout`, per-database connection limits and monitoring.
- **Supabase upgrades**: compatibility of GoTrue and Storage migrations across 50 databases. Tooled procedure (`deploy/upgrade.sh`, M7 part 2); never tested on an actual GoTrue or Storage version upgrade.
- **Edge function isolation** (isolates, not containers): accepted for code written by trusted employees; a V8 or edge-runtime flaw would break isolation between apps.
- **Multi-head Studio**: non-OSI license (Sustainable Use License, §3.6), young project with a single maintainer, drift from upstream Studio. Mitigation: vendored code with its patches listed, replaceable behind `StudioRegistry`.
- **GitHub dependency**: a GitHub Actions incident blocks deployments (fallback: admin deployment, §6.3). Customers on another forge are not covered in V1.
- **Reachability from CI**: an internal platform is not reachable by GitHub-hosted runners. To check before each install.
