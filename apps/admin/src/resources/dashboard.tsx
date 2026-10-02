// Dashboard (journey A3): apps by status, accounts, flags, recent failures, host and cluster resources.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../providers";
import { bytes, dateTime, StatusBadge } from "./fields";

interface Stats {
  apps: { total: number; by_status: Record<string, number> };
  users: { total: number; admins: number; developers: number; disabled: number };
  tokens: { active: number };
  flagged: { outside_ci: number; accepted_lints: number };
  recent_failures: { at: string; app: string; kind: string; message: string | null }[];
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
        <Stat title="Volumes disk">
          {host.disk ? (
            <Big>
              {bytes(host.disk.total - host.disk.free)} / {bytes(host.disk.total)}
            </Big>
          ) : (
            "—"
          )}
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
