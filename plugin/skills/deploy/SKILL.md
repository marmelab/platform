---
name: deploy
description: Deploy the current Vite + Supabase project to the internal platform (database migrations, edge functions, static frontend), through the app's GitHub Actions CI or, when the platform allows it, directly from this machine. Use when the user asks to deploy, publish, ship or put the app online "on the platform", to set up its CI, or to redeploy after changes.
allowed-tools: mcp__plugin_platform_platform__*, Bash(git *), Bash(gh *), Bash(npm *), Bash(curl *), Bash(${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/*), Bash(PLATFORM_DEPLOY_TOKEN=* ${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/platform-deploy *), Read, Glob, Grep, Write, Edit
---

# Deploy to the platform

The platform hosts Supabase-style apps (Postgres, Auth, REST, edge functions, static SPA) at `https://<slug>.<domain>`. Two deployment paths, same CLI (`platform-deploy`):

- **CI** (the normal path in production): the app's GitHub repository in the company organization calls the platform's reusable workflow; a push to the protected default branch deploys, pull requests are checked.
- **Direct**: `platform-deploy` runs here with the user's credentials. Only when `whoami` says `direct_deploy: true`.

Scripts (call them by absolute path, from the project root):

- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/platform-deploy check|deploy`: `check` = `get_app`, migrations dry run with the security linter, build (publishes nothing, allowed to every member); `deploy` = release, migrations, functions, build, frontend, smoke test. Prints a step report and a markdown summary.
- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/function-secrets.sh`: secrets read by the functions (`Deno.env.get`), platform-provided ones excluded.
- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/install-workflow.sh <uses> <default_branch>`: writes `.github/workflows/platform.yml` if missing.
- `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/check-connection.sh [--after-auth-error]`: why the platform cannot be used, in one word (step 0), and the API URL it checked.

**Credentials of `platform-deploy`.** When `whoami` says `credential: "oauth"` (the user signed in through the browser, the usual case), `platform-deploy` has no token of its own: call `create_deploy_token` with the app (valid 15 minutes, this app only), then run the script with the token as an environment prefix, e.g. `PLATFORM_DEPLOY_TOKEN=<token> ${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/platform-deploy check`. Get a new one for each command. When `credential` is `"pat"`, run the script without a prefix: it uses `PLATFORM_TOKEN` from the environment.

Rules: one command per Bash call (no `&&`, `;`, pipes, redirections or `VAR=value` prefixes, except the `PLATFORM_DEPLOY_TOKEN=` prefix above); edit files with Write/Edit. Never print, repeat or write a platform token (in messages, files or commits), never ask the user for a password or a token, never pass archives through MCP, never invent a secret value. One short status line per step, in the user's language.

## Talking to the user

App builders are usually not developers. Speak about what the app does and what its users see, not about how it is built. This applies to every message, including the short status lines ("I'm adding the date field", "checking that everything works", "putting the new version online"):

- No jargon in messages: no RLS, policy, migration, lint, PostgREST, GoTrue, edge function, release id, commit hash, version numbers or file paths. Say "only the person who created a todo can see it", "the database now stores a priority for each todo", "the security check found a problem", "the previous version of the app is back online".
- When a technical point needs a decision, explain the consequence for the app's users in one sentence, then ask a plain question ("Anyone could read and change these notes. Do you want them private to each user?").
- Final report: the app link, what changed in a few user-facing bullets, what the user should do next (if anything). Leave out the steps that went well; keep the Studio link for those who use it.
- Technical details (versions, ids, logs, SQL, lint names) only when the user asks for them, or when they must forward them to an admin; then say so ("for your admin: ...").

## 0. Connection

Run this step when the `mcp__plugin_platform_platform__*` tools are missing, or when `whoami` fails. Run `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/check-connection.sh`, with `--after-auth-error` when the platform tools worked earlier in this conversation and now fail with an authentication error (401, "needs authentication"). It prints one word; explain it in the user's language, without technical terms, then stop:

- `NOT_SIGNED_IN`: "Claude is not connected to the platform yet. Type `/mcp`, choose **platform**, then **Authenticate**, and sign in with your platform account in the browser that opens. Then ask me again." (If the server shows **Re-authenticate**, choose it.)
- `ACCOUNT_REFUSED`: "The platform refuses your account: it was disabled, or its access was removed. Contact the platform administrator."
- `UNREACHABLE`: "Claude cannot reach the platform. Check your network connection (VPN?); if it keeps failing, tell the platform administrator."
- `OK`: the platform answers; retry `whoami` once, then report the error as is.

Add one line for the admin: "for your admin: <word>, <the `api:` line the script prints>". Never ask the user to paste a password or a token into the conversation.

## 1. Context

1. `whoami`: note `role`, `credential`, `direct_deploy`, `ci` (`uses` and `github_org`, or null when CI is not set up on the platform) and `api_url`. If it fails, go to step 0.
2. Read `.platform.json` (`{ "app": "<slug>", "acceptedLints": [...] }`). If missing: slug from `package.json` `name` (`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`), `create_app` (idempotent), write `.platform.json` with `{ "app": "<slug>" }`. Otherwise `get_app`; stop if access is denied.
3. Check it is a Vite SPA (`package.json` with a `build` script and `vite`, `index.html`). Migrations must be `supabase/migrations/<numeric version>_<name>.sql`.
4. Git: `git status --porcelain`, `git remote -v`. If there is no git repository, `git init -b main` and commit.
5. Auth (`get_app` `auth`): when `email_confirmation_effective` is true, `signUp` returns no session until the user opens the emailed link; check that the app's sign-up flow says so ("check your email") and that any `emailRedirectTo` / `resetPasswordForEmail` `redirectTo` is under the app URL or in `redirect_urls`. Change the policy (sign-up, confirmation, allowed email domains, redirect URLs, sender, company SSO) with `configure_auth` only when the user asks: owners and admins only, the app's Auth restarts for a few seconds. Company SSO (`sso: {provider: "company"}`, only when the platform admin configured it): the app signs in with `supabase.auth.signInWithOAuth({ provider: "custom:company" })`, and the admin must register the `callback_url` shown in `get_app` at the identity provider; tell the user.

## 2. Choose the path

- **CI** if `ci` is not null and the repo has a GitHub remote in `ci.github_org`, or the user wants one (offer to create it). Requires `gh auth status` to succeed; otherwise ask the user to run `gh auth login`.
- **Direct** if `direct_deploy` is true and there is no repository or CI, or the user explicitly asks for a direct deployment. With no repository yet, ask once: "create the GitHub repository and deploy through CI (recommended), or deploy directly now?".
- **Neither** (`direct_deploy` false and CI impossible): explain why (no `gh`, CI not set up on the platform: ask an admin) and stop. An admin with `direct_deploy_setting: "admins"` deploying outside CI must use the `admin-deploy` skill (reason, audited).

## 3. Function secrets (both paths)

Run `function-secrets.sh`, then `list_secrets`. Ask the user for each missing value, then `set_secrets`. If one stays missing, say which function will fail to boot and ask whether to continue.

## 4. Migrations review (both paths)

1. Read the migrations not yet applied (`execute_sql`: `select version from supabase_migrations.schema_migrations`) and point out risks (table or view without RLS, `security definer`).
2. Run `platform-deploy check` (with a deploy token when `credential` is `oauth`, see above). It fails on any new `ERROR` lint not in `acceptedLints`: show each blocking lint (name, object, detail), explain the risk and propose a fix in the migration. **Stop** while a table is exposed without RLS.
3. Add a lint to `.platform.json` `acceptedLints` (`{ "name", "object" }`) only if the user explicitly consents in this conversation; it is reviewed in the diff and audited.
4. Fix build errors before going on.

## 5a. CI path

1. Repository: if missing, `gh repo create <ci.github_org>/<slug> --private --source . --push` (commit first). Then `gh api repos/<owner>/<repo> --jq '{id: .id, default_branch: .default_branch, full_name: .full_name}'`.
2. `link_repo` with `repo` (owner/name), `repository_id` (numeric `id`) and `default_branch` (owner of the app only; otherwise ask the owner).
3. Branch protection: `gh api repos/<owner>/<repo>/branches/<default_branch> --jq .protected`. The platform only deploys from a protected default branch. If false, tell the user and, with their consent, protect it: `gh api -X PUT repos/<owner>/<repo>/branches/<default_branch>/protection -F required_status_checks=null -F enforce_admins=false -F restrictions=null -F 'required_pull_request_reviews[required_approving_review_count]=0'` (or let the organization's rulesets do it).
4. `PLATFORM_URL` variable: if neither `gh variable list --org <owner>` nor `gh variable list` shows it, `gh variable set PLATFORM_URL --body <api_url>` (repository level).
5. Workflow: `install-workflow.sh <ci.uses> <default_branch>` (never overwrites an existing file; if one exists, check it calls `ci.uses` with `id-token: write`).
6. Commit the changes (`.platform.json`, workflow, fixes). If the default branch is protected (expected), push a branch and open a PR: `git switch -c platform-deploy`, `git push -u origin platform-deploy`, `gh pr create --fill`. Watch the PR check: `gh pr checks --watch`. Ask the user to get the PR reviewed and merged (merge it with `gh pr merge --squash` only if they say so). Unprotected branch: push directly; the run will only check.
7. After the merge: `gh run list --workflow platform.yml --branch <default_branch> --limit 1 --json databaseId,url,status`, then `gh run watch <id> --exit-status`.
8. Report the app URL, the Studio link (`get_app` `studio_url`) and the run URL. On failure: `gh run view <id> --log-failed`, then `get_logs`, and diagnose.

## 5b. Direct path

1. Commit first if the tree is dirty (the release records the commit).
2. `platform-deploy deploy` (with a new deploy token when `credential` is `oauth`; it rebuilds, applies the migrations with `acceptedLints`, deploys functions and frontend, smoke-tests).
3. Report the app URL, the Studio link, the release, migrations applied, functions and frontend versions, warnings. Mention that a GitHub repository with CI is the production path.

## On errors

1. `get_logs` for the app and the relevant service (`requests` for the HTTP requests and their status, `functions` for `BOOT_ERROR` / `WORKER_ERROR`, `postgrest`, `gotrue`, `postgres`), `since_minutes: 15`, with a `query` when you have a keyword.
2. Diagnose in two or three plain sentences (what is broken for the app's users, and why), and propose a fix; quote log lines only if the user asks. Do not retry blindly more than once.
3. To undo a bad frontend or functions version: `rollback` (migrations are never rolled back: fix forward with a new migration).
4. `get_app` `schema_drift.count > 0` means schema changes were made outside a release (Studio, `execute_sql`): `list_schema_changes`, and suggest turning them into a migration.
