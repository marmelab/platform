// Schema changes outside releases (ARCHITECTURE §7). The DDL event trigger of each app database (packages/sql/
// schema_changes.sql) records every DDL command except the platform's and GoTrue's in `_platform.schema_changes`,
// with its transaction id. applyMigrations stores the txid of each committed migrations batch in the deployment's
// manifest: a recorded change whose txid is not one of those was made outside a release (Studio, execute_sql with
// write, a function using SUPABASE_DB_URL...).
import { appRoles } from "@platform/sql";
import type pg from "pg";
import { type AppRow, dbId } from "./apps.ts";
import { many, one, withAdmin } from "./db.ts";

export interface SchemaDrift {
  /** DDL commands recorded outside a release since `since` (one statement can record several, e.g. a table and its sequence). */
  count: number;
  last_at: string | null;
  /** Start of the last succeeded release (null: since the app was created). */
  since: string | null;
}

export interface SchemaChange {
  at: string;
  command_tag: string;
  object_type: string | null;
  object_identity: string | null;
  role: string;
  /** Client of the session: `platform-execute-sql`, `platform-migrations`, `postgres-meta` (Studio)... */
  application_name: string | null;
  /** Made by a migrations batch of a release (always false unless `all`). */
  in_release: boolean;
  release_id: string | null;
}

/** txid of each committed migrations batch of the app, with its release. */
async function releaseTxids(app: AppRow) {
  const rows = await many<{ txid: string; release_id: string | null }>(
    `select manifest->>'txid' as txid, release_id from deployments
      where app_id = $1 and kind = 'migrations' and manifest ? 'txid'`,
    [app.id],
  );
  return new Map(rows.map((r) => [r.txid, r.release_id]));
}

async function lastSucceededRelease(app: AppRow) {
  const row = await one<{ started_at: Date }>(
    "select started_at from releases where app_id = $1 and status = 'succeeded' order by started_at desc limit 1",
    [app.id],
  );
  return row?.started_at ?? null;
}

const withAppDb = <T>(app: AppRow, fn: (client: pg.Client) => Promise<T>) =>
  withAdmin(appRoles(dbId(app.slug)).database, fn);

/** Count of the changes outside releases since the last succeeded release (get_app). */
export async function schemaDrift(app: AppRow): Promise<SchemaDrift> {
  const [txids, since] = await Promise.all([releaseTxids(app), lastSucceededRelease(app)]);
  const row = await withAppDb(app, async (c) =>
    (await c.query<{ count: number; last_at: Date | null }>(
      `select count(*)::int as count, max(at) as last_at from _platform.schema_changes
        where ($1::timestamptz is null or at >= $1) and txid::text <> all($2::text[])`,
      [since, [...txids.keys()]],
    )).rows[0]!);
  return { count: row.count, last_at: row.last_at?.toISOString() ?? null, since: since?.toISOString() ?? null };
}

/** Recorded schema changes, newest first: outside releases since the last succeeded release, or all of them. */
export async function listSchemaChanges(app: AppRow, options: { all: boolean; limit: number }) {
  const [txids, since] = await Promise.all([releaseTxids(app), lastSucceededRelease(app)]);
  const rows = await withAppDb(app, async (c) =>
    (await c.query<Omit<SchemaChange, "at" | "in_release" | "release_id"> & { at: Date; txid: string }>(
      `select at, txid::text as txid, command_tag, object_type, object_identity, role::text as role, application_name
         from _platform.schema_changes
        where $1 or (($2::timestamptz is null or at >= $2) and txid::text <> all($3::text[]))
        order by id desc limit $4`,
      [options.all, since, [...txids.keys()], options.limit],
    )).rows);
  const changes: SchemaChange[] = rows.map(({ txid, at, ...change }) => ({
    at: at.toISOString(),
    ...change,
    in_release: txids.has(txid),
    release_id: txids.get(txid) ?? null,
  }));
  return {
    scope: options.all ? "all recorded changes" : "outside releases, since the last succeeded release",
    since: options.all ? null : since?.toISOString() ?? null,
    changes,
  };
}
