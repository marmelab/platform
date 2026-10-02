# platform-deploy

Checks or deploys an app repository (Vite SPA + `supabase/migrations` + `supabase/functions`) to the platform. It is what the reusable GitHub Actions workflow ([`ci/.github/workflows/deploy.yml`](../../ci/.github/workflows/deploy.yml)) runs, and what an admin runs for a direct deployment (PLAN_1 §5.1, §6.2, §6.3).

TypeScript with **no runtime dependency**: Node ≥ 22.18 runs `src/main.ts` directly (type stripping), and it only shells out to `npm`, `tar` and `git`. Nothing to install or build.

```bash
node packages/deploy-cli/src/main.ts check  [--dir <app>]
node packages/deploy-cli/src/main.ts deploy [--dir <app>] [--reason "<why outside CI>"]
pnpm --filter @platform/deploy-cli start -- deploy --dir ../../examples/todo-app   # same, from the workspace
```

`--app <slug>` names the app instead of the `app` of `.platform.json`, which may then be absent (the seed deploys the examples this way). The Claude Code plugin ships this CLI (`plugin/deploy-cli`, a symlink to `src/`) and runs it with the builder's PAT through `plugin/skills/deploy/scripts/platform-deploy`: the `deploy` skill for direct deployments and for `check` before a push, the `admin-deploy` skill with `--reason`.

## Authentication: one code path, two transports

| `--auth` | When | Credentials | Calls |
|---|---|---|---|
| `oidc` | GitHub Actions | `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` (`permissions: id-token: write`); the token is requested with audience = the platform API URL (`--audience` / `PLATFORM_AUDIENCE` to override) and refreshed before it expires | CI API `/ci/apps/<slug>/…` |
| `token` | direct deployment from a machine | `PLATFORM_TOKEN` (a PAT) | MCP tools `get_app`, `apply_migrations`, `begin_release`, `create_deployment`, `finalize_deployment`, `finish_release` |

Default: `token` when `PLATFORM_TOKEN` is set, `oidc` otherwise. The platform URL comes from `--url` or `PLATFORM_URL`; the MCP form `https://api.<domain>/mcp` (what the plugin uses) is accepted too.

Both transports implement the same small `Platform` interface ([`src/platform.ts`](src/platform.ts)); the check and deploy flows ([`src/run.ts`](src/run.ts)) do not know which one they use. MCP was chosen over adding PAT auth to `/ci/*` so that the control plane keeps one authorization model per entry point (the CI API trusts only OIDC claims; MCP applies `DIRECT_DEPLOY` and the admin exception); the cost is ~60 lines of JSON-RPC client.

Direct deployments are allowed by the platform setting `DIRECT_DEPLOY`: `everyone` (local installs) lets any app member deploy with their PAT; `admins` (production) only admins, as an audited **admin exception**: pass `--reason`, recorded on the release. The release also records `git rev-parse HEAD` of `--dir` (the summary flags uncommitted changes; refusing them is the `admin-deploy` skill's job). In CI, `--reason` is ignored: the release records the run, commit and actor from the token.

## What it does

`.platform.json` at the repository root:

```json
{ "app": "my-app", "acceptedLints": [{ "name": "rls_disabled_in_public", "object": "public.audit_log" }] }
```

`acceptedLints` entries are a lint name (any object) or `{ name, object }`; adding one goes through code review, and the platform audits every acceptance.

**check** (pull requests; publishes nothing):

1. `get_app` (CI: the token's mode, `check` or `deploy`, and why);
2. migrations dry run with the security linter (always rolled back): fails on any new `ERROR` lint not in `acceptedLints`;
3. lists the functions (not deployed);
4. build: `npm ci` if `node_modules` is missing, then `npm run build` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from `get_app`.

**deploy** (push on the protected default branch, or direct):

1. `get_app`; in CI, a check-mode token (pull request, other branch, unprotected branch) stops here;
2. build, **before** anything is published: a broken build publishes nothing;
3. begin the release (CI: one per run attempt; direct: `begin_release` with commit and reason);
4. migrations with `accept_lints` = `acceptedLints`: the platform rejects the whole batch on a new unaccepted `ERROR` lint;
5. functions: `tar.gz` of `supabase/functions` (+ `supabase/config.toml`), upload, `finalize` (each function boots on the new version before the switch);
6. frontend: `tar.gz` of `dist/`, upload, `finalize`;
7. smoke test: `GET /` must return the new `dist/index.html`, and an `OPTIONS` preflight on each function must not answer 5xx or `BOOT_ERROR`;
8. finish the release `succeeded`; any failure after step 3 finishes it `failed` with the error.

Every step is printed, and a markdown report (steps, blocking / accepted / other lints, app and Studio links, release) is appended to `$GITHUB_STEP_SUMMARY` when set. Exit code: 0 success, 1 check or deployment failed, 2 usage error.

## In GitHub Actions

[`action.yml`](action.yml) is a composite action that runs `node "$GITHUB_ACTION_PATH/src/main.ts" <mode> --auth oidc`. The reusable workflow uses it as `uses: <org>/<platform repo>/packages/deploy-cli@<ref>`: the runner downloads the platform repository like any action (its Actions access must be open to the organization's repositories), so no checkout token, npm registry or build step is needed. The workflow sets up Node and runs `npm ci` in the app first.

Publishing (manual for now): the internal platform repository (the plugin marketplace) must contain `.github/workflows/deploy.yml` (copied from `ci/.github/workflows/deploy.yml`, which lives under `ci/` so that it does not run on this repository) and `packages/deploy-cli/`. Then:

1. replace the `YOUR-ORG/platform` placeholders in the workflow and in the app's caller ([`ci/examples/platform.yml`](../../ci/examples/platform.yml));
2. set `CI_ALLOWED_WORKFLOWS` on the platform to `<org>/<repo>/.github/workflows/deploy.yml@refs/heads/main` (pin the same ref as the composite action);
3. set the `PLATFORM_URL` variable at the organization level (the platform API URL, which is also the OIDC audience);
4. replace the company checks placeholder job with the company's checks.

## Tests

`apps/control-plane/test/deploy-cli.e2e.test.ts` (part of `pnpm --filter @platform/control-plane e2e`, or alone with `e2e:deploy-cli`) deploys a copy of `examples/todo-app` against the running stack, without GitHub: in direct mode with the admin PAT (`DIRECT_DEPLOY=admins`, admin exception and reason), then in CI mode with a local fake `ACTIONS_ID_TOKEN_REQUEST_URL` serving tokens signed by a test key that the platform trusts (as in `ci.e2e.test.ts`). It checks the served build, REST under RLS, the function, the release rows (source, commit, run), and the lint cases: check fails on a blocking lint, a PR token cannot deploy, deploy is rejected and the release fails, `acceptedLints` lets it through.
