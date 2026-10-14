# User journeys

Legend: ✅ done · 🟡 partial · ❌ missing. Milestones (M0 to M7) refer to the development milestones, all done; M0ter is the Studio integration for app builders.

## Personas

- **App users**: use the deployed apps, anonymously or with an account in the app's GoTrue.
- **App builders**: create, modify and inspect their apps, and manage their users. They only see their own apps.
- **Admins**: see all apps and manage app builders.

## Product decisions

| Topic | Decision |
|---|---|
| Web login (Studio, admin) | Local accounts managed by the platform, with email and password, or the company's OpenID Connect provider (company SSO, M6) once an admin configures it. SSO links to existing accounts by verified email; creating unknown users (as developers) is an opt-in setting. Password sign-in can be reserved to admins (break-glass). PATs are unchanged. |
| Claude Code sign-in | Through the browser (OAuth 2.1 of the MCP specification), on the same login page: builders never handle a token. The authorization server is Supabase Auth (a GoTrue dedicated to the platform's accounts), with dynamic client registration; the control plane fronts it and keeps the accounts. PATs remain for admins, scripts, tests and the admin API; CI stays on GitHub OIDC. |
| App creation | Self-service, with a per-builder quota that admins can change. |
| Roles within an app | **Owner**: everything, including managing members, stopping and deleting the app. **Collaborator**: deploy, inspect, manage the app's users. |
| Members management | Both through MCP tools (for the owner) and through the admin UI. |
| Visibility | A builder only sees the apps they are a member of. No catalog. |
| App auth configuration | Shared. The builder manages signup, redirect URLs and simple providers. The admin configures the company SSO once; the builder enables it on their app with one click. |
| App users management | In Studio (Auth tab) and through MCP tools, by any member of the app (owner or collaborator). Invitations are emailed through the platform SMTP (M6); on a platform without SMTP, the invitation link is returned to the builder, who hands it over. |
| Environments | One instance per app, for good. Staging is the builder's local `supabase start`. |
| Alerts | Admin dashboard, plus an email to the owner of the affected app. |
| Abandoned apps | After N days without traffic or deployment, the app is flagged to the admin and the owner. The admin decides: put it to sleep, or delete it after a final backup. |
| Builders without Claude Code | Not supported in V1. The REST API and the MCP server stay generic, to open up to other clients later. |
| Custom domains | Never. Apps are only served on `<app>.<domain>`. |
| Studio | Open to builders for their own apps, through the vendored multi-head fork (see [CLAUDE.md](../CLAUDE.md)). |
| Source code | Every app is linked to one GitHub repository in the company's GitHub organization. The admin reads the code on GitHub: the platform never hosts or displays source code. |
| Deployment path | **Always GitHub Actions** in production, from the default branch of the linked repo, after the company's CI checks (security scans, required reviews): the `deploy` skill sets up the CI job, then pushes. Direct deployment from a local machine stays available when the platform allows it (`DIRECT_DEPLOY`, below): e2e tests run without GitHub. |
| CI authentication | GitHub OIDC: the platform accepts a deployment only if the OIDC token proves the linked repo (`repository_id`), its default branch (`ref`, `ref_protected`) and an admin-approved reusable workflow (`job_workflow_ref`). No long-lived deploy secret is stored in GitHub. |
| Shared deploy workflow | The admin maintains one reusable workflow (in the same repo as the plugin marketplace) that runs the company checks, builds the frontend and deploys. App repos only call it, so the checks cannot be skipped by editing the app repo. |
| Pull requests | The same reusable workflow runs on PRs in check mode: company checks, build, and a migrations dry run with the security linter. Nothing is published. |
| Accepted lints | Declared in `.platform.json` (`acceptedLints`), so that accepting a lint goes through code review. Still audited on the platform. |
| Schema changes outside CI | Accepted and detected. Studio's SQL editor and `execute_sql(write=true)` run as the app's owner role and can change the schema without review; they stay available (data fixes, emergencies), but a DDL event trigger records every schema change not made by a deployment, and the app is flagged in A9. |
| Direct deployment | Platform setting `DIRECT_DEPLOY`. `admins` (production): reserved to admins (`admin-deploy` skill), for emergencies or apps without CI; it takes a reason, is audited as an admin exception, and the app is flagged in the admin view until the next CI deployment. `everyone` (local installs, written by `install.sh`): builders may still deploy directly with their PAT. Either way, a direct deployment creates a release with `source = direct` and its author; CI runs create `source = ci` releases. |

## App builder journeys

### B1. Onboarding
Trigger: a team member wants to host their first app.
1. An admin creates their account (admin console, Users: email, and a password unless they sign in with the company SSO). That is all the admin does.
2. The builder installs the plugin: `claude plugin marketplace add <repo>`, then `claude plugin install platform@platform-local`. No token, no file to edit, no restart.
3. They ask Claude to deploy. At the first use, Claude Code shows the platform server as needing authentication: the `deploy` skill says so in plain words (type `/mcp`, choose **platform**, then **Authenticate**). The browser opens on the platform's login page (password, or "Sign in with <company SSO>"), then a consent page ("Allow access to your apps?", with their email); they click **Allow** and go back to Claude.
4. For the CI path, they have the GitHub CLI (`gh`) logged in, with the right to create repositories in the company organization (or an existing repo there).
5. They log into Studio with the same account.

Channel: admin, then Claude Code + MCP (and the browser once), and Studio.
Status: 🟡. Browser sign-in ✅: the MCP endpoint is an OAuth 2.1 protected resource, and the authorization server is a GoTrue (Supabase Auth) dedicated to the platform's accounts, fronted by the control plane ([control plane README](../apps/control-plane/README.md#browser-sign-in-for-claude-code-oauth)). Claude Code registers itself (dynamic client registration), signs in with PKCE, keeps the tokens in the keychain (access 1 h, rotating refresh) and refreshes them; nothing to copy. The login is the Studio one (password, company SSO, throttling), so a builder who only has SSO needs nothing else; a disabled account cannot sign in, and every credential of a disabled account is refused at once. The admin sees each connection in the console (Tokens, type "Claude Code connection", client, last use) and can revoke it: Claude Code then asks to sign in again, and the `deploy` skill tells the builder that the platform refuses their account. The direct path of `platform-deploy` gets a 15-minute deploy token restricted to the app (`create_deploy_token`). Checked by hand with Claude Code 2.1.290 and the plugin on a local stack, as alice: "deploy the app to the platform" without being signed in gives the step 0 message; `claude mcp login` (dynamic registration, browser login and consent) signs in; the same request then deploys through deploy tokens; after the admin revokes the connection, the next request in the conversation tells that the platform refuses the account. The CI path is unchanged (GitHub OIDC). PATs stay for admins, scripts, the e2e tests and the admin API (`PLATFORM_TOKEN`, sent in `X-Platform-Token`). Limits: a Claude Code connection has all the rights of its account (no per-tool scopes, TECH_DEBT SEC-8), and the plugin's default URL must point to the production API in the company's marketplace copy ([INSTALL.md](INSTALL.md) §7).

### B2. First deployment
Trigger: "deploy the app to the platform" in a Vite + Supabase repo, usually one Claude built with the plugin's `build` skill ("build me a notes app for my team"), which holds the target architecture (Vite + React SPA, supabase-js, migrations with RLS on every table, edge functions only where a secret or extra privileges are needed, invitation and password reset links handled).
1. `create_app` (within the quota), then `.platform.json` is written.
2. GitHub repository: if the project has no GitHub remote, the skill creates the repo in the company organization (`gh repo create`). `link_repo` records it on the app (owner/name and the stable `repository_id`).
3. Function secrets: the skill lists the secrets the functions read, asks the builder for the missing values and calls `set_secrets` (values live on the platform, never in GitHub).
4. CI setup, only what is missing: the workflow file `.github/workflows/platform.yml` (calls the shared reusable workflow on push to the default branch and on PRs, with `id-token: write`), and the `PLATFORM_URL` variable if it is not set at the organization level. No deploy secret is needed (OIDC).
5. Commit and push. The skill follows the run (`gh run watch`).
6. In CI: company checks, migrations (the linter rejects any new `ERROR` not listed in `acceptedLints`), functions (warmed up before the switch), build with the variables returned by `get_app`, frontend, smoke test.
7. The skill shows the URL, the Studio link and the run link. On failure, it reads the run logs and `get_logs`, then proposes a fix (B3).

Channel: Claude Code + MCP + GitHub.
Status: 🟡. Step 0 of the `deploy` skill checks the connection first (`check-connection.sh`: not signed in, account refused, platform unreachable) and explains it without technical terms (B1). Direct deployment from the builder's machine works and stays available when `whoami` says `direct_deploy: true` (`DIRECT_DEPLOY=everyone`, or an admin): the `deploy` skill then runs `platform-deploy` with a deploy token from `create_deploy_token` (15 minutes, this app and the publishing tools only) when the builder signed in through the browser, or with `PLATFORM_TOKEN` (a PAT) otherwise (verified with Claude Code and the installed plugin on a copy of `examples/todo-app`, about 30 s, with a PAT). Control plane side ✅ (M3bis): `link_repo` (owner or admin, audited, shown by `get_app`), the CI API `/ci/*` authenticated by GitHub OIDC (linked `repository_id`, protected default branch, allowed `job_workflow_ref`; check mode for other refs), releases with commit, run URL and GitHub actor, and `DIRECT_DEPLOY=admins` refusing the publishing tools to builder PATs. Deploy CLI and reusable workflow ✅ (M3bis): `platform-deploy` (`packages/deploy-cli`) runs check and deploy with a GitHub OIDC token or a PAT, and `ci/.github/workflows/deploy.yml` calls it after a placeholder company checks job; tested end to end without GitHub (fake OIDC issuer and token endpoint), never run on GitHub yet. The `deploy` skill ✅ (M3bis) chooses the path from `whoami` (`direct_deploy`, and `ci`: the reusable workflow to call and the company organization, derived from `CI_ALLOWED_WORKFLOWS`) and the repository: CI path with `gh repo create`, `link_repo`, branch protection check, `PLATFORM_URL` variable, function secrets, `.github/workflows/platform.yml` from the example caller, `platform-deploy check` for the migrations and lints review, PR and `gh run watch`; direct path with `platform-deploy deploy`. Its scripts and the direct path are tested locally (`plugin/test/scripts.test.sh`, `test/plugin.e2e.test.ts`); the CI path has never run against GitHub ❌ (TECH_DEBT PLG-4, CI-1). The quota is not enforced yet ❌.

### B3. Iteration
Trigger: the builder changes the schema, the functions or the frontend.
1. The builder opens a PR (Claude can do it). The PR check runs the company checks, the build and a migrations dry run; lints are reported on the PR.
2. To keep an `ERROR` lint, the builder adds it to `acceptedLints` in `.platform.json`, with explicit consent; the reviewer sees it in the diff.
3. After review and merge, CI deploys: only new migrations, new versions of the functions and the frontend.
4. `rollback` of the frontend or the functions if needed, through MCP: it only re-points to a version that CI already deployed. Migrations are never rolled back; a fix goes through a new migration.

Channel: Claude Code + GitHub, MCP for rollback.
Status: 🟡. The control plane accepts PR checks (check mode: `get_app` and migrations `dry_run`) and CI deployments from the protected default branch (see B2). The `deploy` skill opens the PR and watches its check, and only adds a lint to `acceptedLints` with explicit consent (CI path untested on GitHub). The deploy CLI and the reusable workflow run the PR check (company checks placeholder, migrations dry run with the lints and `acceptedLints`, build) and report it in the run summary. The linter (M7 part 2) has 16 rules rewritten from Supabase's splinter (tables and views exposed without RLS, `auth.users` exposed, security definer functions executable by anon or authenticated, extensions in `public`, materialized and foreign tables in the API, `user_metadata` in policies, always-true write policies, public buckets that list their files, unindexed foreign keys...), and every run is stored (`lint_runs`) for the admin (A9). Missing: the PR comment with the lints (the run summary only), `list_migrations` and a bundle hash (unchanged functions are redeployed). A migration that contains its own `COMMIT` escapes the rollback (CP-1).

### B4. Debugging in production
Trigger: a user reports a bug, or an alert comes in.
1. The builder describes the symptom to Claude.
2. `get_logs`, then read-only `execute_sql`.
3. Diagnosis, then a fix (B3) or a `rollback`.
4. Optionally, inspection in Studio (tables, SQL, RLS).

Channel: Claude Code + MCP, and Studio.
Status: 🟡. `get_logs` reads Docker logs with no history (Loki is not done), and the app's HTTP requests from Caddy's access log (`service: "requests"`: method, path without query string, status, duration). Studio is ✅ (M0ter), Realtime Inspector included (a 10-minute token for the app, minted by the control plane: TECH_DEBT "Accepted trade-offs"). A fix made in Studio or with `execute_sql(write=true)` that changes the schema is recorded by the DDL event trigger: `get_app` shows `schema_drift` and `list_schema_changes` lists the changes, so that the builder turns them into a migration ✅. Alerts are ❌.

### B5. Managing the app's users
Trigger: invite, delete or unblock an account, count sign-ups.
1. In Studio: Auth > Users, to list, create, invite and delete.
2. Or in Claude: dedicated MCP tools.

Channel: Studio and MCP.
Status: 🟡. Studio is ✅ (M0ter). The MCP tools are ✅ (B5), for any member of the app or an admin: `list_auth_users` (paginated, email filter; read from the database, so it also works on a stopped app), `invite_user`, `delete_user`, `ban_user` and `unban_user` (through the app's GoTrue admin API, audited, refused on a stopped app). `invite_user` emails the invitation through the platform SMTP (M6, single-use link valid 24 h, never returned to the caller); only on a platform without SMTP does it return the link for the builder to hand over (TECH_DEBT CP-16). Invitations respect the app's allowed email domains (B6).

### B6. App auth and SSO
Trigger: an internal app restricted to employees, or a public app.
1. `configure_auth`: signup on/off, allowed email domain, redirect URLs, simple providers.
2. Enabling the platform's company SSO (configured by the admin, A7).
3. Sender and email templates.

Channel: Claude Code + MCP.
Status: 🟡 (M6). `configure_auth` ✅ (owner or admin, audited, refused on a stopped app): sign-up on or off (invitations still work), email confirmation, allowed email domains (GoTrue's before-user-created hook: sign-ups, invitations and SSO accounts outside them are refused; with sign-up off, a new sign-up or SSO account is refused for that reason first, "Signups not allowed", and the domains only apply to invitations), extra redirect URLs (the app's own URL is always allowed), sender name and address (address within the platform sender's domain, any for admins). The app's GoTrue is replaced by a new container without downtime (M7 part 2); `get_app` and the admin console's app page show the policy in effect. Company SSO ✅ (step 2, M6 part 2): `configure_auth(sso: {provider: "company"})` adds the platform's OIDC provider to the app's GoTrue (custom provider `custom:company`, no restart), refused while the admin has not configured it; `get_app` shows the callback URL the admin registers at the IdP (the app uses the platform's client, TECH_DEBT SSO-2) and the supabase-js call (U2). Missing ❌: simple OAuth providers (Google, GitHub... with the builder's own client), SAML (TECH_DEBT SSO-1), custom email templates (TECH_DEBT CP-17).

### B7. Sharing an app
Trigger: a colleague needs to co-maintain the app.
1. The owner adds the colleague as a collaborator, through an MCP tool or through the admin UI. The colleague is notified by email.
2. The owner gives the colleague write access to the GitHub repo (outside the platform).
3. The colleague clones the repo (`.platform.json` is committed) and ships through PRs; CI deploys. Their Claude Code, signed in to the platform through the browser (B1), handles logs, SQL reads, secrets and rollback.
4. The app shows up in their `whoami` and in their Studio.

Channel: Claude Code + MCP (owner), GitHub, and admin.
Status: 🟡. The MCP tools (`list_members`, `add_member`, `remove_member`; owner or admin only for changes), the `add-member` / `remove-member` admin CLI and the Members tab of the admin console (M4 phase 1: add, owner / collaborator, remove) exist. The colleague's platform account must already exist (created by an admin). With the platform SMTP, the colleague is emailed when added (who added them, the app's name and URL, the role and what it allows, the Studio link, and that Claude Code with the platform plugin now sees the app), with a short notice when their role changes or when they are removed (M6) ✅.

### B8. Stopping and deleting an app
Trigger: project over, or abandoned-app flag.
1. `stop_app`: containers are stopped and a maintenance page is served.
2. Final backup.
3. `delete_app`: symmetric to provisioning.

Channel: Claude Code + MCP (owner), or admin.
Status: 🟡. The MCP tools `stop_app`, `start_app` and `delete_app` exist, for an owner of the app or an admin, and are audited. `stop_app` stops GoTrue and PostgREST and replaces the app's Caddy routes with a 503 maintenance response (page on `/`, JSON `APP_STOPPED` on `/auth/v1`, `/rest/v1`, `/functions/v1`, `/storage/v1`, `/realtime/v1`), so functions no longer run, uploads are refused and the app's open Realtime websockets are closed (M5). A stopped app is read-only: its database defaults to read-only transactions (Studio and `execute_sql` still read it, Studio shows a "stopped" banner and its writes fail with a message naming the app), and the control plane refuses every write with `APP_STOPPED` (`execute_sql` with `write`, migrations except `dry_run`, secrets, deployments, rollbacks, releases, `link_repo`, the CI API); a guardrail, not a hard guarantee (accepted: a deliberate write by the owner role remains possible, see TECH_DEBT "Accepted trade-offs"). `start_app` makes it writable again and re-runs the idempotent provisioning. `delete_app` requires `confirm: <slug>` and first takes the final backup (step 2, A4): a `pg_dump` of the database (with the Storage metadata), the app's Storage files (M5), the live frontend and functions versions and its keys and secrets (encrypted), on the backups volume or the S3 target; if the backup fails, nothing is deleted; its location and id are returned and audited. Final backups are kept `backup_final_retention_days` (90 by default), and an admin can recreate the deleted app from one (same slug, keys, data and members, M7). `backup: false` (CLI `--no-backup`) deletes without that backup, same rights and confirmation, when the user explicitly asks: the data is lost for good, and the audit entry records the skipped backup. Admin CLI: `stop-app`, `start-app`, `delete-app [--no-backup]`; admin console: Stop, Start and Delete (typed confirmation, final backup checkbox) on the app page. The abandoned-app flag is A6.

## Admin journeys

### A1. Installation
1. Prerequisites: a VM with 16 GB or more, a wildcard DNS record, ports 80 and 443, an SMTP server (relay), an S3 bucket, a GitHub organization (github.com or GitHub Enterprise Server). The control plane API must be reachable from the GitHub Actions runners (or self-hosted runners in the company network), and the control plane must reach the GitHub OIDC issuer.
2. `install.sh`: secrets, startup, initialization, first admin.
3. Domain and on-demand TLS.
4. Publishing the internal repo that holds the plugin marketplace and the reusable deploy workflow, and adding the company checks to that workflow.
5. Platform settings: the GitHub organization, the OIDC issuer, the allowed `job_workflow_ref` values; organization variable `PLATFORM_URL`.

Channel: shell.
Status: 🟡 (M7 part 2). `install.sh --production --domain <domain>` ✅: prerequisites check (Docker and compose versions, RAM, disk, ports 80 and 443, DNS records including the wildcard, with clear warnings), secrets, production defaults (`DIRECT_DEPLOY=admins`, no Mailpit, mock IdP or test S3 store, no test-only flag), SMTP, GitHub OIDC (`CI_ALLOWED_WORKFLOWS` from `--github-org`, `--oidc-issuer` for GHES) and backups S3 as options or prompts, first admin with a generated password and PAT. Hosts derive from the domain (no more `*.localhost` outside the local mode); HTTPS through Caddy's on-demand TLS (Let's Encrypt, or Caddy's internal CA with `--internal-tls`), certificates only for the hosts the control plane's `ask` endpoint approves (platform hosts and existing apps), HTTP redirected to HTTPS. Step 4 and the organization variable are documented in [INSTALL.md](INSTALL.md) (publication by hand, TECH_DEBT CI-2). Tested on a Linux VM with a fake domain in `/etc/hosts` and the internal CA; never with Let's Encrypt on a public VM (TECH_DEBT DEP-2). Local mode unchanged (default; `DIRECT_DEPLOY=everyone`, Mailpit on `http://localhost:8025`). Missing ❌: Loki.

### A2. Builders, tokens and quotas
1. Create a builder (email, password).
2. Issue or revoke a PAT, check `last_used_at`.
3. Adjust their app quota.
4. Disable the account.

Channel: admin.
Status: 🟡. Admin console (M4 phase 1): accounts (create with a password, role, disable, new password, delete), tokens (create, value shown once, revoke, last use, expiry), audited; also through the admin REST API with an admin PAT. Missing ❌: the app quota (step 3, not enforced anywhere yet), token scopes.

### A3. Monitoring and alerts
1. Dashboard: apps by status, VM resources, cluster size.
2. Apps in error, `BOOT_ERROR`, accepted lints, failed CI deployments, apps deployed outside CI (A10), failed backups.
3. Email alerts to owners.
4. Audit log.

Channel: admin and email.
Status: 🟡. Admin console dashboard (M4 phase 1): apps by status, flagged apps (deployed outside CI, accepted lints), failures of the last 7 days (failed releases and deployments, apps in error), accounts, Postgres cluster size, host memory, CPU load and volumes disk; audit log screen with filters (app, user, action, search). Per-app load (M4 phase 2): requests and 5xx of every app over 24 h with a 7-day sparkline, memory of the app containers, and abandoned apps on the dashboard; per-app load in the apps list and an hourly chart on the app page (`app_metrics`, sampled every minute from Caddy's access log, `pg_database_size` and Docker stats). Email: only the abandoned-app notice to owners (A6, M6). Failed backups (M7): in the failures of the last 7 days and a Backups card (failures, apps without a backup for 36 h, last daily run), and emailed to the admins after each daily run ✅. Security linter (M7 part 2) ✅: a dashboard card with the apps whose latest linter run has ERROR lints no migration accepted, and the platform version. Missing ❌: other email alerts, `BOOT_ERROR`, alerts on error rates.

### A4. Backups and restore
Daily backup of each database to S3, with retention, failure tracking and restore into the same app.

Channel: admin (console and CLI); builders list their app's backups and take one through MCP.
Status: 🟡 (M7 part 1). Daily backup of every running, stopped or failed app at `backup_hour` (UTC), one at a time: the database (`pg_dump -Fc`), the Storage files, the live frontend and functions versions and the app's keys and function secrets (encrypted with the platform master key), recorded in a `backups` table (kind scheduled, manual, pre-restore or final; status, size, location, error). On the platform's `backups` volume by default, or on an S3-compatible bucket (`backup_s3_*` settings, secret key encrypted; the volume is then only a staging area). Retention: N daily and M weekly scheduled backups per app, manual and pre-restore backups by age, final backups (B8) kept separately for `backup_final_retention_days`; on the volume and on the bucket. Failures: recorded, audited, on the admin dashboard (with the apps without a backup for 36 h) and emailed to the admins after each daily run. Restore (admin console "Restore…" with a typed confirmation, or CLI `restore-app`, audited): into the same app, after a pre-restore backup of its current state (the app is stopped, its database replaced by a `pg_restore` into a fresh database, its files, live versions and secrets put back, then started), or a deleted app recreated from its backup under the same slug, with the same keys, members and creation date (the restore date is shown next to it). MCP: `list_backups` (owners) and `create_backup` (owners and admins); admin console: Backups screen (every app, deleted ones included, settings and last run) and a Backups tab with "Backup now" on the app page; CLI `backup-app`, `list-backups`, `restore-app`, `run-backups`, `prune-backups`. Tested end to end (local volume and S3, retention with a simulated clock, an unreachable S3, a deleted app). Missing ❌: restore into another app (cloning), point-in-time recovery, client-side encryption of the dumps, multipart uploads (TECH_DEBT CP-19 to CP-22). See the control plane README, "Backups".

### A5. Taking over an orphaned app
Trigger: a team member leaves.
1. Disable their account and revoke their tokens.
2. List their apps.
3. For each one: transfer ownership to another builder, put it to sleep or delete it. On GitHub, give the new owner admin rights on the linked repo.

Channel: admin and GitHub.
Status: 🟡. Admin console (M4 phase 1): disable the account (its sessions end and its PATs stop working at once) and revoke its tokens (step 1); its apps on its user page (step 2); on each app page, add another owner then remove the former one, stop or delete the app (step 3). Deleting the account is refused while it is the last owner of an app. The source code is in the company GitHub organization, linked from the app (A9), so nothing is lost when the builder leaves.

### A6. Abandoned apps
1. After N days without traffic or deployment, the app is flagged to the admin and the owner.
2. The admin decides: put it to sleep, or delete it after a final backup.

Channel: admin and email.
Status: 🟡. Admin console (M4 phase 2): an app whose last request, last release, creation and last restore are all older than the `abandoned_after_days` setting (30 days by default) is flagged "abandoned" in the apps list (with a filter) and counted on the dashboard (step 1, admin side); the app page has Stop and Delete with the final backup (step 2). Requests come from Caddy's access log (`apps.last_request_at`), and no app is flagged before the metrics have been collected for N days. The owners are emailed once per transition through the platform SMTP (M6): "Your app ... looks abandoned", with what the admin may do and how to keep the app (recorded and audited, sent again only after the app was active in between; stopped apps are not notified) ✅. Missing ❌: a reminder to the admin by email (the console flag only).

### A7. Platform company SSO
The admin configures the company's OIDC and SAML providers once. Builders then enable them on their apps (B6).

Channel: admin.
Status: 🟡 (M6 part 2). OpenID Connect ✅: the admin console's SSO screen (or the `sso_*` settings) sets the provider (issuer, client id, client secret stored encrypted and never returned, allowed email domains, `email_verified` requirement, unknown users refused or created as developers, password sign-in for everyone or admins only), checked against the issuer's discovery document when saved, audited. Studio's `/_platform/login` and the admin console's login page then show "Sign in with ...": authorization code flow with PKCE, state and nonce, ID token verified against the issuer's JWKS, accounts linked by verified email at the first login then by the IdP subject; every SSO login, accepted or refused, is audited (`login_sso`, `login_sso_refused`). Admins keep a password sign-in (break-glass); PATs are unchanged. Tested end to end with a mock IdP of the local stack (`plat-idp`). Missing ❌: SAML (TECH_DEBT SSO-1), session revocation or deprovisioning from the IdP, role mapping from IdP groups (SSO-4).

### A8. Platform upgrade
1. Control plane migration.
2. Recycling the GoTrue and PostgREST containers, app by app.
3. Re-applying the owner role's grants and the `platform_owner_read` policies on `auth.users` and `auth.identities` (`syncAll`, run at control plane startup): a GoTrue migration that recreates one of these tables drops its policy, and Auth > Users in Studio would show no users until then.
4. Rebuilding Studio: replay the patches documented in `apps/studio/PLATFORM_PATCHES.md`.

Channel: shell.
Status: 🟡 (M7 part 2). `deploy/upgrade.sh` ✅: pre-upgrade backup of every app and dumps of the platform's databases, rollback tags of the current images, new images (Studio rebuilt when `apps/studio` changed, Realtime when its pinned version changed, pinned upstream images pulled), `docker compose up` (the control plane's idempotent schema migrations and `syncAll` at start, step 1 and 3), rolling recycle of each app's GoTrue and PostgREST without downtime (new container next to the old one, switched once ready, step 2) with Studio's policies and Storage's tenant migrations re-applied, `realtime-migrate --all` when Realtime changed, security linter, verification report (`verify`) and rollback instructions in `deploy/upgrades/<timestamp>/`. The version (`VERSION`) and the images are recorded in `platform_versions` at every start and shown on the admin dashboard. Measured: no failed request on the apps during a recycle (INSTALL.md, "Measured downtime"). Step 4 (replaying the Studio patches on a new fork commit) stays manual (`apps/studio/PLATFORM_PATCHES.md`). Missing ❌: automatic rollback, Postgres major upgrades, restoring a backup taken before a GoTrue, Storage or Realtime upgrade is untested (TECH_DEBT DEP-5, CP-21).

### A9. Apps overview
Trigger: the admin wants to know what runs on the platform, and who is responsible for it.
1. A list of every app, sortable and filterable, with: name and URL, status, owner (name and email), link to the GitHub repo, last deployment (date, commit with a link, author, CI run link, source CI or admin, result), load overview (requests and 5xx over 24 h with a 7-day sparkline, database size, memory of the app's containers).
2. From a row: the app page (A3, deployments, logs), the repo on GitHub, the commit diff since the previous deployment, Studio.

Channel: admin.
Flags: deployed outside CI (A10), accepted lints, schema changed outside CI, abandoned.

Status: 🟡. Admin console (M4 phase 1), apps list: every app with search, status and flag filters, sort and pagination; name and URL, status, owners (name and email), GitHub repo link, last release (date, result, source CI / direct / admin exception, commit link, author, run link), database size, flags "deployed outside CI" (last release published with a PAT), "schema changed outside CI" (`schema_drift`), "accepted lints" (ERROR lints accepted by migrations), "no repo". App page: overview with "Open in Studio", releases with the GitHub diff since the previous release and their deployments, rollback, members, secret names, schema changes, logs (Docker, last hour), audit. Load overview (M4 phase 2): requests and 5xx over 24 h with a 7-day sparkline, database size and memory of the app's containers in the list (sortable), the "abandoned" flag (A6), and on the app page a Load section with the hourly chart over 7 days (`app_metrics`, see the control plane README, "Load metrics"). Security linter (M7 part 2): a "lint errors" flag and filter in the list, and a Security linter tab on the app page (latest run with its lints, accepted ones marked, previous runs, "Run linter"). Missing ❌: logs history (Loki).

### A10. Direct deployment (exception)
Trigger: an emergency fix while CI is broken, an app whose repo cannot run CI, or a takeover (A5).
1. The admin checks out the app's repo locally and asks Claude to deploy it with the `admin-deploy` skill.
2. The skill asks for a reason, then runs the same deploy CLI as CI with the admin's PAT. It records the commit, and refuses a dirty working tree or a commit that is not pushed to the linked repo.
3. The deployment is audited and the app is flagged "deployed outside CI" in A9 until the next CI deployment.

Channel: Claude Code + MCP (admin only).
Status: 🟡. Control plane ✅: with `DIRECT_DEPLOY=admins`, only admins publish with a PAT; `begin_release(reason)` groups the publications, and the release is recorded as `source = direct`, `admin_exception = true`, with the reason and the admin, and audited. The deploy CLI ✅ runs a direct deployment with the admin's PAT (`--reason`, commit of the checkout; it only flags uncommitted changes in its summary). The `admin-deploy` skill ✅ checks the admin role, asks for the reason, refuses a dirty tree (untracked files included), a commit that is not on the remote or a checkout of another repository than the linked one (`preflight.sh`), then runs `platform-deploy deploy --reason` (verified with Claude Code: refused without a remote, then deployed). The flag in the admin view ✅ (M4 phase 1): "admin exception" / "deployed outside CI" on the apps list and the app page, filterable, until the next CI release.

## App user journeys

### U1. Email sign-up and login
Sign-up, email confirmation, login, then access to data under RLS.
Status: ✅ (M6). Sign-up, email confirmation (GoTrue's default email through the platform SMTP, link on the app's `/auth/v1/verify`, then a session on the app), login and RLS are verified end to end (e2e with mailpit). The builder can turn confirmation off or restrict sign-ups (B6). On a platform without SMTP, users are confirmed automatically. Emails use GoTrue's default English templates (TECH_DEBT CP-17).

### U2. Company SSO login
"Sign in with Entra ID / Google", account created on first login, rejected if the domain is not allowed.
Status: ✅ (M6 part 2) for OpenID Connect providers. On an app whose builder enabled company SSO (B6), `supabase.auth.signInWithOAuth({ provider: "custom:company" })` goes through the app's GoTrue to the company IdP and back to the app with a session (PKCE); GoTrue verifies the ID token and creates the account at the first login. A new account goes through two checks, in this order: the app's sign-up switch (off: GoTrue answers "Signups not allowed for this instance", whatever the address), then the app's allowed email domains (an address outside them is refused with "restricted to email addresses of: ..."). Invited or existing users still sign in with the company SSO when sign-up is off. Verified end to end with supabase-js and the mock IdP. Limits: the IdP must be reachable over HTTPS at a public address (TECH_DEBT SSO-3), each app's callback must be registered at the IdP by the admin (SSO-2), no SAML (SSO-1).

### U3. Anonymous access
SPA and requests with the anon key, restricted by the `anon` policies. Functions with `verify_jwt=false`.
Status: ✅.

### U4. Password reset
Email sent through the shared SMTP, then a reset page in the app.
Status: ✅ (M6). `supabase.auth.resetPasswordForEmail(email, { redirectTo })` sends the email, the link signs the user in on the app's page (`redirectTo` within the app's URL or its allowed redirect URLs, the app's URL otherwise) with a recovery session, and `updateUser({ password })` sets the new password: verified end to end with supabase-js (e2e with mailpit). The reset page itself is the app's (the examples do not have one).

### U5. Files
Upload, list and download files with `supabase.storage`, restricted by the app's policies on `storage.objects` (e.g. one folder per user); public buckets for public assets.
Status: 🟡 (M5). Works per app on the shared Storage API (same URL and anon key as the rest of the app; buckets and policies by migration, Studio's Storage browser or the service role in a function), isolated between apps. Backed up daily with the app (M7, A4). Missing: per-app quota, image transformations, S3 protocol (TECH_DEBT SR-3).

### U6. Live updates
`supabase.channel(...)`: `postgres_changes` on the app's tables (added to the `supabase_realtime` publication by a migration, filtered by RLS), broadcast and presence between clients.
Status: ✅ (M5). Works per app on the shared Realtime, isolated between apps, Broadcast from Database (`realtime.send()`, `realtime.broadcast_changes()`) included since the patched Realtime image (`patches/realtime`, TECH_DEBT SR-6). Limits: Realtime's connections and walsenders per recently used app (TECH_DEBT PG-5, PG-6).

## Open questions

1. **Thresholds**: default app quota per builder, and number of days before an app is flagged as abandoned.
2. **Reaching the platform from CI**: if the platform is only reachable inside the company network, GitHub-hosted runners cannot deploy; the client then needs self-hosted runners. To check with each client before installation.
3. **Without OIDC** (old GitHub Enterprise Server, other forges): fallback to a per-app deploy token stored as a GitHub environment secret restricted to the default branch, which the skill would create. Not planned for V1.
4. **Existing apps** deployed directly (the M3 model): the owner links a repo and sets up CI with the `deploy` skill; until then, they are flagged "no repo" in A9. Their deployments from before releases (M3bis) belong to no release: the console shows "never deployed" as their last release and does not flag them "deployed outside CI" until their next deployment (TECH_DEBT CP-25).
