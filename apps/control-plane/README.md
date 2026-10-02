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

After a code change: `docker compose -p plat -f deploy/docker-compose.yml up -d --build control-plane` (the image also builds the admin console, `apps/admin`).

The per-app images (`GOTRUE_IMAGE`, `POSTGREST_IMAGE`) are pulled by the control plane when missing: in the background at startup, and before creating a container (concurrent provisionings share one pull). A failed pull (registry unreachable, Docker Hub rate limit) fails the provisioning with the registry's error.

## MCP

- URL: `http://api.localhost:8100/mcp`, with the `Authorization: Bearer <PAT>` header.
- Claude Code: `claude mcp add --transport http platform http://api.localhost:8100/mcp --header "Authorization: Bearer $PLATFORM_TOKEN"`
- Tools: `whoami`, `list_apps`, `get_app`, `create_app`, `link_repo`, `apply_migrations`, `execute_sql`, `create_deployment`, `finalize_deployment`, `begin_release`, `finish_release`, `list_deployments`, `rollback`, `set_secrets`, `list_secrets`, `list_members`, `add_member`, `remove_member`, `stop_app`, `start_app`, `delete_app`, `list_schema_changes`, `get_logs`, `list_auth_users`, `invite_user`, `delete_user`, `ban_user`, `unban_user`.
- `whoami` also returns `direct_deploy` (whether this user may publish with their PAT: always for admins, for everyone with `DIRECT_DEPLOY=everyone`), `direct_deploy_setting`, and `ci`: `{ uses, github_org }` derived from the first `CI_ALLOWED_WORKFLOWS` entry (`org/platform/.github/workflows/deploy.yml@refs/heads/main` gives `uses: org/platform/.github/workflows/deploy.yml@main`), or `null` when CI deployment is not set up. The plugin's `deploy` skill picks its path from these fields.
- Archives don't go through MCP: `create_deployment` returns a `PUT http://api.localhost:8100/uploads/<token>` URL (single use, 15 min) and a ready-to-use `tar` + `curl` command.

## Releases, direct deployment and `DIRECT_DEPLOY`

A **release** groups the deployments (migrations, functions, frontend) of one publication. `releases.source` is `ci` (one GitHub Actions run attempt, through the CI API below: commit, run URL and GitHub actor from the OIDC claims) or `direct` (a PAT through MCP: the platform account in `created_by`). `get_app` returns the app's `last_release`, and `list_deployments` the `release_id` of each deployment.

Direct deployment through MCP: `begin_release(app, commit_sha?, reason?)` opens a release, its `release_id` is then passed to `apply_migrations` and `create_deployment` (`finalize_deployment` follows the deployment), and `finish_release(release_id, succeeded|failed)` closes it. Without `release_id`, each successful publication is recorded as its own finished release. `platform-deploy` with a PAT (`PLATFORM_TOKEN`) drives exactly this sequence, with the commit of the local checkout and `--reason`. A release can only be used by the app it belongs to, while `running`; `finish_release` through MCP only closes `direct` releases.

The platform setting **`DIRECT_DEPLOY`** decides who publishes with a PAT:

- `admins` (default when unset; **use it in production**): builder PATs are refused the publishing tools (`apply_migrations` without `dry_run`, `create_deployment`, `finalize_deployment`, `begin_release`) with an error that points to CI. They keep everything else (reads, `dry_run`, `execute_sql`, secrets, members, `rollback`, `stop_app` / `start_app`). Admins keep the publishing tools: their releases are flagged `admin_exception = true` (the audited exception of PLAN_1 §6.3, with an optional `reason` given to `begin_release`).
- `everyone`: every member of the app publishes with their PAT (the M3 model). `deploy/install.sh` writes `DIRECT_DEPLOY=everyone` into `deploy/.env` for local installs, so that the e2e suites, the seed (`platform-deploy` with the builders' PATs) and the direct path of the `deploy` skill work without GitHub.

The tools stay listed for builders; the refusal happens at call time, so that Claude gets the explanation.

## CI deployment API (GitHub OIDC)

The same operations as the MCP deployment tools, for GitHub Actions (called by `platform-deploy`, see [`packages/deploy-cli`](../../packages/deploy-cli/README.md), from the reusable workflow `ci/.github/workflows/deploy.yml`), on `http://api.localhost:8100/ci/apps/<slug>/...`, authenticated by a GitHub OIDC token in `Authorization: Bearer` (`permissions: id-token: write`, audience = the platform API URL). No PAT and no long-lived secret in GitHub.

| Request | Mode | Body | Does |
|---|---|---|---|
| `GET /ci/apps/<slug>` | check | | `get_app`, plus `mode` and `check_reasons` |
| `POST /ci/apps/<slug>/migrations` | check if `dry_run: true`, else deploy | `{migrations, dry_run?, accept_lints?}` | `apply_migrations` (rejected lints: HTTP 422 with the same body as MCP) |
| `POST /ci/apps/<slug>/release` | deploy | | opens the run's release (idempotent per run attempt) |
| `POST /ci/apps/<slug>/deployments` | deploy | `{kind}` | `create_deployment` in the run's release (upload URL as in MCP) |
| `POST /ci/apps/<slug>/deployments/<id>/finalize` | deploy | | `finalize_deployment`, only for a deployment of the run's release |
| `POST /ci/apps/<slug>/release/finish` | any | `{status: succeeded\|failed, error?}` | closes the run's release |

The run's release is identified by the token's `run_id` and `run_attempt`: the client does not pass ids, and a token from another run cannot publish into it. Errors are `{error}` with 401 (token), 403 (workflow, repository, check mode), 409 (no release for the run, app stopped), 400 (invalid body, release already finished).

Every request checks, in this order:

1. the signature against the issuer's JWKS (`jose`, RS256; keys cached 10 min and refetched on an unknown `kid`), `iss` = `OIDC_ISSUER`, `aud` = `OIDC_AUDIENCE`, `exp` (30 s clock tolerance), and the GitHub claims the API uses;
2. `job_workflow_ref` against `CI_ALLOWED_WORKFLOWS`: this is what guarantees that the company checks ran, since editing the app repo's workflow does not change the reusable workflow it calls;
3. `repository_id` = the app's `github_repo_id` (`link_repo`), stable across renames. An unknown app and an app linked to another repository give the same 403.

Then the mode: **deploy** when `ref` = `refs/heads/<default_branch>` and `ref_protected` = `true`; **check** otherwise (pull requests, other branches, unprotected default branch), which only allows `GET` and migrations `dry_run`. A **stopped** app refuses every publishing request (409 `{"error": "APP_STOPPED: ...", "code": "APP_STOPPED"}`); `GET` and `dry_run` stay available.

Audit: CI actions are recorded with no `user_id` and `actor: github:<login>` in the details; `create_release` records the commit, run URL and actor.

## Schema changes outside releases

Every app database (and `template_supabase`) has two event triggers, `platform_record_ddl` (`ddl_command_end`) and `platform_record_drop` (`sql_drop`), from [`packages/sql/schema_changes.sql`](../../packages/sql/schema_changes.sql). They record each DDL command into `_platform.schema_changes`: time, transaction id (`xid8`), command tag, object type and identity, session role, `application_name` (`platform-migrations`, `platform-execute-sql`, `postgres-meta <version>` for Studio...). Temporary objects, extension members, and the sessions of `supabase_admin` (provisioning, Studio registration) and `app_<id>_auth_admin` (GoTrue's migrations at boot) are not recorded.

Protection: the schema, table, trigger functions (`SECURITY DEFINER`, `search_path = ''`) and event triggers belong to `supabase_admin`; the app roles have no privilege on `_platform` (not exposed by PostgREST either), cannot drop or disable event triggers they do not own, and cannot set `session_replication_role`. The SQL is idempotent and re-applied at every control plane start (to the template, briefly opened for connections, and in `syncAll` to every app) and at provisioning, which also re-enables disabled triggers. Limits: TECH_DEBT CP-15.

Release membership is decided by transaction, not by a session setting the app could forge: `apply_migrations` (MCP and CI) stores the transaction id of each committed batch in the migrations deployment's `manifest.txid`. A recorded change whose transaction is not one of them was made outside a release. `get_app` returns `schema_drift: { count, last_at, since }`: the commands recorded outside releases since the start of the last succeeded release (`since`, null if none; a single statement can record several commands, e.g. a table and its sequence), `null` if the app database cannot be read. `list_schema_changes(app, all?, limit?)` lists them, newest first; `all: true` lists every recorded change with `in_release` and `release_id`.

## Settings

Platform settings come from the control plane's environment (`deploy/docker-compose.yml`, values from `deploy/.env`), and can be overridden at runtime without a restart by a row of the `settings` table: `docker exec plat-control-plane node src/cli.ts set-setting <key> <value>`, `unset-setting <key>` to go back to the environment, `settings` to print the effective values. They are read on every CI request and every MCP publishing call.

| Key | Environment | Default | |
|---|---|---|---|
| `direct_deploy` | `DIRECT_DEPLOY` | `admins` (`everyone` written by `install.sh`) | see above |
| `ci_allowed_workflows` | `CI_ALLOWED_WORKFLOWS` | empty: every CI token is refused | comma-separated. `owner/repo/.github/workflows/deploy.yml@refs/heads/main` matches that exact `job_workflow_ref`; without `@`, any ref of that workflow file. Pin a ref (branch or tag) in production. Case-sensitive |
| `oidc_issuer` | `OIDC_ISSUER` | `https://token.actions.githubusercontent.com` | GHES: `https://<host>/_services/token`. The run URL of a release uses `https://github.com`, or the issuer's origin for GHES |
| `oidc_audience` | `OIDC_AUDIENCE` | the API URL (`http://api.localhost:8100`) | the `audience` asked by the workflow |
| `oidc_jwks_url` | `OIDC_JWKS_URL` | `<issuer>/.well-known/jwks` | |
| `oidc_jwks` | none | unset | **test only**: inline JWKS (JSON) trusted instead of `oidc_jwks_url`; the e2e suite uses it as a fake issuer. Honoured (and accepted by `set-setting`) only when the control plane runs with `ALLOW_TEST_OIDC_JWKS=1`, which `install.sh` writes into `deploy/.env` for local installs; never set that variable in production |

The control plane must reach the issuer's JWKS. Behind an HTTP proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` in the control plane's environment.

## Apps

Each `<slug>` app is served at `http://<slug>.localhost:8100`: `/` (static, SPA fallback), `/auth/v1`, `/rest/v1`, `/functions/v1`.

Routing (`router.ts`): two generic Caddy routes serve every app, installed once at startup (`apps-by-host` on the public server, `apps-by-path` on the internal one). The slug comes from the host (`<slug>.<APPS_DOMAIN>`, matched against the slug pattern) or from the first path segment; the upstreams are `plat-<slug>-auth:9999` and `plat-<slug>-rest:3000`, the static root `/sites/<slug>/current`. Whether an app is served is decided on each request by a marker file in its sites directory: `.stopped` (maintenance, checked first), `.running` (served), neither (unknown app, 404). Creating, stopping, starting and deleting an app only writes or removes these markers: the Caddy config does not change, so these operations never reload Caddy. A Caddy reload drops the first request sent on a connection the old server had accepted but not used yet (a client's spare pooled connection), which made e2e suites fail with `fetch failed` (TECH_DEBT TT-4, paid off). The remaining config changes (the generic routes after an upgrade, the Studio route) are one `PATCH` of both servers' routes, guarded by Caddy's `ETag` and skipped when unchanged, so a control plane restart does not reload Caddy either. The first start after the upgrade from per-app routes removes the former `app-<slug>` routes in that same change.

## Studio

`http://studio.localhost:8100`: multi-head Studio (`apps/studio`), project ref = app slug, `studio_url` deep link in `get_app`. Platform login on `/_platform/login` (local account with password), then forward auth (`/studio/verify` on the internal `:3001` listener): a builder only sees the apps they are a member of, an admin sees everything. Details: `spikes/m0ter-studio-builders/REPORT.md`.

Studio and `execute_sql` connect as `app_<id>_owner`, which does **not** have `BYPASSRLS`. It owns the `public` tables, so their RLS does not apply to it (as for Supabase's `postgres`). In `auth`, it only reads `auth.users` and `auth.identities` (Auth > Users), through a `platform_owner_read` policy (`FOR SELECT TO app_<id>_owner`); every other `auth` table is denied. `register` (app creation, `syncAll` at control plane startup) re-applies the grants and recreates missing policies: after a GoTrue upgrade whose migrations recreate an `auth` table, restart the control plane (or re-run `create_app`) to repair them.

## App users (B5)

The app's own users (accounts of its GoTrue, not platform members) are managed by any member of the app, owner or collaborator, and by admins (`src/auth-users.ts`).

- `list_auth_users(app, page?, per_page?, filter?)`: `id`, `email`, `created_at`, `last_sign_in_at`, `invited_at`, `confirmed`, `banned`, `banned_until`, newest first, with `total`; `filter` is a case-insensitive substring of the email. It reads `auth.users` as the owner role (as Studio's Auth > Users, through the `platform_owner_read` policy), so it also works on a stopped app.
- `invite_user(app, email)`: there is no SMTP before M6, and GoTrue's `/invite` needs one to send its email. The tool calls `/admin/generate_link` with `type: invite` instead: GoTrue creates the user (unconfirmed, `invited_at` set) and returns the link without sending anything. The tool returns that `invite_link` (single use, valid 24 h: `GOTRUE_MAILER_OTP_EXP`) with `email_sent: false`, for the builder to hand over privately. Opening it confirms the address, signs the person in and redirects to the app with the session in the URL fragment; the app then lets them set a password (`supabase.auth.updateUser`), unless it uses magic links. Inviting again a pending invitation returns a new link (the previous one stops working); an address already registered is refused. GoTrue's own `action_link` drops the `/auth/v1` path of `API_EXTERNAL_URL`, so the tool builds the link on the app's public `/auth/v1/verify` from the hashed token.
- `delete_user(app, user_id | email)`: hard delete (`DELETE /admin/users/<id>`); rows of the app's tables follow their foreign keys to `auth.users`.
- `ban_user(app, user_id | email, duration_hours?)` (indefinitely by default) and `unban_user`: GoTrue's `ban_duration`. A banned user can no longer sign in nor refresh a session; access tokens already issued stay valid until they expire (1 h, TECH_DEBT CP-16).

Writes go to the app's GoTrue admin API directly on the `plat` network (`http://plat-<slug>-auth:9999`), with a `service_role` JWT signed by the control plane with the app's JWT secret and valid one minute: no key or secret is returned. They are refused on a stopped app (`APP_STOPPED`, `requireWritable`; its GoTrue is stopped anyway), and an unreachable GoTrue gives an explicit error. They are audited (`invite_user`, `delete_user`, `ban_user`, `unban_user`) with the acting user, the target email and user id, never the invite link.

## Admin REST API

The admin console (`apps/admin`, [README](../admin/README.md)) and its API are served by the control plane on the admin host, same origin: `http://admin.localhost:8100` (`ADMIN_HOST`), API under **`/api`** (`src/admin/`). Same origin rather than `api.<domain>/admin`: no CORS to configure, and the session cookie stays host-only on the admin host. Caddy proxies the whole admin host to the control plane (route `admin`, installed at startup with the Studio route); on that host the control plane serves only the SPA (`ADMIN_STATIC_DIR`, built into the image) and `/api/*` (no MCP, CI API or uploads), and the API is not served on the other hosts.

**Authentication.** Admins only (`users.role = 'admin'`, active), checked on every request:

- `Authorization: Bearer <PAT>` of an admin (scripts, tests);
- or the platform session cookie: `POST /api/auth/login {email, password}` reuses the sessions of Studio's `/_platform/login` (`sessions` table, `platform_session` cookie, `SESSION_TTL_SECONDS`), refuses non-admins (403, no session), and sets the cookie host-only, `HttpOnly`, `SameSite=Strict`. `GET /api/auth/me` returns the identity, `POST /api/auth/logout` deletes the session.

**CSRF.** Every `<app>.<domain>` is same-site with the admin host, so `SameSite` does not stop a builder's frontend from sending requests with an admin's cookie. With the cookie (not with a PAT), the API refuses any request whose `Sec-Fetch-Site` is neither `same-origin` nor `none`, and every mutation (and the login) must carry `Origin: <admin origin>` and `X-Platform-Admin: 1`: a cross-origin page cannot send that header without a CORS preflight, which the API never grants. The SPA sends it on every request. Login has no rate limiting yet (TECH_DEBT SEC-3).

**Conventions** ([ra-data-simple-rest](https://github.com/marmelab/react-admin/tree/master/packages/ra-data-simple-rest)): `GET /api/<resource>?sort=["field","ASC"]&range=[0,24]&filter={...}` returns an array and `Content-Range: <resource> 0-24/<total>`; `filter={"id":[...]}` (getMany) and `filter={"<field>": value}` (getManyReference) are supported; `GET|PUT|DELETE /api/<resource>/<id>`, `POST /api/<resource>` return the record. Errors are `{message}` with 400 (validation, guard refused, e.g. last owner), 401, 403, 404, 405, 409 (conflict; `code: "APP_STOPPED"` for a write on a stopped app). Lists are filtered, sorted and paginated in memory except the audit log (SQL).

| Resource | Operations | Notes |
|---|---|---|
| `users` | list (`q`, `role`, `active`), get, create `{email, name?, role, password?, active?}`, update `{name, role, active, password?}`, delete | Computed: `has_password`, `app_count`, `owned_app_count`, `active_token_count`, `last_token_use`, `last_login`. Disabling (`active: false`) deletes the account's sessions; its PATs stop working (`authenticate` checks `active`). An admin cannot disable, demote or delete themselves. Delete is refused (409) while the account is the last owner of an app; the apps it created move to another owner. Audited: `create_user`, `update_user` (changes), `set_password`, `delete_user` |
| `tokens` | list (`q`, `user_id`, `status`), get, create `{user_id, name, expires_at?}`, delete = revoke | The value is returned once, in `token`, on creation (only its hash is stored). `status`: `active`, `revoked`, `expired`. Revoking keeps the row. Scopes and per-app restrictions exist in the schema but are not enforced yet. Audited: `create_token`, `revoke_token` (never the value) |
| `apps` | list, get (id = slug) | Filters: `q` (slug, name, repository, owner), `status`, `owner_id`, and the flags `outside_ci`, `admin_exception`, `schema_drift`, `accepted_lints`, `no_repo`, `last_release_failed`, `stopped`. Fields: `url`, `studio_url`, `owners` (`{id, email, name}`), `github_repo`, `github_url`, `last_release` (`source`, `status`, `commit_sha`, `commit_url`, `ci_run_url`, `github_actor`, `created_by`, `admin_exception`, `reason`, dates), `last_release_at`, `frontend_version`, `functions_version`, `db_size`, `flags` (`outside_ci`: the last release was published with a PAT; `schema_drift`: count of DDL outside releases, as `get_app`, computed for the returned page only unless filtered or sorted on; `accepted_lints`: ERROR lints accepted by migrations; `no_repo`). `get` adds `services` (containers and state). No create, update or delete: see the actions |
| `POST /api/apps/<slug>/stop`, `/start` | | `stopApp` / `startApp` (B8), returns `{changed, status, data: <app>}` |
| `POST /api/apps/<slug>/delete` | `{confirm: <slug>, backup?: true}` | `deleteAppConfirmed`: final backup unless `backup: false` |
| `POST /api/apps/<slug>/rollback` | `{kind: frontend\|functions, version?}` | `rollback` (refused on a stopped app) |
| `GET /api/apps/<slug>/logs` | `?service=&since_minutes=60&limit=200&q=` | `get_logs` |
| `app_members` | list (`app`, `user_id`, `q`), get, create `{app, email \| user_id, role}`, update `{role}`, delete | id `<slug>:<user id>`. `addMember` / `removeMember`: the app always keeps an owner |
| `releases` | list (`app`, `q`), get | With `deployments` (`kind`, `version`, `status`), `commit_url` and `compare_url` (GitHub diff since the previous succeeded release with a commit). GitHub links use github.com, or the GHES host of `oidc_issuer` |
| `deployments` | list (`app`, `kind`) | `live`, `rollbackable` (a `ready` frontend or functions version) |
| `secrets` | list (`app`) | Names and `updated_at` only, never the values |
| `schema_changes` | list (`app` required, `all`) | `list_schema_changes`: outside releases since the last succeeded release, or every recorded change |
| `audit_log` | list (`app`: slug, also matches deleted apps through `details.slug`; `user_id`; `action`: one or several; `q`; `created_at_gte` / `created_at_lte`), get | Sort: `created_at`, `id`, `action`, `user_email`, `app` |
| `GET /api/dashboard` | | Apps by status, accounts, active tokens, flagged apps, failures of the last 7 days, Postgres cluster and app databases size, host memory, CPUs, load and volumes disk (seen from the control plane container, `os` module and `statfs`) |

Every action reuses the domain functions of the MCP tools and the CLI (`stopApp`, `deleteAppConfirmed`, `rollback`, `addMember`...), with their guards, and is audited with the admin as `user_id`.

Example: `curl -H "Authorization: Bearer $PLATFORM_TOKEN" 'http://admin.localhost:8100/api/apps?filter={"outside_ci":true}'`.

## Admin CLI (inside the container)

```bash
docker exec plat-control-plane node src/cli.ts create-user bob@example.com developer   # prints a new PAT
docker exec plat-control-plane node src/cli.ts stop-app demo                            # maintenance page, containers stopped, read-only
docker exec plat-control-plane node src/cli.ts start-app demo
docker exec plat-control-plane node src/cli.ts delete-app demo                          # final backup first (path printed)
docker exec plat-control-plane node src/cli.ts delete-app demo --no-backup              # no backup: the data is lost for good
docker exec plat-control-plane node src/cli.ts delete-user bob@example.com             # also deletes their sessions, tokens and memberships
docker exec plat-control-plane node src/cli.ts set-password bob@example.com --generate         # prints a Studio password
docker exec -i plat-control-plane node src/cli.ts set-password bob@example.com < password.txt  # or reads it from stdin
docker exec plat-control-plane node src/cli.ts add-member demo bob@example.com collaborator   # owner|collaborator
docker exec plat-control-plane node src/cli.ts remove-member demo bob@example.com          # idempotent, refuses to remove the last owner
docker exec plat-control-plane node src/cli.ts init                                     # idempotent, also run at startup
```

App roles: a `collaborator` deploys, inspects the app and manages its users; an `owner` can also manage members, stop, start and delete the app; platform admins can do everything on every app. Memberships created with the former `developer` role are renamed `collaborator` by the idempotent schema migration run at startup.

Membership changes apply to open Studio sessions and PATs on their next request: Studio forward auth and MCP read the user's apps from the database on every request. Member changes are recorded in `audit_log` (`add_member`, `remove_member`), with the acting user for MCP calls and no user for the CLI, which acts as the operator. `add_member` and `remove_member` (MCP and CLI) refuse any change that would leave the app without an owner; through MCP, only an owner of the app or an admin can call them, and the target account must already exist.

Stopping and deleting (journey B8): `stop_app`, `start_app` and `delete_app` are reserved to an owner of the app or an admin. All three write `audit_log` entries and `stop_app` / `start_app` are idempotent (`changed: false`).

- **Stop.** `stop_app` first switches the app to a 503 maintenance response (its `.stopped` routing marker) (HTML page, or `{"code":"APP_STOPPED"}` on `/auth/v1`, `/rest/v1` and `/functions/v1`), then stops the `plat-<slug>-auth` and `plat-<slug>-rest` containers, so functions cannot run either (the edge is only reachable through those routes). It then makes the app **read-only**: `alter database app_<id> set default_transaction_read_only = on`, and terminates the sessions of the app's own roles (owner, authenticator, auth admin: Studio's pg-meta, functions) so that their next session gets the setting; the platform's admin sessions opt out with `-c default_transaction_read_only=off`. Finally `apps.status = 'stopped'` (shown by `whoami`, `list_apps` and `get_app`).
- **Read-only.** One guard (`requireWritable` in `apps.ts`) refuses every write of a stopped app with `APP_STOPPED: app "<slug>" is stopped and read-only, <action> is refused`: `execute_sql` with `write`, `apply_migrations` without `dry_run`, `set_secrets`, `create_deployment`, `finalize_deployment`, `rollback`, `begin_release`, `link_repo`, the app user writes (`invite_user`, `delete_user`, `ban_user`, `unban_user`), and the CI API's publishing requests (409). Reads (including `list_auth_users`), `execute_sql` without `write`, migrations `dry_run` (run in an explicit `begin read write` transaction, always rolled back), logs, `get_app`, members, `start_app` and `delete_app` stay available. In Studio, reads work and SQL editor or table editor writes fail with `cannot execute ... in a read-only transaction`. This is a guardrail, not a security boundary: a session of the owner role can still opt out with `SET` or `BEGIN READ WRITE` (an accepted trade-off, see TECH_DEBT "Accepted trade-offs"). At control plane startup, `syncAll` re-applies the maintenance routes and the database setting from `apps.status`; `create_app` refuses a stopped app.
- **Start.** `start_app` resets the database setting, then re-runs the idempotent provisioning (containers restarted, routes restored, status `running`). An upload made before the stop can be finalized once started.
- **Delete.** `delete_app` is irreversible and requires `confirm` to repeat the slug. It reuses `deleteApp` (as the `delete-app` CLI), which first takes a **final backup** into the `backups` volume (`/data/backups` in the control plane, `BACKUPS_DIR`), one directory per deletion, `<slug>-<UTC timestamp>/`: `database.dump` (`pg_dump --format=custom`, run in the Postgres container so that it always matches the server; check it with `pg_restore --list`), `sites.tar.gz` and `functions.tar.gz` (every deployed version), `manifest.json` (no secret: the app's keys and function secrets are not kept). If the backup fails, nothing is deleted. The tool returns the backup path, and the `delete_app` audit entry keeps the slug, the backup path and the file sizes in `details` (its `app_id` becomes null when the app row is deleted). Restore, retention and off-site copies are M7 (TECH_DEBT CP-14): backups stay until removed by hand. `backup: false` (CLI: `delete-app <slug> --no-backup`) skips the final backup, with the same rights (owner or admin) and the same confirmation: the data is lost for good, and the audit entry records `backup: null` and `backup_skipped: true` (`false` when a backup was taken).

## Tests

```bash
pnpm -r typecheck
pnpm --filter @platform/control-plane test        # Studio access policy (unit), then plugin/test/scripts.test.sh (skills' scripts, no stack)
pnpm --filter @platform/control-plane e2e         # requires the running stack and deploy/.env.local; also runs test/ci.e2e.test.ts, test/deploy-cli.e2e.test.ts, test/plugin.e2e.test.ts and test/admin.e2e.test.ts
pnpm --filter @platform/control-plane e2e:deploy-cli  # platform-deploy alone (direct and CI modes, builds examples/todo-app: needs npm registry access)
pnpm --filter @platform/control-plane e2e:plugin  # the plugin skills' commands on examples/todo-app (direct path of deploy, admin-deploy)
pnpm --filter @platform/control-plane e2e:studio  # Studio: login, filtering, isolation
pnpm --filter @platform/control-plane e2e:admin   # admin REST API (test/admin.e2e.test.ts, also part of e2e), then the admin console in Chromium (apps/admin)
```

The e2e suites never touch existing apps or users. Each run creates disposable resources named after a run id: one app `e2e-<id>` for `e2e` (plus `e2e-<id>-ci` and its owner and collaborator for the CI suite, `e2e-<id>-cli` for the `platform-deploy` suite, `e2e-<id>-plg` and its builder for the plugin suite, `e2e-<id>-adm` and two builders for the admin API suite, `e2e-<id>-ui` and its builder for the admin console smoke test), two apps `e2e-<id>-a` / `e2e-<id>-b` and two builders `e2e-<id>-alice@example.com` / `e2e-<id>-bob@example.com` (random passwords, kept in memory) for `e2e:studio`. They are deleted at the end of the run, even when a test fails, with `delete-app --no-backup`, then `delete-user` (after the apps: a user who created an app cannot be deleted while it exists); the `after` hook then checks that nothing is left (platform rows, sessions, tokens, memberships, containers, sites directory with its routing marker, database and roles) and fails the suite otherwise. The CI suite (`test/ci.e2e.test.ts`) acts as a fake GitHub OIDC issuer: it generates an RS256 key pair, sets `oidc_issuer`, `oidc_jwks` and `ci_allowed_workflows`, toggles `direct_deploy`, and restores the previous settings in its `after` hook. It expects `DIRECT_DEPLOY=everyone` and `ALLOW_TEST_OIDC_JWKS=1` in the environment (local install). The `platform-deploy` suite (`test/deploy-cli.e2e.test.ts`) uses the same fake issuer, and also serves its tokens on a local `ACTIONS_ID_TOKEN_REQUEST_URL`, so that the CLI runs unchanged as in GitHub Actions. Every suite first waits for the control plane to answer through Caddy (`waitForControlPlane`), so it can start right after `docker compose up` returns. Suites that change settings must not run concurrently (two runs at once overwrite each other's issuer, and can restore each other's values). `e2e` test 12 deletes its app with the final backup (checked with `pg_restore --list`) and test 13 deletes a second app (`e2e-<id>-nb`) with `backup: false` and checks that no backup directory is created; the cleanup also removes the run's own backups (`/data/backups/<slug>-*`). Set `E2E_KEEP=1` to keep the apps for inspection (their slugs are printed), then remove them with `delete-app`.

## Technical access (dev)

| Item | Value |
|---|---|
| Postgres | `127.0.0.1:54350`, `supabase_admin` / `POSTGRES_PASSWORD` from `deploy/.env`; `platform` database |
| Caddy admin | `http://127.0.0.1:2030` (generic routes `apps-by-host`, `apps-by-path`, `studio` and `admin`; per-app state in the `.running` / `.stopped` markers of `plat_sites`) |
| Volumes | `plat_sites`, `plat_functions`, `plat_apps-config`, `plat_uploads`, `plat_backups`, `plat_deno-cache`, `plat_db-data` |
| Containers | `plat-db`, `plat-caddy`, `plat-edge`, `plat-control-plane`, `plat-studio`, `plat-studio-meta`, and per app `plat-<slug>-auth` and `plat-<slug>-rest` |
