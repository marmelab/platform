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

## App builder journeys

### B1. Onboarding
Trigger: a team member wants to host their first app.
1. An admin creates their account (email + password) and issues a PAT.
2. The builder installs the plugin: `claude plugin marketplace add <repo>`, then `claude plugin install platform@platform-local`.
3. They set their token (`PLATFORM_TOKEN`).
4. They log into Studio with their credentials.

Channel: admin, then Claude Code + MCP, and Studio.
Status: 🟡. The `create-user` CLI exists, and local accounts with passwords are done (M0ter). Missing: the admin screen for accounts and tokens (M4), a secure way to hand over the PAT, and storing the token in the keychain (sensitive `userConfig`).

### B2. First deployment
Trigger: "deploy the app to the platform" in a Vite + Supabase repo.
1. `create_app` (within the quota), then `.platform.json` is written and committed.
2. `apply_migrations`: the linter runs inside the transaction and rejects any new `ERROR`.
3. Secrets, then functions. Each function is warmed up before the switch.
4. Build with the variables returned by `get_app`, then frontend deployment.
5. Smoke test, then the URL and the Studio link are displayed.

Channel: Claude Code + MCP.
Status: ✅ M3 (about 45 s). The quota is not enforced yet ❌.

### B3. Iteration
Trigger: the builder changes the schema or the frontend, then asks for a new deployment.
1. Only new migrations are applied. `dry_run` is available, and `accept_lints` is only used with the builder's explicit consent.
2. New versions of the functions and the frontend.
3. `rollback` of the frontend or the functions if needed.

Channel: Claude Code + MCP.
Status: 🟡. Missing: `list_migrations` and a bundle hash (unchanged functions are redeployed). A migration that contains its own `COMMIT` escapes the rollback.

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
2. The colleague clones the repo (`.platform.json` is committed) and deploys with their own PAT.
3. The app shows up in their `whoami` and in their Studio.

Channel: Claude Code + MCP (owner), and admin.
Status: 🟡. The MCP tools (`list_members`, `add_member`, `remove_member`; owner or admin only for changes) and the `add-member` / `remove-member` admin CLI exist. The colleague's platform account must already exist (created by an admin). The admin screen (M4) is ❌.

### B8. Stopping and deleting an app
Trigger: project over, or abandoned-app flag.
1. `stop_app`: containers are stopped and a maintenance page is served.
2. Final backup.
3. `delete_app`: symmetric to provisioning.

Channel: Claude Code + MCP (owner), or admin.
Status: 🟡. Only the `cli.ts delete-app` admin command exists. The rest is ❌.

## Admin journeys

### A1. Installation
1. Prerequisites: a VM with 16 GB or more, a wildcard DNS record, ports 80 and 443, an SMTP server, an S3 bucket.
2. `install.sh`: secrets, startup, initialization, first admin.
3. Domain and on-demand TLS.
4. Publishing the internal plugin marketplace.

Channel: shell.
Status: 🟡. `install.sh` works locally, but `api.localhost` is hardcoded, and there is neither the TLS `ask` endpoint nor Loki.

### A2. Builders, tokens and quotas
1. Create a builder (email, password).
2. Issue or revoke a PAT, check `last_used_at`.
3. Adjust their app quota.
4. Disable the account.

Channel: admin.
Status: 🟡 CLI / ❌ M4.

### A3. Monitoring and alerts
1. Dashboard: apps by status, VM resources, cluster size.
2. Apps in error, `BOOT_ERROR`, audited `accept_lints`, failed backups.
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
3. For each one: transfer ownership to another builder, put it to sleep or delete it.

Channel: admin.
Status: ❌ M4. The source code lives in the builder's repo, not on the platform.

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
