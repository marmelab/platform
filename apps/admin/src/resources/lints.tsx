// Security linter results (PLAN_1 §8): the latest run of an app (rules of packages/sql/lints.sql, from Supabase's
// splinter), the counts of the previous runs, and "Run linter".
import { useCallback, useEffect, useState } from "react";
import { useNotify } from "ra-core";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "../providers";
import { dateTime } from "./fields";

export interface Lint {
  name: string;
  level: "ERROR" | "WARN" | "INFO";
  object: string;
  detail: string;
  accepted: boolean;
}

interface LintRun {
  id: string;
  release_id: string | null;
  source: "migrations" | "manual" | "scheduled" | "upgrade";
  ran_at: string;
  errors: number;
  warnings: number;
  infos: number;
  unaccepted_errors: number;
  error: string | null;
}

interface LintsResponse {
  app: string;
  latest: (LintRun & { lints: Lint[] }) | null;
  history?: LintRun[];
}

const SPLINTER_DOCS: Record<string, string> = {
  unindexed_foreign_keys: "0001", auth_users_exposed: "0002", no_primary_key: "0004", policy_exists_rls_disabled: "0007",
  rls_enabled_no_policy: "0008", security_definer_view: "0010", function_search_path_mutable: "0011",
  rls_disabled_in_public: "0013", extension_in_public: "0014", rls_references_user_metadata: "0015",
  materialized_view_in_api: "0016", foreign_table_in_api: "0017", rls_policy_always_true: "0024",
  public_bucket_allows_listing: "0025", anon_security_definer_function_executable: "0028",
  authenticated_security_definer_function_executable: "0029",
};

const docsUrl = (name: string) =>
  SPLINTER_DOCS[name] ? `https://supabase.com/docs/guides/database/database-linter?lint=${SPLINTER_DOCS[name]}_${name}` : null;

const LevelBadge = ({ level }: { level: Lint["level"] }) => (
  <Badge variant={level === "ERROR" ? "destructive" : level === "WARN" ? "secondary" : "outline"}>{level}</Badge>
);

export function AppLints({ slug }: { slug: string }) {
  const [data, setData] = useState<LintsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const notify = useNotify();
  const load = useCallback(() => {
    api<LintsResponse>(`/apps/${slug}/lints`).then(setData, (e: Error) => setError(e.message));
  }, [slug]);
  useEffect(load, [load]);
  const run = async () => {
    setRunning(true);
    try {
      await api(`/apps/${slug}/lint`, { body: {} });
      notify("Linter run", { type: "success" });
      load();
    } catch (e) {
      notify((e as Error).message, { type: "error" });
    } finally {
      setRunning(false);
    }
  };
  const latest = data?.latest ?? null;
  return (
    <div className="flex flex-col gap-3" data-testid="app-lints">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={run} disabled={running}>
          <ShieldCheck /> {running ? "Running…" : "Run linter"}
        </Button>
        <span className="text-sm text-muted-foreground">
          Rules from Supabase's splinter, run after every migrations batch and every few hours (changes made outside CI).
        </span>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {data && !latest && <p className="text-sm text-muted-foreground">Never linted yet.</p>}
      {latest && (
        <>
          <p className="text-sm">
            Last run {dateTime(latest.ran_at)} ({latest.source}): {latest.errors} errors
            {latest.errors !== latest.unaccepted_errors ? ` (${latest.errors - latest.unaccepted_errors} accepted)` : ""},{" "}
            {latest.warnings} warnings, {latest.infos} infos
            {latest.error && <span className="text-destructive"> · failed: {latest.error}</span>}
          </p>
          {latest.lints.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2">Level</th>
                  <th className="py-1 pr-2">Rule</th>
                  <th className="py-1 pr-2">Object</th>
                  <th className="py-1">Detail</th>
                </tr>
              </thead>
              <tbody>
                {latest.lints.map((l) => {
                  const url = docsUrl(l.name);
                  return (
                    <tr key={`${l.name}:${l.object}`} className="border-t align-top" data-testid="lint-row">
                      <td className="py-1 pr-2">
                        <LevelBadge level={l.level} /> {l.accepted && <Badge variant="outline" title="Accepted by a migration (acceptedLints)">accepted</Badge>}
                      </td>
                      <td className="py-1 pr-2 font-mono text-xs">
                        {url ? <a className="underline" href={url} target="_blank" rel="noreferrer">{l.name}</a> : l.name}
                      </td>
                      <td className="py-1 pr-2 font-mono text-xs">{l.object}</td>
                      <td className="py-1">{l.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">No lint.</p>
          )}
        </>
      )}
      {data?.history && data.history.length > 1 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Previous runs</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {data.history.slice(1).map((r) => (
              <li key={r.id}>
                {dateTime(r.ran_at)} · {r.source} · {r.errors} errors, {r.warnings} warnings, {r.infos} infos
                {r.error ? ` · failed: ${r.error}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
