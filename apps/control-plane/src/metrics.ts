// Per-app load metrics (M4 phase 2, PLAN_1 §4 `app_metrics`, journeys A3, A6, A9), sampled by the control plane every
// METRICS_INTERVAL_SECONDS into the current hour's row:
// - requests and 5xx responses: Caddy's JSON access log of the public server (router.ensureAccessLog), read
//   incrementally (access-log.ts). Every app host goes through the generic `apps-by-host` route (TT-4), so the counts
//   come from the request's host, not from per-app routes; requests of the edge functions to their own app through the
//   internal server are not counted (not app traffic);
// - database size: pg_database_size;
// - memory: Docker stats of the app's GoTrue and PostgREST containers (the edge runtime is shared: not counted).
// One sample at a time across processes (the in-process timer and the `sample-metrics` CLI): a transaction-level
// advisory lock covers the log cursor and the counters, which are committed together (no double count after a crash).
import { type AccessCounts, countAccessLines, readNewLines } from "./access-log.ts";
import { orchestrator } from "./apps.ts";
import { config } from "./config.ts";
import { many, transaction } from "./db.ts";
import { MAINTENANCE_FIELD } from "./router.ts";
import { getSettings } from "./settings.ts";

/** pg_advisory_xact_lock key of the sampler ("metr" in ASCII). */
const LOCK_KEY = 0x6d657472;
/** Bytes of access log read per sample at most; the rest is read by the next samples. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

export interface SampleResult {
  apps: number;
  log_lines: number;
  requests: number;
  responses_5xx: number;
  /** The rotated file holding unread lines could not be found (log rotated twice between samples): those are lost. */
  log_lost: boolean;
  ms: number;
}

interface AppGauge {
  id: string;
  slug: string;
  status: string;
  db_name: string;
}

/** Runs `fn` on `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Memory of the app's own containers; 0 when stopped, null when Docker gave nothing. */
async function appMemory(app: AppGauge): Promise<number | null> {
  if (app.status === "stopped") return 0;
  const values = await Promise.all(
    ["auth", "rest"].map((service) => orchestrator.memoryUsage(`${config.docker.prefix}-${app.slug}-${service}`)),
  );
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

export async function sampleMetrics(): Promise<SampleResult> {
  const started = Date.now();
  const apps = await many<AppGauge>("select id, slug, status, db_name from apps where status <> 'deleted'");
  const sizes = new Map(
    (await many<{ datname: string; size: string }>(
      "select datname, pg_database_size(datname)::text as size from pg_database where datname = any($1)",
      [apps.map((a) => a.db_name)],
    )).map((r) => [r.datname, Number(r.size)]),
  );
  const memory = await mapLimit(apps, 8, appMemory);
  const { metricsRetentionDays } = await getSettings();

  return transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await tx.query("insert into metrics_state (id) values (1) on conflict (id) do nothing");
    const state = (await tx.query<{ log_inode: string | null; log_offset: string }>(
      "select log_inode, log_offset from metrics_state where id = 1",
    )).rows[0]!;

    // requests and 5xx from the access log since the last sample
    let cursor = { inode: state.log_inode, offset: Number(state.log_offset) };
    let counts: AccessCounts | undefined;
    let lost = false;
    let budget = MAX_LOG_BYTES;
    for (let i = 0; i < 4 && budget > 0; i++) {
      const read = await readNewLines(config.accessLog.path, cursor, budget);
      lost ||= read.lost;
      const progressed = read.cursor.inode !== cursor.inode || read.cursor.offset !== cursor.offset;
      counts = countAccessLines(read.text, config.appsDomain, MAINTENANCE_FIELD, counts);
      budget -= Buffer.byteLength(read.text);
      cursor = read.cursor;
      if (!progressed) break;
    }
    if (lost) console.warn("metrics: a rotated access log was not found, its unread requests are not counted");

    const bySlug = new Map(apps.map((a) => [a.slug, a.id]));
    const ids: string[] = [];
    const hours: string[] = [];
    const requests: number[] = [];
    const errors: number[] = [];
    const lastIds: string[] = [];
    const lastAt: string[] = [];
    let totalRequests = 0;
    let totalErrors = 0;
    for (const [slug, perHour] of counts?.counts ?? []) {
      const id = bySlug.get(slug);
      if (!id) continue; // unknown or deleted app (the host still matched the slug pattern)
      for (const [hour, count] of perHour) {
        ids.push(id);
        hours.push(new Date(hour).toISOString());
        requests.push(count.requests);
        errors.push(count.errors);
        totalRequests += count.requests;
        totalErrors += count.errors;
      }
      lastIds.push(id);
      lastAt.push(new Date(counts!.last.get(slug)!).toISOString());
    }
    if (ids.length) {
      await tx.query(
        `insert into app_metrics (app_id, hour, requests, responses_5xx)
           select * from unnest($1::uuid[], $2::timestamptz[], $3::bigint[], $4::bigint[])
         on conflict (app_id, hour) do update set requests = app_metrics.requests + excluded.requests,
           responses_5xx = app_metrics.responses_5xx + excluded.responses_5xx`,
        [ids, hours, requests, errors],
      );
      await tx.query(
        `update apps a set last_request_at = greatest(a.last_request_at, v.at)
           from unnest($1::uuid[], $2::timestamptz[]) v(id, at) where a.id = v.id`,
        [lastIds, lastAt],
      );
    }

    // gauges: the latest value of the hour
    if (apps.length) {
      await tx.query(
        `insert into app_metrics (app_id, hour, db_size_bytes, memory_bytes)
           select id, date_trunc('hour', now()), size, mem from unnest($1::uuid[], $2::bigint[], $3::bigint[]) v(id, size, mem)
         on conflict (app_id, hour) do update set
           db_size_bytes = coalesce(excluded.db_size_bytes, app_metrics.db_size_bytes),
           memory_bytes = coalesce(excluded.memory_bytes, app_metrics.memory_bytes)`,
        [apps.map((a) => a.id), apps.map((a) => sizes.get(a.db_name) ?? null), memory],
      );
    }

    await tx.query(
      "update metrics_state set log_inode = $1, log_offset = $2, sampled_at = now() where id = 1",
      [cursor.inode, cursor.offset],
    );
    await tx.query("delete from app_metrics where hour < now() - make_interval(days => $1)", [metricsRetentionDays]);
    return {
      apps: apps.length,
      log_lines: counts?.lines ?? 0,
      requests: totalRequests,
      responses_5xx: totalErrors,
      log_lost: lost,
      ms: Date.now() - started,
    };
  });
}

/** Samples every METRICS_INTERVAL_SECONDS in the background (first sample shortly after startup). */
export function startMetricsSampler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sampleMetrics();
    } catch (error) {
      console.error("metrics sample failed", error);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 10_000).unref();
  setInterval(tick, config.metricsIntervalSeconds * 1000).unref();
}
