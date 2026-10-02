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

The per-app images (`GOTRUE_IMAGE`, `POSTGREST_IMAGE`) are pulled by the control plane when missing: in the background at startup, and before creating a container (concurrent provisionings share one pull). A failed pull (registry unreachable, Docker Hub rate limit) fails the provisioning with the registry's error.

## MCP

- URL: `http://api.localhost:8100/mcp`, with the `Authorization: Bearer <PAT>` header.
- Claude Code: `claude mcp add --transport http platform http://api.localhost:8100/mcp --header "Authorization: Bearer $PLATFORM_TOKEN"`
- Tools: `whoami`, `list_apps`, `get_app`, `create_app`, `link_repo`, `apply_migrations`, `execute_sql`, `create_deployment`, `finalize_deployment`, `begin_release`, `finish_release`, `list_deployments`, `rollback`, `set_secrets`, `list_secrets`, `list_members`, `add_member`, `remove_member`, `stop_app`, `start_app`, `delete_app`, `get_logs`.
- Archives don't go through MCP: `create_deployment` returns a `PUT http://api.localhost:8100/uploads/<token>` URL (single use, 15 min) and a ready-to-use `tar` + `curl` command.

## Releases, direct deployment and `DIRECT_DEPLOY`

A **release** groups the deployments (migrations, functions, frontend) of one publication. `releases.source` is `ci` (one GitHub Actions run attempt, through the CI API below: commit, run URL and GitHub actor from the OIDC claims) or `direct` (a PAT through MCP: the platform account in `created_by`). `get_app` returns the app's `last_release`, and `list_deployments` the `release_id` of each deployment.

Direct deployment through MCP: `begin_release(app, commit_sha?, reason?)` opens a release, its `release_id` is then passed to `apply_migrations` and `create_deployment` (`finalize_deployment` follows the deployment), and `finish_release(release_id, succeeded|failed)` closes it. Without `release_id`, each successful publication is recorded as its own finished release (that is what the current `deploy` skill and the seed do). `platform-deploy` with a PAT (`PLATFORM_TOKEN`) drives exactly this sequence, with the commit of the local checkout and `--reason`. A release can only be used by the app it belongs to, while `running`; `finish_release` through MCP only closes `direct` releases.

The platform setting **`DIRECT_DEPLOY`** decides who publishes with a PAT:

- `admins` (default when unset; **use it in production**): builder PATs are refused the publishing tools (`apply_migrations` without `dry_run`, `create_deployment`, `finalize_deployment`, `begin_release`) with an error that points to CI. They keep everything else (reads, `dry_run`, `execute_sql`, secrets, members, `rollback`, `stop_app` / `start_app`). Admins keep the publishing tools: their releases are flagged `admin_exception = true` (the audited exception of PLAN_1 §6.3, with an optional `reason` given to `begin_release`).
- `everyone`: every member of the app publishes with their PAT (the M3 model). `deploy/install.sh` writes `DIRECT_DEPLOY=everyone` into `deploy/.env` for local installs, so that the e2e suites, the seed and the current `deploy` skill keep working without GitHub.

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

## Studio

`http://studio.localhost:8100`: multi-head Studio (`apps/studio`), project ref = app slug, `studio_url` deep link in `get_app`. Platform login on `/_platform/login` (local account with password), then forward auth (`/studio/verify` on the internal `:3001` listener): a builder only sees the apps they are a member of, an admin sees everything. Details: `spikes/m0ter-studio-builders/REPORT.md`.

Studio and `execute_sql` connect as `app_<id>_owner`, which does **not** have `BYPASSRLS`. It owns the `public` tables, so their RLS does not apply to it (as for Supabase's `postgres`). In `auth`, it only reads `auth.users` and `auth.identities` (Auth > Users), through a `platform_owner_read` policy (`FOR SELECT TO app_<id>_owner`); every other `auth` table is denied. `register` (app creation, `syncAll` at control plane startup) re-applies the grants and recreates missing policies: after a GoTrue upgrade whose migrations recreate an `auth` table, restart the control plane (or re-run `create_app`) to repair them.

## Admin CLI (inside the container)

```bash
docker exec plat-control-plane node src/cli.ts create-user bob@example.com developer   # prints a new PAT
docker exec plat-control-plane node src/cli.ts stop-app demo                            # maintenance page, containers stopped, read-only
docker exec plat-control-plane node src/cli.ts start-app demo
docker exec plat-control-plane node src/cli.ts delete-app demo                          # final backup first (path printed)
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

- **Stop.** `stop_app` first replaces the app's two Caddy routes (`app-<slug>`, `app-<slug>-internal`) with a 503 maintenance response (HTML page, or `{"code":"APP_STOPPED"}` on `/auth/v1`, `/rest/v1` and `/functions/v1`), then stops the `plat-<slug>-auth` and `plat-<slug>-rest` containers, so functions cannot run either (the edge is only reachable through those routes). It then makes the app **read-only**: `alter database app_<id> set default_transaction_read_only = on`, and terminates the sessions of the app's own roles (owner, authenticator, auth admin: Studio's pg-meta, functions) so that their next session gets the setting; the platform's admin sessions opt out with `-c default_transaction_read_only=off`. Finally `apps.status = 'stopped'` (shown by `whoami`, `list_apps` and `get_app`).
- **Read-only.** One guard (`requireWritable` in `apps.ts`) refuses every write of a stopped app with `APP_STOPPED: app "<slug>" is stopped and read-only, <action> is refused`: `execute_sql` with `write`, `apply_migrations` without `dry_run`, `set_secrets`, `create_deployment`, `finalize_deployment`, `rollback`, `begin_release`, `link_repo`, and the CI API's publishing requests (409). Reads, `execute_sql` without `write`, migrations `dry_run` (run in an explicit `begin read write` transaction, always rolled back), logs, `get_app`, members, `start_app` and `delete_app` stay available. In Studio, reads work and SQL editor or table editor writes fail with `cannot execute ... in a read-only transaction`. This is a guardrail, not a security boundary: a session can still opt out with `SET` or `BEGIN READ WRITE` (TECH_DEBT CP-9). At control plane startup, `syncAll` re-applies the maintenance routes and the database setting from `apps.status`; `create_app` refuses a stopped app.
- **Start.** `start_app` resets the database setting, then re-runs the idempotent provisioning (containers restarted, routes restored, status `running`). An upload made before the stop can be finalized once started.
- **Delete.** `delete_app` is irreversible and requires `confirm` to repeat the slug. It reuses `deleteApp` (as the `delete-app` CLI), which first takes a **final backup** into the `backups` volume (`/data/backups` in the control plane, `BACKUPS_DIR`), one directory per deletion, `<slug>-<UTC timestamp>/`: `database.dump` (`pg_dump --format=custom`, run in the Postgres container so that it always matches the server; check it with `pg_restore --list`), `sites.tar.gz` and `functions.tar.gz` (every deployed version), `manifest.json` (no secret: the app's keys and function secrets are not kept). If the backup fails, nothing is deleted. The tool returns the backup path, and the `delete_app` audit entry keeps the slug, the backup path and the file sizes in `details` (its `app_id` becomes null when the app row is deleted). Restore, retention and off-site copies are M7 (TECH_DEBT CP-14): backups stay until removed by hand.

## Tests

```bash
pnpm -r typecheck
pnpm --filter @platform/control-plane test        # Studio access policy (unit)
pnpm --filter @platform/control-plane e2e         # requires the running stack and deploy/.env.local; also runs test/ci.e2e.test.ts and test/deploy-cli.e2e.test.ts
pnpm --filter @platform/control-plane e2e:deploy-cli  # platform-deploy alone (direct and CI modes, builds examples/todo-app: needs npm registry access)
pnpm --filter @platform/control-plane e2e:studio  # Studio: login, filtering, isolation
```

The e2e suites never touch existing apps or users. Each run creates disposable resources named after a run id: one app `e2e-<id>` for `e2e` (plus `e2e-<id>-ci` and its owner and collaborator for the CI suite, and `e2e-<id>-cli` for the `platform-deploy` suite), two apps `e2e-<id>-a` / `e2e-<id>-b` and two builders `e2e-<id>-alice@example.com` / `e2e-<id>-bob@example.com` (random passwords, kept in memory) for `e2e:studio`. They are deleted at the end of the run, even when a test fails, with `delete-app` and `delete-user`; the `after` hook then checks that nothing is left (platform rows, sessions, tokens, memberships, containers, Caddy routes, database and roles) and fails the suite otherwise. The CI suite (`test/ci.e2e.test.ts`) acts as a fake GitHub OIDC issuer: it generates an RS256 key pair, sets `oidc_issuer`, `oidc_jwks` and `ci_allowed_workflows`, toggles `direct_deploy`, and restores the previous settings in its `after` hook. It expects `DIRECT_DEPLOY=everyone` and `ALLOW_TEST_OIDC_JWKS=1` in the environment (local install). The `platform-deploy` suite (`test/deploy-cli.e2e.test.ts`) uses the same fake issuer, and also serves its tokens on a local `ACTIONS_ID_TOKEN_REQUEST_URL`, so that the CLI runs unchanged as in GitHub Actions. Suites that change settings must not run concurrently (two runs at once overwrite each other's issuer, and can restore each other's values). `delete-app` always takes a final backup: the cleanup removes the run's own backups (`/data/backups/<slug>-*`) rather than skipping them with a flag, so that the backup path runs on every e2e run and production has no way to delete without a backup. Set `E2E_KEEP=1` to keep the apps for inspection (their slugs are printed), then remove them with `delete-app`.

## Technical access (dev)

| Item | Value |
|---|---|
| Postgres | `127.0.0.1:54350`, `supabase_admin` / `POSTGRES_PASSWORD` from `deploy/.env`; `platform` database |
| Caddy admin | `http://127.0.0.1:2030` (routes `app-<slug>` and `app-<slug>-internal`) |
| Volumes | `plat_sites`, `plat_functions`, `plat_apps-config`, `plat_uploads`, `plat_backups`, `plat_deno-cache`, `plat_db-data` |
| Containers | `plat-db`, `plat-caddy`, `plat-edge`, `plat-control-plane`, `plat-studio`, `plat-studio-meta`, and per app `plat-<slug>-auth` and `plat-<slug>-rest` |
