// Dashboard (journey A3): apps by status, accounts, flags, recent failures, host and cluster resources.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../providers";
import { count, type Day, Sparkline } from "./charts";
import { bytes, dateTime, StatusBadge } from "./fields";
import type { BackupStatus } from "./backups";

interface Stats {
  version: {
    version: string;
    since: string | null;
    components: Record<string, string>;
    previous: { version: string; started_at: string } | null;
  };
  lints: {
    apps_with_errors: { app: string; errors: number; ran_at: string | null }[];
    apps_with_warnings: number;
    apps_linted: number;
    failed_runs: string[];
  };
  apps: { total: number; by_status: Record<string, number> };
  users: { total: number; admins: number; developers: number; disabled: number };
  tokens: { active: number };
  flagged: { outside_ci: number; accepted_lints: number; abandoned: number };
  load: { requests_24h: number; errors_24h: number; memory: number; traffic_7d: Day[]; sampled_at: string | null };
  recent_failures: { at: string; app: string; kind: string; message: string | null }[];
  backups: BackupStatus;
  database: { cluster_bytes: number; app_databases_bytes: number };
  host: {
    memory_total: number;
    memory_free: number;
    cpus: number;
    load: number[];
    uptime_seconds: number;
    disk: { total: number; free: number } | null;
  };
}

const Stat = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card>
    <CardHeader>
      <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
    </CardHeader>
    <CardContent className="text-sm">{children}</CardContent>
  </Card>
);

const Big = ({ children }: { children: React.ReactNode }) => <div className="text-2xl font-semibold">{children}</div>;

/** Share of the volumes disk in use above which backups, restores and deployments may run out of space. */
const DISK_ALERT_RATIO = 0.9;

const DiskUsage = ({ total, free }: { total: number; free: number }) => {
  const used = total - free;
  const ratio = total ? used / total : 0;
  const alert = ratio >= DISK_ALERT_RATIO;
  return (
    <div data-testid="dashboard-disk" className={alert ? "text-destructive" : undefined}>
      <Big>
        {bytes(used)} / {bytes(total)}
      </Big>
      <div className={alert ? undefined : "text-muted-foreground"}>
        {Math.round(ratio * 100)}% used · {bytes(free)} free
      </div>
      {alert && <div className="font-medium">Low disk space: backups, restores and deployments may fail.</div>}
    </div>
  );
};

export const Dashboard = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Stats>("/dashboard").then(setStats, (e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="p-4 text-destructive">{error}</p>;
  if (!stats) return <p className="p-4">Loading…</p>;
  const { host } = stats;
  return (
    <div className="flex flex-col gap-4 p-1">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat title="Apps">
          <Big>{stats.apps.total}</Big>
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(stats.apps.by_status).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1">
                <StatusBadge status={status} /> {count}
              </span>
            ))}
          </div>
        </Stat>
        <Stat title="Flagged apps">
          <div>
            <Link className="underline" to={`/apps?filter=${encodeURIComponent(JSON.stringify({ outside_ci: true }))}`}>
              {stats.flagged.outside_ci} deployed outside CI
            </Link>
          </div>
          <div>
            <Link className="underline" to={`/apps?filter=${encodeURIComponent(JSON.stringify({ accepted_lints: true }))}`}>
              {stats.flagged.accepted_lints} with accepted lints
            </Link>
          </div>
          <div>
            <Link className="underline" to={`/apps?filter=${encodeURIComponent(JSON.stringify({ abandoned: true }))}`}>
              {stats.flagged.abandoned} abandoned
            </Link>
          </div>
        </Stat>
        <Stat title="Security linter">
          <div data-testid="dashboard-lints">
            <Link
              className={stats.lints.apps_with_errors.length ? "text-destructive underline" : "underline"}
              to={`/apps?filter=${encodeURIComponent(JSON.stringify({ lint_errors: true }))}`}
            >
              {stats.lints.apps_with_errors.length} app{stats.lints.apps_with_errors.length === 1 ? "" : "s"} with ERROR lints
            </Link>
          </div>
          {stats.lints.apps_with_errors.slice(0, 5).map((a) => (
            <div key={a.app} className="text-destructive">
              <Link className="underline" to={`/apps/${a.app}/show`}>{a.app}</Link>: {a.errors}
            </div>
          ))}
          <div className="text-muted-foreground">
            {stats.lints.apps_with_warnings} with warnings · {stats.lints.apps_linted} apps linted
            {stats.lints.failed_runs.length ? ` · last run failed for ${stats.lints.failed_runs.join(", ")}` : ""}
          </div>
        </Stat>
        <Stat title="Requests, 24 h (all apps)">
          <div className="flex items-end justify-between gap-2">
            <Big>{count(stats.load.requests_24h)}</Big>
            <Sparkline days={stats.load.traffic_7d} label="All apps, requests per day" />
          </div>
          <div className="text-muted-foreground">
            {count(stats.load.errors_24h)} 5xx responses
            {stats.load.requests_24h ? ` (${((stats.load.errors_24h / stats.load.requests_24h) * 100).toFixed(1)}%)` : ""} ·
            last 7 days on the right
          </div>
        </Stat>
        <Stat title="App containers memory">
          <Big>{bytes(stats.load.memory)}</Big>
          <div className="text-muted-foreground">
            GoTrue and PostgREST of every app (the shared edge runtime is not included)
            {stats.load.sampled_at ? ` · sampled ${dateTime(stats.load.sampled_at)}` : ""}
          </div>
        </Stat>
        <Stat title="Accounts">
          <Big>{stats.users.total}</Big>
          <div className="text-muted-foreground">
            {stats.users.admins} admins, {stats.users.developers} builders, {stats.users.disabled} disabled ·{" "}
            {stats.tokens.active} active tokens
          </div>
        </Stat>
        <Stat title="Postgres cluster">
          <Big>{bytes(stats.database.cluster_bytes)}</Big>
          <div className="text-muted-foreground">{bytes(stats.database.app_databases_bytes)} in app databases</div>
        </Stat>
        <Stat title="Host memory">
          <Big>
            {bytes(host.memory_total - host.memory_free)} / {bytes(host.memory_total)}
          </Big>
          <div className="text-muted-foreground">
            {host.cpus} CPUs, load {host.load.map((l) => l.toFixed(2)).join(" ")}
          </div>
        </Stat>
        <Stat title="Backups">
          <div data-testid="dashboard-backups">
            <Link className={stats.backups.failed_7d ? "text-destructive underline" : "underline"} to={`/backups?filter=${encodeURIComponent(JSON.stringify({ status: "failed" }))}`}>
              {stats.backups.failed_7d} failed in 7 days
            </Link>
          </div>
          {stats.backups.stale_apps.length > 0 && (
            <div className="text-destructive">
              {stats.backups.stale_apps.length} app{stats.backups.stale_apps.length > 1 ? "s" : ""} without a backup for 36 h
            </div>
          )}
          <div className="text-muted-foreground">
            {stats.backups.enabled ? `daily at ${String(stats.backups.hour_utc).padStart(2, "0")}:00 UTC` : "scheduled backups off"} ·{" "}
            {stats.backups.target === "s3" ? "S3" : "local volume only"}
            {stats.backups.last_run?.run_started_at ? ` · last run ${dateTime(stats.backups.last_run.run_started_at)}` : ""}
          </div>
        </Stat>
        <Stat title="Platform version">
          <div data-testid="dashboard-version">
            <Big>{stats.version.version}</Big>
          </div>
          <div className="text-muted-foreground">
            {stats.version.since ? `since ${dateTime(stats.version.since)}` : ""}
            {stats.version.previous ? ` · previously ${stats.version.previous.version}` : ""}
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-muted-foreground">Components</summary>
            <ul className="mt-1 font-mono text-xs">
              {Object.entries(stats.version.components).map(([service, image]) => (
                <li key={service}>
                  {service}: {image}
                </li>
              ))}
            </ul>
          </details>
        </Stat>
        <Stat title="Volumes disk">
          {host.disk ? <DiskUsage {...host.disk} /> : "—"}
        </Stat>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Failures in the last 7 days</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.recent_failures.length ? (
            <ul className="flex flex-col gap-1 text-sm">
              {stats.recent_failures.map((f, i) => (
                <li key={i}>
                  {dateTime(f.at)} · <Link className="underline" to={`/apps/${f.app}/show`}>{f.app}</Link> · {f.kind}
                  {f.message ? <span className="text-muted-foreground"> · {f.message}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
