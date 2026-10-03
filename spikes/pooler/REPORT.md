# Spike: connection pooler (PG-2 / PG-5)

Goal: fit 50 apps within the cluster's connection budget (`max_connections=500`). Implementation details: [apps/control-plane/README.md](../../apps/control-plane/README.md#connection-pooler). Plan: [PLAN_1.md](../../PLAN_1.md) §3.1.

## Choice: PgBouncer 1.25 rather than Supavisor

| | PgBouncer | Supavisor |
|---|---|---|
| Footprint | one process, ~3 MB | ~200 MB, its own metadata database |
| Tenant setup | per-database entries + `auth_query` | tenant API, `role.tenant` usernames |
| Fit with per-app roles | `auth_query` returns only `app_*_authenticator` and `app_*_storage_admin` | needs username rewriting in every client |

PgBouncer is the simplest robust option for our setup. The e2e suite checks that owner, Realtime and superuser roles are refused by the pooler.

## What goes through the pooler

- **Pooled (transaction mode)**: PostgREST (prepared statements off) and Storage requests (`databasePoolUrl`).
- **Direct**: GoTrue (no idle connections, no gain), Realtime (temporary replication slots and walsenders need a session, one host per tenant), the owner role.
- **Schema reload relay**: PostgREST's `LISTEN` cannot work in transaction mode, so the control plane holds one connection per running app and signals PostgREST on each `pgrst` notification.
- Stop/start: `default_transaction_read_only` applies through the pooler; pooled sessions are terminated on stop and on start.
- Bug found: re-provisioning re-salted role passwords and broke pooled clients after start. Role secrets now use a fixed salt.

## Measurements (20 apps, `scripts/scale.ts`)

| Phase | Before | After |
|---|---|---|
| 75 s after load (cluster total) | 125 | 130 |
| of which PostgREST + Storage | 34 | 0 |
| of which relay | 0 | 20 |
| of which Realtime | 80 + 1 walsender | 80 + 20 walsenders |
| Peak with Realtime clients connected | 195 | 212 |

The extra walsenders come from the Realtime patch (Broadcast from Database now works for every app, SR-1).

Extrapolated to 50 apps: PostgREST at rest goes from 85–200 connections to 0 (plus 50 relay connections). The simultaneous peak stays around **500**, right at `max_connections`; the remaining consumer is Realtime (~250, PG-5).

## Decision and follow-ups

- Keep PgBouncer.
- To get below the ceiling: raise `max_connections` (e.g. 800), or extend the Realtime patch so its non-replication connections use the pooler (about 3 fewer per active app). Open question for the product owner.
- `edoburu/pgbouncer` is a community image (PG-8).
- Under a 20-app simultaneous burst, 2 of 20 Storage bucket creations time out (Storage's 3 s connect timeout), versus 3 of 20 without the pooler.
