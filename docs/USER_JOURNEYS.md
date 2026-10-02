# User journeys

Legend: ✅ done · 🟡 partial · ❌ missing. Milestones refer to [PLAN_1.md](../PLAN_1.md) §11; M0ter is the Studio integration for app builders ([report](../spikes/m0ter-studio-builders/REPORT.md)).

## Personas

- **App users**: use the deployed apps, anonymously or with an account in the app's GoTrue.
- **App builders**: create, modify and inspect their apps, and manage their users. They only see their own apps.
- **Admins**: see all apps and manage app builders.

## Product decisions

| Topic | Decision |
|---|---|
| Web login (Studio, admin) | Local accounts (email and password) managed by the platform. No SSO for builders and admins. |
| App creation | Self-service, with a per-builder quota that admins can change. |
| Roles within an app | **Owner**: everything, including managing members, stopping and deleting the app. **Collaborator**: deploy, inspect, manage the app's users. |
| Members management | Both through MCP tools (for the owner) and through the admin UI. |
| Visibility | A builder only sees the apps they are a member of. No catalog. |
| App auth configuration | Shared. The builder manages signup, redirect URLs and simple providers. The admin configures the company SSO once; the builder enables it on their app with one click. |
| App users management | In Studio (Auth tab) and through MCP tools. |
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
1. An admin creates their account (email + password) and issues a PAT.
2. The builder installs the plugin: `claude plugin marketplace add <repo>`, then `claude plugin install platform@platform-local`.
3. They set their token (`PLATFORM_TOKEN`).
4. They have the GitHub CLI (`gh`) logged in, with the right to create repositories in the company organization (or an existing repo there).
5. They log into Studio with their credentials.

Channel: admin, then Claude Code + MCP, and Studio.
Status: 🟡. The `create-user` CLI exists, and local accounts with passwords are done (M0ter). Missing: the admin screen for accounts and tokens (M4), a secure way to hand over the PAT, and storing the token in the keychain (sensitive `userConfig`).

### B2. First deployment
Trigger: "deploy the app to the platform" in a Vite + Supabase repo.
1. `create_app` (within the quota), then `.platform.json` is written.
2. GitHub repository: if the project has no GitHub remote, the skill creates the repo in the company organization (`gh repo create`). `link_repo` records it on the app (owner/name and the stable `repository_id`).
3. Function secrets: the skill lists the secrets the functions read, asks the builder for the missing values and calls `set_secrets` (values live on the platform, never in GitHub).
4. CI setup, only what is missing: the workflow file `.github/workflows/platform.yml` (calls the shared reusable workflow on push to the default branch and on PRs, with `id-token: write`), and the `PLATFORM_URL` variable if it is not set at the organization level. No deploy secret is needed (OIDC).
5. Commit and push. The skill follows the run (`gh run watch`).
6. In CI: company checks, migrations (the linter rejects any new `ERROR` not listed in `acceptedLints`), functions (warmed up before the switch), build with the variables returned by `get_app`, frontend, smoke test.
7. The skill shows the URL, the Studio link and the run link. On failure, it reads the run logs and `get_logs`, then proposes a fix (B3).

Channel: Claude Code + MCP + GitHub.
Status: 🟡. Direct deployment from the builder's machine works (✅ M3, about 45 s), and stays the path when `DIRECT_DEPLOY=everyone`. Control plane side ✅ (M3bis): `link_repo` (owner or admin, audited, shown by `get_app`), the CI API `/ci/*` authenticated by GitHub OIDC (linked `repository_id`, protected default branch, allowed `job_workflow_ref`; check mode for other refs), releases with commit, run URL and GitHub actor, and `DIRECT_DEPLOY=admins` refusing the publishing tools to builder PATs. Deploy CLI and reusable workflow ✅ (M3bis): `platform-deploy` (`packages/deploy-cli`) runs check and deploy with a GitHub OIDC token or a PAT, and `ci/.github/workflows/deploy.yml` calls it after a placeholder company checks job; tested end to end without GitHub (fake OIDC issuer and token endpoint), never run on GitHub yet. Missing ❌: the new `deploy` skill (repo, `link_repo`, secrets, workflow file, push and `gh run watch`). The quota is not enforced yet ❌.

### B3. Iteration
Trigger: the builder changes the schema, the functions or the frontend.
1. The builder opens a PR (Claude can do it). The PR check runs the company checks, the build and a migrations dry run; lints are reported on the PR.
2. To keep an `ERROR` lint, the builder adds it to `acceptedLints` in `.platform.json`, with explicit consent; the reviewer sees it in the diff.
3. After review and merge, CI deploys: only new migrations, new versions of the functions and the frontend.
4. `rollback` of the frontend or the functions if needed, through MCP: it only re-points to a version that CI already deployed. Migrations are never rolled back; a fix goes through a new migration.

Channel: Claude Code + GitHub, MCP for rollback.
Status: 🟡. The control plane accepts PR checks (check mode: `get_app` and migrations `dry_run`) and CI deployments from the protected default branch (see B2). The deploy CLI and the reusable workflow run the PR check (company checks placeholder, migrations dry run with the lints and `acceptedLints`, build) and report it in the run summary. Missing: the PR comment with the lints (the run summary only), `list_migrations` and a bundle hash (unchanged functions are redeployed). A migration that contains its own `COMMIT` escapes the rollback (CP-1).

### B4. Debugging in production
Trigger: a user reports a bug, or an alert comes in.
1. The builder describes the symptom to Claude.
2. `get_logs`, then read-only `execute_sql`.
3. Diagnosis, then a fix (B3) or a `rollback`.
4. Optionally, inspection in Studio (tables, SQL, RLS).

Channel: Claude Code + MCP, and Studio.
Status: 🟡. `get_logs` reads Docker logs with no history (Loki is not done). Studio is ✅ (M0ter). Alerts are ❌.

### B5. Managing the app's users
Trigger: invite, delete or unblock an account, count sign-ups.
1. In Studio: Auth > Users, to list, create, invite and delete.
2. Or in Claude: dedicated MCP tools.

Channel: Studio and MCP.
Status: 🟡. Studio is ✅ (M0ter). The MCP tools (`list_auth_users`, `invite_user`, `delete_user`) are ❌.

### B6. App auth and SSO
Trigger: an internal app restricted to employees, or a public app.
1. `configure_auth`: signup on/off, allowed email domain, redirect URLs, simple providers.
2. Enabling the platform's company SSO (configured by the admin, A7).
3. Sender and email templates.

Channel: Claude Code + MCP.
Status: ❌ M6.

### B7. Sharing an app
Trigger: a colleague needs to co-maintain the app.
1. The owner adds the colleague as a collaborator, through an MCP tool or through the admin UI.
2. The owner gives the colleague write access to the GitHub repo (outside the platform).
3. The colleague clones the repo (`.platform.json` is committed) and ships through PRs; CI deploys. Their PAT is used for logs, SQL reads, secrets and rollback.
4. The app shows up in their `whoami` and in their Studio.

Channel: Claude Code + MCP (owner), GitHub, and admin.
Status: 🟡. The MCP tools (`list_members`, `add_member`, `remove_member`; owner or admin only for changes) and the `add-member` / `remove-member` admin CLI exist. The colleague's platform account must already exist (created by an admin). The admin screen (M4) is ❌.

### B8. Stopping and deleting an app
Trigger: project over, or abandoned-app flag.
1. `stop_app`: containers are stopped and a maintenance page is served.
2. Final backup.
3. `delete_app`: symmetric to provisioning.

Channel: Claude Code + MCP (owner), or admin.
Status: 🟡. The MCP tools `stop_app`, `start_app` and `delete_app` exist, for an owner of the app or an admin, and are audited. `stop_app` stops GoTrue and PostgREST and replaces the app's Caddy routes with a 503 maintenance response (page on `/`, JSON `APP_STOPPED` on `/auth/v1`, `/rest/v1`, `/functions/v1`), so functions no longer run. A stopped app is read-only: its database defaults to read-only transactions (Studio and `execute_sql` still read it, Studio writes fail), and the control plane refuses every write with `APP_STOPPED` (`execute_sql` with `write`, migrations except `dry_run`, secrets, deployments, rollbacks, releases, `link_repo`, the CI API); a guardrail, not a hard guarantee (accepted: a deliberate write by the owner role remains possible, see TECH_DEBT "Accepted trade-offs"). `start_app` makes it writable again and re-runs the idempotent provisioning. `delete_app` requires `confirm: <slug>` and first takes the final backup (step 2): a `pg_dump` of the database and a tarball of the deployed sites and functions, in the platform's `backups` volume; if the backup fails, nothing is deleted; the path is returned and audited. `backup: false` (CLI `--no-backup`) deletes without that backup, same rights and confirmation, when the user explicitly asks: the data is lost for good, and the audit entry records the skipped backup. Admin CLI: `stop-app`, `start-app`, `delete-app [--no-backup]`. Restoring a backup, retention and off-site copies (M7, TECH_DEBT CP-14) and the abandoned-app flag are ❌.

## Admin journeys

### A1. Installation
1. Prerequisites: a VM with 16 GB or more, a wildcard DNS record, ports 80 and 443, an SMTP server, an S3 bucket, a GitHub organization (github.com or GitHub Enterprise Server). The control plane API must be reachable from the GitHub Actions runners (or self-hosted runners in the company network), and the control plane must reach the GitHub OIDC issuer.
2. `install.sh`: secrets, startup, initialization, first admin.
3. Domain and on-demand TLS.
4. Publishing the internal repo that holds the plugin marketplace and the reusable deploy workflow, and adding the company checks to that workflow.
5. Platform settings: the GitHub organization, the OIDC issuer, the allowed `job_workflow_ref` values; organization variable `PLATFORM_URL`.

Channel: shell.
Status: 🟡. `install.sh` works locally (and writes `DIRECT_DEPLOY=everyone`), but `api.localhost` is hardcoded, and there is neither the TLS `ask` endpoint nor Loki. The platform settings of step 5 exist (`OIDC_ISSUER`, `OIDC_AUDIENCE`, `CI_ALLOWED_WORKFLOWS`, `DIRECT_DEPLOY`, in the environment or with the `set-setting` CLI); `install.sh` does not ask for them yet.

### A2. Builders, tokens and quotas
1. Create a builder (email, password).
2. Issue or revoke a PAT, check `last_used_at`.
3. Adjust their app quota.
4. Disable the account.

Channel: admin.
Status: 🟡 CLI / ❌ M4.

### A3. Monitoring and alerts
1. Dashboard: apps by status, VM resources, cluster size.
2. Apps in error, `BOOT_ERROR`, accepted lints, failed CI deployments, apps deployed outside CI (A10), failed backups.
3. Email alerts to owners.
4. Audit log.

Channel: admin and email.
Status: ❌ M4/M7. Part of the data already exists (`apps.status`, `audit_log`).

### A4. Backups and restore
Daily backup of each database to S3, with retention, failure tracking and restore into the same app.

Channel: admin.
Status: ❌ M7.

### A5. Taking over an orphaned app
Trigger: a team member leaves.
1. Disable their account and revoke their tokens.
2. List their apps.
3. For each one: transfer ownership to another builder, put it to sleep or delete it. On GitHub, give the new owner admin rights on the linked repo.

Channel: admin and GitHub.
Status: ❌ M4. The source code is in the company GitHub organization, linked from the app (A9), so nothing is lost when the builder leaves.

### A6. Abandoned apps
1. After N days without traffic or deployment, the app is flagged to the admin and the owner.
2. The admin decides: put it to sleep, or delete it after a final backup.

Channel: admin and email.
Status: ❌.

### A7. Platform company SSO
The admin configures the company's OIDC and SAML providers once. Builders then enable them on their apps (B6).

Channel: admin.
Status: ❌ M6.

### A8. Platform upgrade
1. Control plane migration.
2. Recycling the GoTrue and PostgREST containers, app by app.
3. Re-applying the owner role's grants and the `platform_owner_read` policies on `auth.users` and `auth.identities` (`syncAll`, run at control plane startup): a GoTrue migration that recreates one of these tables drops its policy, and Auth > Users in Studio would show no users until then.
4. Rebuilding Studio: replay the patches documented in `apps/studio/PLATFORM_PATCHES.md`.

Channel: shell.
Status: ❌ M7. The Studio upgrade procedure is documented (M0ter).

### A9. Apps overview
Trigger: the admin wants to know what runs on the platform, and who is responsible for it.
1. A list of every app, sortable and filterable, with: name and URL, status, owner (name and email), link to the GitHub repo, last deployment (date, commit with a link, author, CI run link, source CI or admin, result), load overview (requests and 5xx over 24 h with a 7-day sparkline, database size, memory of the app's containers).
2. From a row: the app page (A3, deployments, logs), the repo on GitHub, the commit diff since the previous deployment, Studio.

Channel: admin.
Flags: deployed outside CI (A10), accepted lints, schema changed outside CI, abandoned.

Status: ❌ M4. Status, owner, linked repo, releases (commit, run, author, source, admin exception) and their deployments already exist in the `platform` database; missing: the DDL event trigger, per-app metrics (Caddy per-host metrics, `pg_database_size`, Docker stats sampled by the control plane).

### A10. Direct deployment (exception)
Trigger: an emergency fix while CI is broken, an app whose repo cannot run CI, or a takeover (A5).
1. The admin checks out the app's repo locally and asks Claude to deploy it with the `admin-deploy` skill.
2. The skill asks for a reason, then runs the same deploy CLI as CI with the admin's PAT. It records the commit, and refuses a dirty working tree or a commit that is not pushed to the linked repo.
3. The deployment is audited and the app is flagged "deployed outside CI" in A9 until the next CI deployment.

Channel: Claude Code + MCP (admin only).
Status: 🟡. Control plane ✅: with `DIRECT_DEPLOY=admins`, only admins publish with a PAT; `begin_release(reason)` groups the publications, and the release is recorded as `source = direct`, `admin_exception = true`, with the reason and the admin, and audited. The deploy CLI ✅ runs a direct deployment with the admin's PAT (`--reason`, commit of the checkout; it only flags uncommitted changes in its summary). Missing ❌: the `admin-deploy` skill (dirty tree and unpushed commit checks), and the flag in the admin view (M4).

## App user journeys

### U1. Email sign-up and login
Sign-up, email confirmation, login, then access to data under RLS.
Status: 🟡. Sign-up, login and RLS are verified. Confirmation is automatic as long as there is no SMTP (M6).

### U2. Company SSO login
"Sign in with Entra ID / Google", account created on first login, rejected if the domain is not allowed.
Status: ❌ M6.

### U3. Anonymous access
SPA and requests with the anon key, restricted by the `anon` policies. Functions with `verify_jwt=false`.
Status: ✅.

### U4. Password reset
Email sent through the shared SMTP, then a reset page in the app.
Status: ❌ M6.

## Open questions

1. **Thresholds**: default app quota per builder, and number of days before an app is flagged as abandoned.
2. **Reaching the platform from CI**: if the platform is only reachable inside the company network, GitHub-hosted runners cannot deploy; the client then needs self-hosted runners. To check with each client before installation.
3. **Without OIDC** (old GitHub Enterprise Server, other forges): fallback to a per-app deploy token stored as a GitHub environment secret restricted to the default branch, which the skill would create. Not planned for V1.
4. **Existing apps** deployed directly (the M3 model): the owner links a repo and sets up CI with the `deploy` skill; until then, they are flagged in A9.
