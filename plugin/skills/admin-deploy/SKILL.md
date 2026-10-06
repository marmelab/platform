---
name: admin-deploy
description: Platform admins only. Deploy an app directly from a local checkout of its linked repository, outside CI, as an audited exception (CI down, app without CI, takeover of an orphaned app). Use when an admin asks for an emergency, direct or admin deployment on the platform.
allowed-tools: mcp__plugin_platform_platform__*, Bash(git *), Bash(${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/*), Bash(PLATFORM_DEPLOY_TOKEN=* ${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/platform-deploy *), Bash(${CLAUDE_PLUGIN_ROOT}/skills/admin-deploy/scripts/*), Read, Glob, Grep
---

# Admin deployment (exception)

Runs the same `platform-deploy` as CI, with the admin's credentials: their PAT (`PLATFORM_TOKEN`) when `whoami` says `credential: "pat"`; when it says `"oauth"` (signed in through the browser), a deploy token from `create_deploy_token` passed as `PLATFORM_DEPLOY_TOKEN=<token> ${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/platform-deploy ...`, a new one for each command. The release is recorded as `source = direct`, with the reason and the admin, flagged `admin_exception` when the platform reserves direct deployment to admins, and audited. The app is flagged "deployed outside CI" until its next CI deployment.

Rules: one command per Bash call (no `&&`, `;`, pipes or redirections); do not modify, commit or push anything in the checkout; never print, repeat or write a token. If the platform tools are missing or `whoami` fails, follow step 0 of the `deploy` skill (`check-connection.sh`).

1. `whoami`: if `role` is not `admin`, refuse and point to the `deploy` skill (CI). If `direct_deploy_setting` is `everyone`, say that no exception is needed and the `deploy` skill would do, but go on if the admin insists.
2. Read `.platform.json` for the app slug, then `get_app`: note `github_repo`, `status` (a stopped app refuses deployments: stop) and `last_release`.
3. Ask for the **reason** (one sentence: why outside CI). Do not continue without it.
4. `${CLAUDE_PLUGIN_ROOT}/skills/admin-deploy/scripts/preflight.sh <github_repo>` (without argument if the app has no linked repository; say so in the report). It refuses a dirty working tree, a commit that is not pushed to the remote, and a checkout of another repository. On `REFUSED`, show the reason and stop: never commit, stash or push on the admin's behalf.
5. Secrets: `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/function-secrets.sh` against `list_secrets`. If one is missing, report it and ask whether to continue (the owner sets secrets; set them only if the admin gives the value).
6. `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/platform-deploy check`, then show the lints. A blocking lint stops the deployment: accepting it means changing `.platform.json` through the repository, not here.
7. `${CLAUDE_PLUGIN_ROOT}/skills/deploy/scripts/platform-deploy deploy --reason "<reason>"`.
8. Report: app URL, commit, release id and whether it is an `admin_exception`, reason, migrations, functions and frontend versions. On failure: `get_logs` for the service involved, diagnosis, and `rollback` if the live version is broken.
