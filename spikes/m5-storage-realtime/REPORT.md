# Milestone M5: Storage and Realtime (report)

Date: 2026-10-02. Images: `supabase/storage-api:v1.74.0` and `supabase/realtime:v2.134.10`, the versions pinned by the
official Supabase `docker-compose.yml` that also pins the GoTrue v2.196.0 and PostgREST v14.17 used since M0. They
ran next to the `plat` stack, on its Postgres (`supabase/postgres:17.6.1.136`). Host: Linux Docker Engine.

## Verdict

**Both services run as one shared multi-tenant instance for all apps.** The exit criterion is met: file upload and
realtime subscription work on 2 apps, isolated from each other (`pnpm --filter @platform/control-plane
e2e:storage-realtime`, 7/7, also part of `e2e`).

| | Shared multi-tenant (chosen) | Plan B: one container per app |
|---|---|---|
| Storage RAM | 107–128 MB in total, with 2 or 20 tenants, idle or under traffic | ~110 MB per app: ~5.5 GB for 50 apps |
| Realtime RAM | 192–195 MB idle, 206 MB with 20 tenants holding a client each (~0.7 MB per active tenant) | ~190 MB per app: ~9.5 GB for 50 apps |
| Registering an app | Storage 0.3–0.4 s (its 69 migrations), Realtime 0.06–0.3 s (82 migrations) | a container start |

Plan B is ruled out by memory alone: about 15 GB for 50 apps on a 16 GB VM. The shared mode works with per-app login
roles, with three workarounds and one upstream limitation:

- **Storage** works as designed. The tenant comes from `X-Forwarded-Host`, which Caddy sets from the app host (a
  client value is replaced). Storage runs its own migrations in the app database, as `app_<id>_storage_admin`, when
  the tenant is registered.
- **Realtime's tenant migrations need a superuser**: they `GRANT` the supautils-reserved role
  `supabase_realtime_admin`. The control plane creates the tenant with a short-lived superuser login (one-time
  password, locked again right after), then switches it to the app's own role `app_<id>_realtime`. That role only
  needs `REPLICATION`, membership in `supabase_realtime_admin` and `SET` on `log_min_messages`.
- **Upstream limitation, Realtime "broadcast changes"**: the slot of Realtime's *Broadcast from Database* feature has
  one fixed name per Realtime instance, and replication slots are cluster-wide. Only one app at a time gets it.
  `postgres_changes`, client broadcast and presence are not affected. See "Limits" below.

## What was tested

Spike scripts (`scripts/`), run next to the platform, on its Postgres:

```
up.sh        metadata databases of both services, N tenant databases spike_<t> cloned from template_supabase with
             per-tenant roles, containers m5-storage, m5-realtime and m5-caddy (Caddyfile: <t>.m5.localhost:8105)
register.ts  registers the tenants (Storage admin API; Realtime: created with a superuser, then switched to the
             tenant's role)
test.ts      supabase-js checks on 2 tenants: bucket, policies, upload/download, RLS, cross-tenant keys,
             postgres_changes, broadcast, cross-tenant subscription
hold.ts      one realtime client and one 100 KB upload per tenant, held N seconds; prints slots, sessions, memory
down.sh      removes every spike object (containers, volume, databases, roles)
```

Then the platform implementation, tested end to end (`apps/control-plane/test/storage-realtime.e2e.test.ts`).

### Storage API, multi-tenant mode

- `IS_MULTITENANT=true`. The tenants are stored in a metadata database of their own (`MULTITENANT_DATABASE_URL`, role
  `platform_storage` on the platform). The admin API listens on `:5001` (`ADMIN_API_KEYS`); tenant secrets are
  encrypted with `ENCRYPTION_KEY`.
- **Tenant registration**: `PUT /tenants/<slug>` with `anonKey`, `serviceKey`, `jwtSecret`, `databaseUrl`,
  `maxConnections`, `fileSizeLimit` and `features` (image transformation and S3 protocol off). It runs the 69 tenant
  migrations synchronously: `GET /tenants/<slug>/migrations` then says `COMPLETED`. 300–440 ms on an empty database,
  30–130 ms when nothing is pending.
- **Tenant routing**: `REQUEST_X_FORWARDED_HOST_REGEXP=^([a-z][a-z0-9-]{1,30}[a-z0-9])$` (the slug pattern), applied
  to `X-Forwarded-Host`. Caddy sets the header to the slug taken from the host, so a forged header cannot select
  another tenant. Tested: app B's user with `X-Forwarded-Host: <B>` on app A's host is refused.
- **Roles**: with `DB_INSTALL_ROLES=false` the migrations neither create nor alter roles. `app_<id>_storage_admin`
  (`LOGIN NOINHERIT`, member of `anon`, `authenticated` and `service_role`, `search_path = storage`) owns the `storage`
  schema and every object the migrations create. Storage switches to the JWT's role (`set_config('role', ...)`) in
  each transaction, so RLS on `storage.objects` applies with the app's JWT. The image's `storage` schema is empty in
  app databases: M0 already dropped what `supabase_storage_admin` owned in `template_supabase` clones.
- **Storage schema: migrations run by Storage per tenant**, not baked into `template_supabase`. Storage tracks them in
  `storage.migrations` and runs pending ones on the next request after an upgrade (`DB_MIGRATIONS_STRATEGY`
  `on_request`, as the role that owns the schema). No upgrade procedure is needed, unlike Realtime.
- **Policies**: the app's owner role is a member of `app_<id>_storage_admin`. A migration (or Studio) can therefore
  `create policy ... on storage.objects` and insert into `storage.buckets`, as Supabase's `postgres` does.
- **Files**: `FILE_STORAGE_BACKEND_PATH/<GLOBAL_S3_BUCKET>/<tenant>/<bucket>/<object>/<version>`, that is one
  directory per app (`tenants/<slug>/`): easy to back up and to delete.
- **Connections**: 1 to the metadata database. Per tenant, a pool of at most `maxConnections` (3 on the platform),
  **released after one minute without requests** (`DATABASE_FREE_POOL_AFTER_INACTIVITY`). An idle app has 0
  connections (measured: 20 connections during the burst of 20 uploads, 0 two minutes later).

### Realtime, multi-tenant mode

- Tenants are stored in a metadata database of their own (`platform_realtime`, schema `_realtime`, which must exist
  before Realtime's first start: in the official setup the supabase/postgres image creates it). Management API:
  `/api/tenants`, with a bearer JWT signed with `API_JWT_SECRET`. Realtime also needs `METRICS_JWT_SECRET`,
  `SECRET_KEY_BASE` and a 16-character `DB_ENC_KEY`.
- **Tenant routing**: the tenant is the first label of the `Host` header. Caddy sets `Host: <slug>.realtime`, both on
  the public app host and on the internal gateway (where the host is `caddy`).
- **Tenant settings**: the `postgres_cdc_rls` extension with the app database and role, `publication:
  supabase_realtime`, `slot_name: realtime_<id>` (slots are cluster-wide: one name per app), `subcriber_pool_size: 1`
  (sic; 4 by default), and the app's JWT secret. A JWT of another app fails with `JwtSignatureError`; another app's
  anon key is refused when the websocket connects.
- **Tenant migrations need a superuser.** Creating a tenant (`POST /api/tenants`) runs them synchronously, as the
  tenant's database user. With a per-app role they fail on:
  1. `CREATE ROLE supabase_realtime_admin`, then `GRANT supabase_realtime_admin TO postgres`: supautils reserves the
     role and its memberships to superusers. Creating the role beforehand is not enough: the `GRANT` is refused too;
  2. `realtime.list_changes()`, declared with `SET log_min_messages` (a superuser setting). `GRANT SET ON PARAMETER
     log_min_messages` fixes this one.

  Realtime's fast path (a schema dump, applied when no migration ran yet) also hardcodes `supabase_admin` as the owner
  of `realtime.schema_migrations`, of the schema and of a function, which the app role then cannot read (`permission
  denied for table schema_migrations`). Retained recipe, implemented in the control plane:
  - the tenant is created with a dedicated superuser, `platform_realtime_migrator`, which gets `LOGIN` and a one-time
    password for that call only, then goes back to `NOLOGIN` without password, its sessions terminated;
  - every `realtime` object owned by a superuser is reassigned to `supabase_realtime_admin`;
  - the tenant is switched (`PUT`) to `app_<id>_realtime`: `LOGIN NOINHERIT REPLICATION`, member of `anon`,
    `authenticated` and `service_role` (the RLS of `postgres_changes` is checked with `SET ROLE`), member of
    `supabase_realtime_admin` with `INHERIT` (owner of the realtime objects, including the daily partitions of
    `realtime.messages`), `SET` on `log_min_messages`.

  A `PUT` does not run migrations: they run when the tenant's connection starts (first client), as the app role.
  After a Realtime upgrade that brings tenant migrations, the tenants must be recreated with the migrator
  (`realtime-migrate` CLI).
- **REPLICATION per app does not leak across apps**: the image's `pg_hba.conf` has no `replication` line, so there is
  no physical streaming; logical decoding needs a connection to the database, and the role may only connect to its
  own.
- **`postgres_changes`**: Realtime polls a **temporary** logical slot (`realtime_<id>_`) with `wal2json` from a normal
  backend (not a walsender). The slot is created when the first subscriber of a published table joins, and goes away
  with its session. The app owner adds tables with `alter publication supabase_realtime add table ...`: in each app
  database the publication belongs to the owner role. RLS applies (tested: bob's insert is not delivered to alice).
- **Broadcast and presence** need nothing more than the tenant connection.
- **"Broadcast changes" (Broadcast from Database)**: on every tenant start, Realtime opens a logical replication
  connection (a walsender) on `realtime.messages`, with a publication it creates (which needs `CREATE` on the
  database: the control plane creates it instead, owned by the app role) and the slot
  `supabase_realtime_messages_replication_slot_` + `SLOT_NAME_SUFFIX`, an environment variable of the instance. Every
  app gets the same slot name: the second one logs `StartReplicationFailed: replication_slot_in_use`, waits for the
  first one's walsender to exit and, after a 2-hour recovery window, stops its tenant connection
  (`lib/realtime/tenants/connect.ex`): its clients are disconnected and reconnect. The 2-hour restart was read in the
  source, not observed.
- **Connections per tenant with clients**: `realtime_connect`, `realtime_rls`, `realtime_subscription_manager` and
  `realtime_subscription_manager_pub` (`subcriber_pool_size`, 4 by default): **4**. Add the polling slot's session while
  `postgres_changes` subscribers exist, and the walsender of the one app holding the broadcast changes slot. Realtime
  keeps 7 connections to its metadata database. **The tenant connections outlive the clients**: Realtime stops a tenant
  after 11 one-minute checks without users. Measured: released 12 minutes after the last client left.
- **Postgres settings**: `wal_level=logical` is the image's default. `max_replication_slots=5` and
  `max_wal_senders=10` were too low; they were raised to 100 and 20 (`deploy/docker-compose.yml`, restart of `db`).
  `max_slot_wal_keep_size=512MB` (image default) caps the WAL a lagging slot can hold.

### Measurements (`docker stats`, `pg_stat_activity`)

| | 2 tenants, idle | 20 tenants, idle | 20 tenants, 1 client and 1 upload each |
|---|---|---|---|
| Storage RAM | 121 MB | 128 MB | 107–111 MB |
| Realtime RAM | 195 MB | 192 MB | 206 MB |
| Storage connections | 1 (metadata) | 1 | 1 + 20 (released after 1 min) |
| Realtime connections | 7 (metadata) | 7 | 7 + 80 (4 per tenant) + 1 walsender |
| Replication slots | 0 | 0 | 3: 2 polling slots (the 2 tenants with a published table) and the broadcast changes slot |

### Extrapolation to 50 apps on a 16 GB VM

- **RAM**: about +0.35 GB for both services (Storage ~0.13 GB, Realtime ~0.25 GB with 50 active tenants), next to
  the ~4 GB of GoTrue and PostgREST measured in M0. Images on disk: 1.3 GB (Storage) and 0.56 GB (Realtime).
- **Connections**: Storage adds at most 3 per app under traffic, 0 when idle. Realtime adds 4 per app used in the last
  ~12 minutes: up to **+200** at 50 apps. With M0's 207 (idle) to 357 (peak), that reaches `max_connections=500`
  (TECH_DEBT PG-5, PG-2).
- **Slots**: at most one polling slot per app with `postgres_changes` subscribers, plus one: `max_replication_slots=100`.

## Decision

| Service | Choice | Why |
|---|---|---|
| Storage | **Shared, multi-tenant** | Works as designed, with a per-app role and a per-app directory; RAM stays flat (~0.12 GB) whatever the number of apps; connections are released when idle. Plan B: ~5.5 GB at 50 apps |
| Realtime | **Shared, multi-tenant** | `postgres_changes`, broadcast and presence work per app with per-app roles, in ~0.2 GB. Plan B: ~9.5 GB at 50 apps. Accepted: superuser-only tenant migrations (handled by the control plane), 4 connections per recently used tenant, broadcast changes for one app at a time |

## Implementation (platform)

- `deploy/docker-compose.yml`: services `storage` (`plat-storage`, 512 MB limit, volume `storage-data`) and `realtime`
  (`plat-realtime`, 1 GB limit), no published port. `install.sh` generates `STORAGE_DB_PASSWORD`, `STORAGE_ADMIN_KEY`,
  `STORAGE_ENCRYPTION_KEY`, `REALTIME_DB_PASSWORD`, `REALTIME_API_JWT_SECRET`, `REALTIME_DB_ENC_KEY` and
  `REALTIME_SECRET_KEY_BASE`. Postgres: `max_replication_slots=100`, `max_wal_senders=20`. The images are pulled by
  `docker compose` (Docker Hub; behind its rate limit, pull them through a mirror and retag, DEP-4).
- `initCluster`: metadata databases `platform_storage` and `platform_realtime` (schema `_realtime`) with their roles,
  the role `supabase_realtime_admin`, the locked `platform_realtime_migrator`.
- Provisioning (`apps.ts`, `storage-realtime.ts`, `packages/sql`): roles `app_<id>_storage_admin` and
  `app_<id>_realtime` (their passwords are added to the app's encrypted secrets, and generated for older apps),
  grants, `storage` schema to the storage role, `supabase_realtime` publication to the owner. Then `registerStorage`
  and `registerRealtime`, after GoTrue's migrations. At control plane start, existing apps are registered in the
  background.
- Routing (`router.ts`, generic routes of TT-4): `/storage/v1/*` → `storage:5000` (`X-Forwarded-Host: <slug>`,
  `X-Forwarded-Prefix: /storage/v1`); `/realtime/v1/websocket` → `realtime:4000/socket/websocket`;
  `/realtime/v1/api/broadcast[/...]` and `/realtime/v1/api/ping` → `realtime:4000/api/...` (`Host: <slug>.realtime`).
  Any other `/realtime/v1/*` is a 404: the tenant API, metrics and dashboard are never public. The same routes exist on
  the internal gateway (edge functions, Studio).
- Stop (B8): the maintenance response also covers `/storage/v1` and `/realtime/v1` (503 `APP_STOPPED`); open
  websockets are closed (`POST /api/tenants/<slug>/reload`); the sessions of the two new roles are terminated with the
  others, and the database is read-only. Start registers both tenants again.
- Delete: the final backup adds `storage.tar.gz` (the app's files; their metadata is in `database.dump`). The Realtime
  tenant is deleted before the database (its slot teardown connects to it), then the Storage tenant and its files.
- DDL event trigger: the sessions of `app_<id>_storage_admin`, `app_<id>_realtime` and the migrator are not recorded
  as schema changes outside releases.
- `get_app`: unchanged. supabase-js uses the same URL and anon key.
- Studio: the Storage browser works. Its routes already called the app through the internal gateway (M0ter, patch 6).
- `app_metrics`: there is no per-app container to sample; the memory of the shared services is not attributed to apps,
  as for the edge runtime (TECH_DEBT SR-5).

## Tests

`apps/control-plane/test/storage-realtime.e2e.test.ts`, on two disposable apps A and B:

1. provisioning registers both tenants; `storage.objects` belongs to the app's storage role; Realtime's migrations ran;
2. A: a migration creates `public.notes` (RLS, added to `supabase_realtime`), the private bucket `files` and the
   storage policies (one folder per user). B: an edge function creates its bucket and a file with the service role,
   through the internal gateway;
3. alice (A) uploads, lists and downloads her file; bob (A) can neither read it nor write into her folder; anon can't;
4. cross-app: each app's service key (used from its edge function) is refused by the other app's Storage; B's user
   token is refused by A; a forged `X-Forwarded-Host` does not select the tenant; the management APIs are not routed;
5. Realtime: alice receives her `postgres_changes` insert (not bob's), and bob's broadcast. B's anon key
   (`CHANNEL_ERROR`, websocket refused) and B's user token (`JwtSignatureError`) are refused on A;
6. stop A: upload refused (503 `APP_STOPPED`), the open channel is closed, new websockets get a 503, B is not
   affected. Start A: download and subscription work again;
7. delete A with the final backup: `storage.tar.gz` holds alice's file and the dump has `storage.objects`; both
   tenants, the files and the slot are gone; B still works.

Studio (`e2e:studio`, test 9): a builder creates a bucket and lists its objects in the Storage browser of their app;
the bucket exists in that app's database only; another app's storage routes answer 403.

All suites green: `pnpm -r typecheck`, `test`, `e2e` (53), `e2e:studio` (18), `e2e:deploy-cli` (3), `e2e:admin` (21).

## Limits and follow-ups

- Broadcast from Database works for one app at a time (TECH_DEBT SR-1). Fix upstream (a slot name per tenant: one
  line in `Realtime.Tenants.ReplicationConnection.replication_slot_name/2`), or run a patched image.
- Superuser-only Realtime tenant migrations, `realtime-migrate --all` after a Realtime upgrade (SR-2).
- Realtime keeps 4 connections per tenant used in the last ~12 minutes (PG-5); slots and WAL (PG-6).
- Storage: local file backend, files backed up only by `delete_app`, no quota per app (50 MB per file), no image
  transformation, no S3 protocol, TUS untested (SR-3).
- The admin APIs of both services are reachable from the `plat` network, edge functions included (SR-4, as SEC-1).

## Commands

```bash
cd spikes/m5-storage-realtime
scripts/up.sh                       # 2 tenants (TENANTS="m5a m5b ..." for more); needs the plat stack
node --test scripts/test.ts         # *.localhost must resolve to 127.0.0.1
node scripts/hold.ts 20 m5a m5b     # slots, sessions, memory with one client per tenant
scripts/down.sh
```

## Follow-up (2026-10-03): pooler and patched Realtime

- **Broadcast from Database on every app** (SR-1, paid off): Realtime now runs a patched image
  (`plat/realtime:v2.134.10-platform1`, [`patches/realtime`](../../patches/realtime/README.md)) where the slot is named
  per tenant (`supabase_realtime_messages_replication_slot_<16 hex of sha256(tenant id)>`, opt-in setting
  `SLOT_NAME_PER_TENANT=true`). Each app with recent clients gets its own walsender and temporary slot:
  `max_wal_senders=64`, `max_replication_slots=128`. e2e test 5b sends `realtime.send()` in two app databases at the
  same time and checks that each app receives its own message (it fails with the upstream image: one slot for both).
  The upstream pull request is drafted in `patches/realtime/UPSTREAM_PR.md`.
- **Connections**: Storage's requests now go through the PgBouncer pooler (tenant `databasePoolUrl`, transaction
  mode; its migrations keep the direct `databaseUrl`). Realtime stays direct: the `postgres_changes` poller polls a
  temporary slot bound to its session, the walsender is a replication connection, and a tenant has a single host
  setting for all its connections. Choice and routing of the pooler: [control plane README](../../apps/control-plane/README.md#connection-pooler).
- The superuser used for Realtime's tenant migrations is an accepted trade-off (TECH_DEBT, "Accepted trade-offs").
