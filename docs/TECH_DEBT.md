# Tech debt and known limitations

Single list of the technical debt and known limitations of the platform, checked against the code on 2026-10-02.
Missing features (❌ and 🟡 items) are tracked in [USER_JOURNEYS.md](USER_JOURNEYS.md), not here.

**Priorities**

- **P1**: security issue, or blocks a production deployment.
- **P2**: robustness, operations or scaling.
- **P3**: comfort or cleanup.

**Updating this file**: add an entry when you accept a debt, remove it when it is paid off. IDs are stable: never
reuse a removed ID. Effort is in days when known.

## Security (cross-cutting)

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| SEC-1 | The edge runtime shares the `plat` network with Postgres, GoTrue, PostgREST, the control plane (including its internal `:3001` listener) and Studio. Outbound network from functions is fully open (`allow_net: []`). | A compromised or malicious function can reach `db:5432` (with its app's owner credentials only), scan internal services, and call `control-plane:3001` and `studio:3000` (protected only by the config token and the header signature). | Put the edge on a dedicated network with Caddy and Internet egress only; functions already reach their app through `SUPABASE_URL` (internal Caddy). `deny_net` by hostname is not enough (IP bypass). | 0.5–1 | P1 | [M1 §4.8](../spikes/m1-edge-functions/REPORT.md), [M2](../spikes/m2-control-plane/REPORT.md), [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| SEC-2 | The Docker socket is mounted in the control plane. | Equivalent to root on the host if the control plane is compromised. | Filtering socket proxy (containers with `platform.*` labels, allowed images only), or a separate orchestrator agent. | 1 | P1 | [M2](../spikes/m2-control-plane/REPORT.md) |
| SEC-3 | Platform login (`/_platform/login`) has no rate limiting or lockout, and the session cookie flow has no CSRF token (SameSite=Lax only). | Online password guessing on builder and admin accounts. SameSite=Lax does not stop requests from `<app>.<domain>`, which is same-site with Studio: a builder-deployed frontend could send state-changing requests to Studio with a visitor's session. | Per-account and per-IP throttling on login; CSRF token or Origin check on non-GET requests in the forward auth. | 0.5 | P1 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| SEC-4 | `postgres` keeps `CREATEROLE` and `BYPASSRLS`, and the `app_*` roles are not in `supautils.reserved_roles` (verified on `plat-db`). | Whoever holds the `postgres` password can reset any `app_<id>_owner` password and connect to any app database. | Remove `CREATEROLE` from `postgres` at bootstrap (the control plane uses `supabase_admin`), or reserve the `app_*` roles. | 0.5 | P2 | [M0 rec. 4](../spikes/m0-tenancy/REPORT.md), [M2](../spikes/m2-control-plane/REPORT.md) |
| SEC-5 | Studio Settings > API keys shows the app's `service_role` key (as upstream Studio does). | Since the owner no longer has `BYPASSRLS`, the key gives a builder more than the database: GoTrue's admin API (all `auth` tables) and PostgREST as `service_role`. | Hide or mask the key in the policy and the fork UI. | 0.5 | P2 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md), [M0bis](../spikes/m0bis-studio/REPORT.md) |
| SEC-6 | The `platform_session` cookie is forwarded to Studio, and from there to pg-meta (`constructHeaders`). | The platform session token reaches components that do not need it (fork code, pg-meta logs). | Delete the `Cookie` header in the Caddy Studio route after the forward auth (the identity travels in the signed `X-Platform-*` headers). | 0.1 | P2 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| SEC-7 | `SUPABASE_DB_URL` in functions uses the app's owner role. | A compromised function gets DDL rights and bypasses RLS on the app's `public` tables. | Dedicated `app_<id>_fn` role with DML only. | 0.5 | P2 | [M1 §6](../spikes/m1-edge-functions/REPORT.md), [M2 rec. 3](../spikes/m2-control-plane/REPORT.md) |
| SEC-8 | PAT columns `scopes` and `app_ids` exist but are not enforced. | Every PAT has the full rights of its user on all their apps. | Enforce them in `appForUser` and in the MCP tool dispatch. | 0.5 | P2 | [M2](../spikes/m2-control-plane/REPORT.md) |
| SEC-9 | The master key (`PLATFORM_MASTER_KEY`) lives in `deploy/.env`, with no rotation and no re-encryption of `apps.secrets_enc` and `app_secrets`. | A leaked key cannot be rotated without manual work. | Key id in the ciphertext, rotation command that re-encrypts all secrets. | 1 | P2 | [M2](../spikes/m2-control-plane/REPORT.md) |

## Control plane & MCP

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| CP-1 | A migration that contains its own `COMMIT` (or `BEGIN`) breaks the batch transaction. | It escapes the rollback, hence the blocking linter, and the all-or-nothing guarantee. | Reject transaction control statements in migrations (parse, or run each migration as a single extended-protocol statement where possible). | 0.5 | P2 | [M2 post-M3](../spikes/m2-control-plane/REPORT.md) |
| CP-2 | Concurrency: two `create_deployment` calls can compute the same version (unique constraint error), and two `finalize_deployment` on the same app and kind are not serialized (status checked without a row lock). | Spurious errors, or two concurrent switches of `current`. | Advisory lock per (app, kind) in create and finalize, `select ... for update` on the deployment. | 0.5 | P2 | [M2](../spikes/m2-control-plane/REPORT.md) |
| CP-3 | No cleanup of old site and function versions (`v<N>` directories), nor of uploads that were never finalized. | Disk usage grows with every deployment. | Keep the last N versions (delay longer than `wall_clock_ms` for functions), purge expired uploads periodically. | 0.5 | P2 | [M1 §6](../spikes/m1-edge-functions/REPORT.md), [M2](../spikes/m2-control-plane/REPORT.md) |
| CP-4 | The linter has 5 rules rewritten from splinter (`rls_disabled_in_public`, `rls_enabled_no_policy`, `policy_exists_rls_disabled`, `security_definer_view`, `function_search_path_mutable`). | Other risky patterns are not flagged (e.g. `security definer` functions exposed to `anon`, tables readable without policies through grants). | Port more splinter rules, or run splinter itself. | 1 | P2 | [M2](../spikes/m2-control-plane/REPORT.md) |
| CP-5 | Provisioning runs synchronously inside the MCP call, without a job queue; recovery relies on calling `create_app` again. | Fine at ~1 s per app; long tasks (backups, upgrades) will need retries and progress. | Job queue when backups and upgrades land. | 2 | P3 | [M2](../spikes/m2-control-plane/REPORT.md) |
| CP-6 | Migration deployments: every row stays `live`, and `list_deployments` does not accept `kind: "migrations"`. `statements` is stored as a one-element array (the CLI splits by statement). | Misleading history; `db pull` / `db diff` compatibility not checked. | Mark previous migration rows `ready`, add the kind to the zod schema, split statements or document the format. | 0.5 | P3 | [M2](../spikes/m2-control-plane/REPORT.md), [M3](../spikes/m3-plugin/REPORT.md) |
| CP-7 | The `howto` returned by `create_deployment` writes to a fixed `/tmp/bundle.tgz`. | Concurrent deployments on the same machine overwrite each other (the plugin uses its own `pack.sh` with `mktemp`). | Use `mktemp` in the `howto`. | 0.1 | P3 | [M3](../spikes/m3-plugin/REPORT.md) |

## Postgres & provisioning

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| PG-1 | PostgREST v14.17 never releases idle connections (`db-pool-max-idletime` has no effect) and keeps one more for the `LISTEN` channel: an app that served traffic keeps 4 connections forever. | About 207 idle connections at 50 apps, 350+ at peak; `max_connections=500` is the only headroom. | `PGRST_DB_POOL=2`, and `PGRST_DB_CHANNEL_ENABLED=false` with a schema reload by `SIGUSR1` after migrations (the control plane currently sends `NOTIFY pgrst`). | 0.5 | P2 | [M0](../spikes/m0-tenancy/REPORT.md) |
| PG-2 | No connection pooler. | Beyond about 60 apps, or once Storage and Realtime connect, the cluster runs out of connections. | Supavisor in session mode for PostgREST. | 2 | P2 | [M0](../spikes/m0-tenancy/REPORT.md), [PLAN_1 §12](../PLAN_1.md) |
| PG-3 | Noisy neighbour: one shared cluster, mitigated only by per-role `CONNECTION LIMIT` and `statement_timeout` (owner 60 s, authenticator 8 s). | One app can saturate CPU, I/O or memory for all apps. | Per-app monitoring (`log_line_prefix` already has `db=%d`), alerting, and quotas or isolation for heavy apps. | 2 | P2 | [PLAN_1 §12](../PLAN_1.md) |
| PG-4 | The owner's `platform_owner_read` policies on `auth.users` and `auth.identities` are lost if a GoTrue migration recreates one of these tables; they come back at the next `register` / `syncAll`. GoTrue upgrades across N databases were never tested. | Studio Auth > Users shows no users between a GoTrue upgrade and the next control plane start. | Run `studio.register` for each app right after recycling its GoTrue container (part of the A8 procedure). | 0.5 | P2 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md), [M0](../spikes/m0-tenancy/REPORT.md) |

## Edge functions

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| EDGE-1 | Memory of retired workers is not returned (floor ~260 MB, +73 MB over 6 churn cycles of 50 workers). The compose sets `mem_limit: 1g`, below the 1.5–2 GB recommended for 50 apps, and no `--max-parallelism`. No long-run test. | Under load or after long uptime, the edge container can be OOM-killed: every app's functions go down for a few seconds. | `--max-parallelism`, `mem_limit` sized to the number of apps, scheduled restart if the floor keeps growing, long-run measurement. | 1 | P2 | [M1 §3, §5](../spikes/m1-edge-functions/REPORT.md) |
| EDGE-2 | The warm-up before the switch calls the handler with an `OPTIONS` preflight. | A function with side effects regardless of the method runs them at deployment time. | Document it for builders; or warm with module evaluation only if edge-runtime allows it. | 0.5 | P3 | [M2 post-M3](../spikes/m2-control-plane/REPORT.md) |
| EDGE-3 | A function that reads a secret at boot fails the warm-up (`WARM_FAILED`) if its secrets are not set before `finalize_deployment`. | The deployment is refused (the skill already sets secrets first). | Document in the MCP tool description. | 0.1 | P3 | [M2 post-M3](../spikes/m2-control-plane/REPORT.md) |
| EDGE-4 | `staticPatterns` is empty: `Deno.readFile(new URL("./x", import.meta.url))` fails, and `static_files` from `config.toml` is ignored. | Functions that ship data files do not work. | Generate `staticPatterns` from `static_files` in `functions.json`. | 0.5 | P3 | [M1 §4.3](../spikes/m1-edge-functions/REPORT.md) |
| EDGE-5 | Only legacy HS256 keys (anon / service_role signed with the app secret); `alg` other than HS256 is refused. | The new Supabase publishable/secret keys and asymmetric JWTs (ES256 + JWKS) are not supported. | JWKS per app in the app config, if adopted. | 1 | P3 | [M1 §4.6](../spikes/m1-edge-functions/REPORT.md), [M0 rec. 9](../spikes/m0-tenancy/REPORT.md) |
| EDGE-6 | The gateway token cannot be rotated without downtime: the main worker accepts a single token. | Rotation requires restarting Caddy and the edge together. | Accept a list of tokens during the transition. | 0.5 | P3 | [M1 §6](../spikes/m1-edge-functions/REPORT.md) |
| EDGE-7 | `servicePath` temp directories (and their in-memory map) accumulate, one per (function version, app config) pair, until the edge restarts. | Negligible growth; cleaned on restart. | Evict entries for retired versions. | 0.5 | P3 | [M1 §5](../spikes/m1-edge-functions/REPORT.md) |
| EDGE-8 | The retry on `WorkerAlreadyRetired` only applies to requests without a body (a streamed body cannot be replayed), as in the Supabase CLI. | Rare 5xx on POST requests that hit a retiring worker. | Buffer small bodies to allow one retry. | 0.5 | P3 | [M1 §5](../spikes/m1-edge-functions/REPORT.md) |

## Studio

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| STU-1 | Vendored fork from a single maintainer, with 6 platform patches to replay on each update; the pg-meta proxy fix and the per-project Auth/Storage routes were not proposed upstream. | Every fork update is manual work, and drift from upstream Studio grows. | Propose patches 5 and 6 upstream; keep the e2e Studio suite as the update gate. | 1 | P2 | [M0bis](../spikes/m0bis-studio/REPORT.md), [PLATFORM_PATCHES](../apps/studio/PLATFORM_PATCHES.md), [PLAN_1 §12](../PLAN_1.md) |
| STU-2 | The forward auth runs 2 SQL queries per Studio request (session, then the user's apps). | Load on the `platform` database grows with Studio usage (many requests per page). | Short in-memory cache keyed by the session hash. | 0.5 | P2 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| STU-3 | SQL snippets are disabled (`SNIPPETS_MANAGEMENT_FOLDER` unset): the fork's folder is shared by all projects. | No saved queries in the SQL editor. | One folder per ref. | 0.5 | P3 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| STU-4 | Functions tab refused (the fork's functions folder is global) and Logs tab empty (global Logflare). | Builders use MCP `get_logs` and the repo instead. | Wire both tabs to the control plane. | 2–3 | P3 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| STU-5 | Storage routes target the right project but return a JSON 500: no Storage before M5. | Storage tab unusable. | Add `/storage/v1` to the internal Caddy routes with M5. | 0.1 | P3 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| STU-6 | GraphiQL (`pages/api/platform/projects/[ref]/api/graphql.ts`) still uses the global `SUPABASE_URL` (unreachable on purpose). | GraphiQL fails. | Same pattern as patch 6 (`projectApi.ts`). | 0.1 | P3 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| STU-7 | The fork UI still shows "New project", "New organization" and the "Enterprise" label; the actions answer 403. | Confusing UI. | Hide them in the fork. | 0.5–1 | P3 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md), [M0bis](../spikes/m0bis-studio/REPORT.md) |
| STU-8 | Single pnpm workspace with the fork: `node_modules` of 1.9 GB, the fork's `overrides` apply to the whole workspace, and its `minimumReleaseAge` was dropped. | Slower installs, platform packages pinned by the fork's overrides, weaker supply-chain guard. | Split the fork into its own workspace, or restore `minimumReleaseAge` with exclusions. | 1 | P3 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md), [UPSTREAM](../apps/studio/UPSTREAM.md) |
| STU-9 | The Studio image is 1.13 GB and the host build needs ~8.3 GB RSS (85–100 s). | Slow builds; not buildable on a small VM. | Prune the standalone output; build in CI. | 0.5 | P3 | [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |

## Routing & TLS (Caddy)

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| RT-1 | Hosts are hardcoded for local use: `api.localhost` in `deploy/caddy/caddy.json`, `api.localhost:8100` / `studio.localhost:8100` in `install.sh` and `STUDIO_HOST` / `API_HOST` / `APPS_DOMAIN` in the compose file. | Cannot be installed on a real domain without hand edits (TLS itself is tracked in USER_JOURNEYS A1). | Template the domain in `install.sh` and generate the bootstrap Caddy config. | 0.5 | P1 | [M2](../spikes/m2-control-plane/REPORT.md) |
| RT-2 | `upsertApp` deletes then re-adds each app's routes, and `syncAll` does it app by app at every control plane start. | Short 404 windows for each app at startup; one admin API round trip per app (slow at 50+ apps). | Build the whole `apps` subroute and replace it with a single `PATCH`. | 0.5 | P3 | [M2](../spikes/m2-control-plane/REPORT.md) |
| RT-3 | The Caddy admin API (`127.0.0.1:2030`) and Postgres (`127.0.0.1:54350`) are published on the host loopback. | Any local process on the host can reconfigure routing; only the control plane needs the admin API. | Drop the port mappings in production (keep them behind a dev override). | 0.1 | P3 | [M0 rec. 8](../spikes/m0-tenancy/REPORT.md) |

## Deployment & install

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| DEP-1 | The orchestrator does not pull images: GoTrue and PostgREST images are assumed present. | `create_app` fails on a fresh host or after an image bump. | Pull missing images in `ensure()`, or pre-pull in `install.sh`. | 0.5 | P2 | [M2](../spikes/m2-control-plane/REPORT.md) |
| DEP-2 | Never run on a native Linux host: all measurements and the symlink switch come from Docker Desktop on macOS (named volumes avoid the bind-mount `rename()` issue). | RAM sizing and the `current` symlink swap are unverified on the production target. | Run install + e2e on a Linux VM and redo the measurements. | 1 | P2 | [M1 §5, §7](../spikes/m1-edge-functions/REPORT.md) |
| DEP-3 | Corporate proxy with authentication or TLS interception, and npm mirrors, are untested (`HTTPS_PROXY` is honoured). | `npm:` imports may fail behind a corporate proxy (`DENO_CERT`, `NPM_CONFIG_REGISTRY` likely needed). | Test behind a real proxy and document the variables. | 0.5 | P3 | [M1 §5](../spikes/m1-edge-functions/REPORT.md) |

## Claude Code plugin

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| PLG-1 | No evaluation suite for the deploy skill. | Regressions on the safety stops (RLS, lints, missing secrets, boot errors) go unnoticed. | `claude plugin eval` from scenarios 1–6 of the M3 report. | 1 | P2 | [M3](../spikes/m3-plugin/REPORT.md) |
| PLG-2 | Upload URLs appear in clear in Claude transcripts. | Single-use and 15 min TTL, so low risk. | Accept, or return a short-lived id the helper script resolves. | 0.5 | P3 | [M3](../spikes/m3-plugin/REPORT.md) |
| PLG-3 | The MCP tools are deferred, so every run spends a turn on `ToolSearch`; the server has no `instructions` pointing to the skill. | One extra turn per run; harder for Claude to find the workflow without the skill. | Add server `instructions`. | 0.1 | P3 | [M3](../spikes/m3-plugin/REPORT.md) |

## Tests & tooling

| ID | Issue | Impact | Suggested fix | Effort | Priority | Source |
|---|---|---|---|---|---|---|
| TT-1 | No CI: typecheck, unit tests (`studio-policy`, `deno test` of the main worker) and the e2e suites are run by hand; the e2e suites need the full `plat` stack running locally. | Regressions are caught late. | CI job: typecheck + unit tests on every push, e2e on a disposable stack. | 1 | P2 | [M2](../spikes/m2-control-plane/REPORT.md), [M0ter](../spikes/m0ter-studio-builders/REPORT.md) |
| TT-2 | The fork's own `tsc` is red upstream and excluded from `pnpm -r typecheck` (`typecheck:upstream`); its unit tests are not vendored. | Patches to fork files are only covered by the Studio e2e suite. | Follow upstream; type-check the files touched by the patches. | 0.5 | P3 | [PLATFORM_PATCHES](../apps/studio/PLATFORM_PATCHES.md), [UPSTREAM](../apps/studio/UPSTREAM.md) |
| TT-3 | The main worker's `deno test` is not wired into the root scripts. | Easy to forget. | Add a root `test` script that runs it with the unit tests. | 0.1 | P3 | [M2 post-M3](../spikes/m2-control-plane/REPORT.md) |

## Accepted trade-offs

Deliberate choices, not debt. Revisit only if the context changes.

- **Edge functions are isolated by V8 isolate**, not by container or process: a V8 or edge-runtime flaw would break
  isolation between apps. Acceptable for code from trusted colleagues; to be documented for clients
  ([M1 §4.9](../spikes/m1-edge-functions/REPORT.md), [PLAN_1 §12](../PLAN_1.md)).
- **The owner role sees every row of its `public` tables**: as the tables' owner it is not subject to their RLS
  (unless `FORCE ROW LEVEL SECURITY`), like Supabase's `postgres`. This applies to `execute_sql`, Studio and
  `SUPABASE_DB_URL`. An owner view or `SECURITY DEFINER` function that reads `auth.users` exposes all its rows; the
  linter flags `security_definer_view` ([M0ter](../spikes/m0ter-studio-builders/REPORT.md)).
- **Cluster metadata is visible across apps**: `pg_database` and `pg_roles` list the other apps' database and role
  names, now also in builders' Studio. Names only, no access to data; inherent to a shared cluster
  ([M0bis](../spikes/m0bis-studio/REPORT.md), [M0ter](../spikes/m0ter-studio-builders/REPORT.md)).
- **`anon`, `authenticated` and `service_role` are global NOLOGIN roles** shared by all apps; grants are per database
  and `SET ROLE` across apps is refused ([M0](../spikes/m0-tenancy/REPORT.md)).
- **Studio project config cache**: a removed app stays visible for up to 2 s; if the control plane is down, the last
  config is served for up to 30 s ([M0ter](../spikes/m0ter-studio-builders/REPORT.md)).
- **`accept_lints`** lets a builder keep an `ERROR` lint with explicit consent; every acceptance is audited
  ([M2 post-M3](../spikes/m2-control-plane/REPORT.md)).
- **Studio license** (Sustainable Use License): not a blocker as long as the product is not resold
  ([CLAUDE.md](../CLAUDE.md)).
