// Security linter results (M7 part 2, PLAN_1 §7 and §8). The rules are in packages/sql/lints.sql (rewritten from
// Supabase's splinter); this module runs them on an app and records each run in `lint_runs`: after a committed
// migrations batch (with its release, sql.ts), on demand (admin console, CLI `lint-apps`), after a platform upgrade,
// and in a periodic sweep that catches schema changes made outside releases (Studio, execute_sql).
import type { LintResult } from "@platform/shared";
import { lintsSql, storageLintsSql } from "@platform/sql";
import type pg from "pg";
import type { AppRow } from "./apps.ts";
import { many, one, platform } from "./db.ts";

export type LintSource = "migrations" | "manual" | "scheduled" | "upgrade";

/** Runs every rule on an open connection to the app database (owner role), in its current transaction if any. */
export async function lintsOf(c: pg.Client): Promise<LintResult[]> {
  const lints = (await c.query<LintResult>(lintsSql())).rows;
  const { rows: [storage] } = await c.query<{ ok: boolean }>("select to_regclass('storage.buckets') is not null as ok");
  if (storage?.ok) lints.push(...(await c.query<LintResult>(storageLintsSql())).rows);
  return lints;
}

const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2 } as const;
const sortLints = (lints: LintResult[]) =>
  [...lints].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name) ||
    a.object.localeCompare(b.object));

export interface LintRunRow {
  id: string;
  app_id: string;
  release_id: string | null;
  source: LintSource;
  ran_at: Date;
  errors: number;
  warnings: number;
  infos: number;
  lints: LintResult[];
  error: string | null;
}

/** Records a run (results computed by the caller, e.g. inside the migrations transaction). */
export async function recordLintRun(
  appId: string,
  source: LintSource,
  lints: LintResult[],
  { releaseId = null, error = null }: { releaseId?: string | null; error?: string | null } = {},
) {
  const count = (level: LintResult["level"]) => lints.filter((l) => l.level === level).length;
  return (await one<LintRunRow>(
    `insert into lint_runs (app_id, release_id, source, errors, warnings, infos, lints, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [appId, releaseId, source, count("ERROR"), count("WARN"), count("INFO"), JSON.stringify(sortLints(lints)), error],
  ))!;
}

/**
 * Lints the app now and records the run. A failure (database unreachable) is recorded too, then rethrown. The owner
 * connection is opened by sql.ts (`withOwner`), imported lazily to avoid an import cycle.
 */
export async function lintApp(app: AppRow, source: LintSource): Promise<LintRunRow> {
  const { withOwner } = await import("./sql.ts");
  let lints: LintResult[];
  try {
    // explicit read-only transaction: also works on a stopped (read-only) app
    lints = await withOwner(app, async (c) => {
      await c.query("begin read only");
      try {
        return await lintsOf(c);
      } finally {
        await c.query("rollback");
      }
    }, "platform-lint");
  } catch (error) {
    await recordLintRun(app.id, source, [], { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  return recordLintRun(app.id, source, lints);
}

/** ERROR lints accepted by the app's migrations (`accept_lints`, `.platform.json` acceptedLints). */
async function acceptedLints(appId: string) {
  const rows = await many<{ name: string; object: string }>(
    `select distinct acc->>'name' as name, acc->>'object' as object
       from deployments d, jsonb_array_elements(d.manifest->'accepted_lints') acc
      where d.app_id = $1 and d.kind = 'migrations' and jsonb_typeof(d.manifest->'accepted_lints') = 'array'`,
    [appId],
  );
  return new Set(rows.map((r) => `${r.name}\0${r.object}`));
}

/** The app's latest run, each lint marked `accepted` when a migration accepted it; null if never linted. */
export async function latestLints(appId: string) {
  const run = await one<LintRunRow>("select * from lint_runs where app_id = $1 order by ran_at desc limit 1", [appId]);
  if (!run) return null;
  return lintRunView(run, await acceptedLints(appId));
}

export function lintRunView(run: LintRunRow, accepted: Set<string>) {
  const lints = run.lints.map((l) => ({ ...l, accepted: accepted.has(`${l.name}\0${l.object}`) }));
  return {
    id: run.id,
    release_id: run.release_id,
    source: run.source,
    ran_at: run.ran_at,
    errors: run.errors,
    warnings: run.warnings,
    infos: run.infos,
    /** ERROR lints not accepted by a migration: what the admin should look at. */
    unaccepted_errors: lints.filter((l) => l.level === "ERROR" && !l.accepted).length,
    error: run.error,
    lints,
  };
}

export async function lintHistory(appId: string, limit = 20) {
  const accepted = await acceptedLints(appId);
  return (await many<LintRunRow>("select * from lint_runs where app_id = $1 order by ran_at desc limit $2", [appId, limit]))
    .map((run) => lintRunView(run, accepted));
}

/**
 * Lints every running or stopped app (or the given slugs), one at a time. Returns a summary per app; a failed app does
 * not stop the others.
 */
export async function lintApps(source: LintSource, { only, olderThanHours }: { only?: string[]; olderThanHours?: number } = {}) {
  const apps = await many<AppRow>(
    `select a.* from apps a
      where a.status in ('running', 'stopped') and ($1::text[] is null or a.slug = any($1))
        and ($2::int is null or not exists (select 1 from lint_runs r where r.app_id = a.id
          and r.ran_at > now() - make_interval(hours => $2)))
      order by a.slug`,
    [only ?? null, olderThanHours ?? null],
  );
  const results: { app: string; errors?: number; warnings?: number; infos?: number; unaccepted_errors?: number; error?: string }[] = [];
  for (const app of apps) {
    try {
      const run = await lintApp(app, source);
      const view = lintRunView(run, await acceptedLints(app.id));
      results.push({ app: app.slug, errors: run.errors, warnings: run.warnings, infos: run.infos, unaccepted_errors: view.unaccepted_errors });
    } catch (error) {
      results.push({ app: app.slug, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Lint runs retention: runs tied to a release are kept with it; the others are deleted after `days`, except each app's
 * latest run.
 */
export async function pruneLintRuns(days = 30) {
  const { rowCount } = await platform.query(
    `delete from lint_runs r where r.release_id is null and r.ran_at < now() - make_interval(days => $1)
       and r.id <> (select id from lint_runs l where l.app_id = r.app_id order by ran_at desc limit 1)`,
    [days],
  );
  return rowCount ?? 0;
}

/**
 * Periodic sweep (every LINT_SWEEP_INTERVAL_HOURS, 6 by default): lints the apps whose last run is older than that, so
 * that a schema change made outside releases (Studio, execute_sql with write) shows up in the admin console.
 */
export function startLintSweeper(intervalHours: number) {
  if (!(intervalHours > 0)) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await lintApps("scheduled", { olderThanHours: intervalHours });
      await pruneLintRuns();
      if (results.length) console.log(`lint sweep: ${results.length} apps, ${results.filter((r) => r.error).length} failed`);
    } catch (error) {
      console.error("lint sweep failed", error);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, Math.min(intervalHours, 1) * 3600_000).unref();
}
