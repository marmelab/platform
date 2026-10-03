# Draft: upstream pull request for supabase/realtime

Not opened yet. Target: `supabase/realtime`, `main` (the patch is against `v2.134.10`; rebase before opening).

---

**Title**: Broadcast Changes: optional replication slot name per tenant (`SLOT_NAME_PER_TENANT`)

## Problem

`Realtime.Tenants.ReplicationConnection` names the replication slot of Broadcast Changes (Broadcast from Database:
`realtime.send()`, `realtime.broadcast_changes()`) after the schema and table only, plus the instance-wide
`SLOT_NAME_SUFFIX`:

```elixir
def replication_slot_name(schema, table) do
  "supabase_#{schema}_#{table}_replication_slot_#{slot_suffix()}"
end
```

Replication slot names are unique per Postgres cluster, not per database. When one Realtime instance serves several
tenants whose databases live in the same cluster (self-hosted multi-tenant setups: one database per project on a
shared Postgres), every tenant computes the same name. The first tenant creates the slot; the others find it in
`pg_replication_slots`, log `Replication slot already exists and in use, deferring connection`
(`replication_slot_in_use`) and retry, so Broadcast from Database only works for one tenant at a time, and the
others' tenant connection is eventually restarted by `Connect` after the replication recovery window.

`postgres_changes` is not affected: its slot name comes from the tenant's `slot_name` extension setting.

## Change

- New setting `SLOT_NAME_PER_TENANT` (boolean, default `false`, read in `config/runtime.exs` as `:slot_name_per_tenant`).
- `replication_slot_name/3` takes the tenant id; when the setting is on, the name ends with the first 16 hex characters
  of the SHA-256 of the tenant id: `supabase_realtime_messages_replication_slot_<SLOT_NAME_SUFFIX><hash>`. A hash keeps
  the name within Postgres' 63-byte limit and within `[a-z0-9_]` whatever the tenant id. 60 bytes without suffix.
- `init/1` and `handle_connect/1` pass the state's `tenant_id`.

Default off: existing deployments keep their slot names (the slot is temporary, so a change would be harmless, but
it keeps the behaviour of single-tenant clusters untouched and the change opt-in).

## Tests to add

- `replication_slot_name/3` with the setting off: unchanged name; on: two tenant ids give two different names, each
  at most 63 bytes, matching `^[a-z0-9_]+$`.
- `ReplicationConnection` with two tenants on the same test database and the setting on: both start streaming
  (`assert_replication_started` for each slot) and each receives its own `realtime.send()` message.

## How it was tested

Patched image (`v2.134.10` with this change) in a self-hosted setup with one Realtime instance and two tenants whose
databases share one Postgres 17 cluster: both tenants get an active temporary slot
(`supabase_realtime_messages_replication_slot_<hash>`) and receive their own Broadcast from Database messages at the
same time; with the upstream image, the second tenant never gets a slot.
