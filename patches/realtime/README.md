# Patched Realtime image

The platform runs one shared multi-tenant Realtime ([docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §3.2) built from the upstream
image `supabase/realtime:v2.134.10` (the version pinned by Supabase's self-hosting `docker-compose.yml`) plus the
patches of this directory. Image tag: `plat/realtime:v<upstream version>-platform<revision>`, used by
`deploy/docker-compose.yml` and built by `deploy/install.sh` when missing (`REALTIME_BUILD=1` forces a rebuild).

| Patch | Why | Upstream |
|---|---|---|
| `0001-broadcast-changes-slot-per-tenant.patch` | *Broadcast from Database* (`realtime.send()`, `realtime.broadcast_changes()`) streams `realtime.messages` through a replication slot named per Realtime instance (`supabase_realtime_messages_replication_slot_` + `SLOT_NAME_SUFFIX`). Slots are cluster-wide: with several tenants on one cluster, only the first gets it (TECH_DEBT SR-1, paid off). With `SLOT_NAME_PER_TENANT=true` the name ends with 16 hex characters of the SHA-256 of the tenant id. Off by default: the slot names of existing deployments do not change. | To propose: [`UPSTREAM_PR.md`](UPSTREAM_PR.md) (not opened yet) |

The slot is `TEMPORARY`: it goes away with its walsender (tenant stopped by Realtime ~12 minutes after its last client,
or app deleted). Postgres limits: one walsender and one slot per app with recent clients, plus one temporary slot per
app with `postgres_changes` subscribers (`max_wal_senders=64`, `max_replication_slots=128`, TECH_DEBT PG-6).

## How the image is built

`build.sh` does not rebuild Realtime from source (an Elixir release, Node and Bun toolchains, ~15 minutes): it

1. downloads the upstream files the patches touch, at the pinned tag (`raw.githubusercontent.com`), and checks them
   against `upstream.sha256`;
2. applies `*.patch` (`git apply`);
3. builds `Dockerfile`: in a stage of the upstream image, the release's own Erlang/Elixir recompiles the patched
   `lib/**/*.ex` modules against the release's compiled dependencies (same compiler, same versions, so the `.beam`
   files are drop-in); the final image is the upstream one with those `.beam` files and the patched `runtime.exs`
   copied over.

The upstream image comes from Docker Hub (`REALTIME_UPSTREAM_IMAGE=mirror.gcr.io/supabase/realtime:v<version>` to use a
mirror, DEP-4).

## Upgrading Realtime (re-applying the patch)

1. Check whether the fix landed upstream (search the Realtime changelog for `SLOT_NAME_PER_TENANT` or a per-tenant
   broadcast changes slot). If so, drop the patch, use the upstream image with its setting, and delete this directory.
2. Otherwise, in a clone of `supabase/realtime` at the new tag: `git apply` the patch (or redo its few lines by hand
   if it does not apply), then regenerate it with `git diff > 0001-broadcast-changes-slot-per-tenant.patch`. Only
   `config/runtime.exs` and `lib/` may change: the image build recompiles `lib/**/*.ex` files only.
3. Update `upstream.sha256` with the new upstream files (`sha256sum lib/realtime/tenants/replication_connection.ex
   config/runtime.exs` on the clean tag), `REALTIME_VERSION` in `build.sh` (reset `PATCH_REVISION` to 1) and the
   `ARG` defaults of `Dockerfile`, and the image tag in `deploy/docker-compose.yml`.
4. A new tag means new tenant migrations may exist: after the upgrade, run `realtime-migrate --all` (TECH_DEBT SR-2).
5. Run `pnpm --filter @platform/control-plane e2e:storage-realtime`: test 5b fails with an unpatched image (one slot
   for both apps).

Bump `PATCH_REVISION` in `build.sh` (and the tag in `deploy/docker-compose.yml`) whenever a patch changes.
