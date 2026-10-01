import { appRoles, lintsSql } from "@platform/sql";
import type { LintResult, Migration } from "@platform/shared";
import type pg from "pg";
import { type AppRow, appSecrets, dbId, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { platform, withClient } from "./db.ts";

const MAX_ROWS = 200;

/** Connects to the app database as app_<id>_owner (never as postgres / supabase_admin). */
function withOwner<T>(app: AppRow, fn: (client: pg.Client) => Promise<T>) {
  const roles = appRoles(dbId(app.slug));
  return withClient({ database: roles.database, user: roles.owner, password: appSecrets(app).passwords.owner }, fn);
}

export async function lint(app: AppRow): Promise<LintResult[]> {
  return withOwner(app, async (c) => (await c.query<LintResult>(lintsSql())).rows);
}

function pgError(error: unknown) {
  const e = error as { message?: string; code?: string; position?: string; hint?: string };
  return [e.message, e.code && `(SQLSTATE ${e.code})`, e.hint && `hint: ${e.hint}`].filter(Boolean).join(" ");
}

export async function applyMigrations(user: User, app: AppRow, migrations: Migration[]) {
  const sorted = [...migrations].sort((a, b) => a.version.localeCompare(b.version, "en", { numeric: true }));
  const versions = new Set<string>();
  for (const m of sorted) {
    if (versions.has(m.version)) throw new UserError(`duplicate migration version ${m.version}`);
    versions.add(m.version);
  }

  const result = await withOwner(app, async (c) => {
    await c.query("begin");
    try {
      await c.query("select pg_advisory_xact_lock(hashtext('supabase_migrations'))");
      const { rows } = await c.query<{ version: string }>("select version from supabase_migrations.schema_migrations");
      const existing = new Set(rows.map((r) => r.version));
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const m of sorted) {
        if (existing.has(m.version)) {
          skipped.push(m.version);
          continue;
        }
        try {
          await c.query(m.sql);
        } catch (error) {
          throw new UserError(`migration ${m.version}${m.name ? `_${m.name}` : ""} failed: ${pgError(error)}`);
        }
        await c.query(
          "insert into supabase_migrations.schema_migrations (version, name, statements, created_by) values ($1, $2, $3, $4)",
          [m.version, m.name ?? null, [m.sql], user.email],
        );
        applied.push(m.version);
      }
      await c.query("commit");
      if (applied.length) await c.query("notify pgrst, 'reload schema'");
      return { applied, skipped };
    } catch (error) {
      await c.query("rollback");
      throw error;
    }
  });

  if (result.applied.length) {
    const next = await platform.query<{ v: number }>(
      "select coalesce(max(version), 0) + 1 as v from deployments where app_id = $1 and kind = 'migrations'",
      [app.id],
    );
    await platform.query(
      `insert into deployments (app_id, kind, version, status, created_by, finalized_at, manifest)
       values ($1, 'migrations', $2, 'live', $3, now(), $4)`,
      [app.id, next.rows[0].v, user.id, JSON.stringify({ applied: result.applied })],
    );
  }
  await audit(user.id, app.id, "apply_migrations", result);
  return { ...result, lints: await lint(app) };
}

export async function executeSql(user: User, app: AppRow, sql: string, write: boolean) {
  const started = Date.now();
  const output = await withOwner(app, async (c) => {
    await c.query(write ? "begin" : "begin read only");
    try {
      await c.query("set local statement_timeout = '15s'");
      // Read-only: a named (extended protocol) query refuses multi-statement strings, so the user
      // SQL cannot COMMIT the read-only transaction and continue with writes.
      const raw = write ? await c.query(sql) : await c.query({ name: `ro_${Date.now()}`, text: sql });
      await c.query(write ? "commit" : "rollback");
      const results = (Array.isArray(raw) ? raw : [raw]) as pg.QueryResult[];
      const last = results.at(-1)!;
      return {
        command: last.command,
        row_count: last.rowCount,
        fields: last.fields?.map((f) => f.name) ?? [],
        rows: (last.rows ?? []).slice(0, MAX_ROWS),
        truncated: (last.rows?.length ?? 0) > MAX_ROWS,
      };
    } catch (error) {
      await c.query("rollback").catch(() => {});
      throw new UserError(pgError(error));
    }
  });
  if (write) await audit(user.id, app.id, "execute_sql", { sql, ms: Date.now() - started });
  return output;
}
