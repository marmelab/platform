// Platform settings, read-only (GET /api/settings): the values in effect, secrets left out, and those set with the CLI
// over the environment. They are changed with `set-setting` (audited), the SSO ones on the SSO screen.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../providers";
import { dateTime } from "./fields";

interface SettingsRecord {
  effective: Record<string, unknown>;
  overrides: { key: string; value: string; env: string | null; updated_at: string }[];
}

/** `{ backup: { hour_utc: 2 } }` as `backup.hour_utc: 2`. */
function flatten(value: unknown, prefix = ""): [string, string][] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
  }
  const text = Array.isArray(value) ? (value.length ? value.join(", ") : "—") : value === null ? "—" : String(value);
  return [[prefix, text]];
}

export const SettingsPage = () => {
  const [record, setRecord] = useState<SettingsRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<SettingsRecord>("/settings").then(setRecord, (e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="p-4 text-destructive">{error}</p>;
  if (!record) return <p className="p-4">Loading…</p>;
  return (
    <div className="flex max-w-4xl flex-col gap-4 py-4">
      <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
      <p className="text-sm text-muted-foreground">
        Read-only. Change a setting with the control plane CLI (audited):{" "}
        <code>node src/cli.ts set-setting &lt;key&gt; &lt;value&gt;</code>, and go back to the environment's value with{" "}
        <code>unset-setting &lt;key&gt;</code>. Company SSO is set on the{" "}
        <Link className="underline" to="/sso">
          SSO screen
        </Link>
        .
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Changed from the environment</CardTitle>
        </CardHeader>
        <CardContent>
          {record.overrides.length ? (
            <table className="w-full text-sm" data-testid="settings-overrides">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Setting</th>
                  <th className="py-1 font-medium">Value</th>
                  <th className="py-1 font-medium">Replaces</th>
                  <th className="py-1 font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {record.overrides.map((o) => (
                  <tr key={o.key} className="border-t">
                    <td className="py-1 font-mono">{o.key}</td>
                    <td className="py-1 font-mono break-all">{o.value}</td>
                    <td className="py-1 font-mono text-muted-foreground">{o.env ?? "—"}</td>
                    <td className="py-1 text-muted-foreground">{dateTime(o.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-muted-foreground">None: every setting comes from the environment or its default.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>In effect</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm" data-testid="settings-effective">
            {flatten(record.effective).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="font-mono text-muted-foreground">{key}</dt>
                <dd className="font-mono break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
};
