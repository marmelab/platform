// Backups (M7, journey A4): every app's backups (deleted apps included), the effective settings and the last daily run;
// on the app page, its backups with "Backup now". Restore: typed confirmation, optional pre-restore backup.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { type RaRecord, useNotify, useRecordContext, useRefresh } from "ra-core";
import { DatabaseBackup, RotateCcw } from "lucide-react";
import { DataTable, List, ListPagination, ReferenceManyField, SearchInput, SelectInput, ToggleFilterButton } from "@/components/admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "../providers";
import { ActionButton } from "./actions";
import { bytes, dateTime, StatusBadge } from "./fields";

export interface BackupRecord extends RaRecord {
  id: string;
  app: string;
  app_deleted: boolean;
  kind: "scheduled" | "manual" | "pre_restore" | "final";
  status: "running" | "succeeded" | "failed";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  location: string | null;
  target: "local" | "s3" | null;
  versions: { frontend: number | null; functions: number | null } | null;
  error: string | null;
}

export interface BackupStatus {
  enabled: boolean;
  hour_utc: number;
  keep_daily: number;
  keep_weekly: number;
  manual_retention_days: number;
  final_retention_days: number;
  target: "local" | "s3";
  s3: { endpoint: string; bucket: string; region: string; prefix: string } | null;
  last_run: { scheduled_on: string | null; run_started_at: string | null; run_finished_at: string | null; run_summary: RunSummary | null } | null;
  failed_7d: number;
  stale_apps: { slug: string; last_backup_at: string | null }[];
}

interface RunSummary {
  apps: number;
  succeeded: number;
  failed: { app: string; error: string }[];
  pruned: number;
}

const KINDS = ["scheduled", "manual", "pre_restore", "final"].map((id) => ({ id, name: id.replace("_", "-") }));
const STATUSES = ["succeeded", "failed", "running"].map((id) => ({ id, name: id }));

const duration = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const KindBadge = ({ kind }: { kind: string }) => (
  <Badge variant={kind === "final" ? "destructive" : kind === "scheduled" ? "secondary" : "outline"}>{kind.replace("_", "-")}</Badge>
);

/** Restore with a typed confirmation: same app (replaced, after a pre-restore backup) or a deleted app (recreated). */
export function RestoreButton({ backup }: { backup: BackupRecord }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [safety, setSafety] = useState(true);
  const [loading, setLoading] = useState(false);
  const notify = useNotify();
  const refresh = useRefresh();
  if (backup.status !== "succeeded") return null;
  const run = async () => {
    setLoading(true);
    try {
      const result = await api<{ slug: string; mode: string; ms: number }>(`/backups/${backup.id}/restore`, {
        body: { confirm, safety_backup: safety },
      });
      notify(`${result.slug} restored (${result.mode === "deleted_app" ? "app recreated" : "data replaced"}) in ${duration(result.ms)}`, {
        type: "success",
      });
      setOpen(false);
      refresh();
    } catch (error) {
      notify((error as Error).message, { type: "error" });
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setConfirm("");
          setOpen(true);
        }}
      >
        <RotateCcw /> Restore…
      </Button>
      <Dialog open={open} onOpenChange={(value) => !loading && setOpen(value)}>
        <DialogContent onClick={(e) => e.stopPropagation()} data-testid="restore-dialog">
          <DialogHeader>
            <DialogTitle>Restore {backup.app}</DialogTitle>
            <DialogDescription>
              {backup.app_deleted
                ? `The deleted app ${backup.app} is recreated from this ${backup.kind} backup of ${dateTime(backup.started_at)}: database, Storage files, live frontend and functions, keys and secrets, members that still have an account.`
                : `The app is stopped, then its database, Storage files, live frontend and functions versions and secrets are replaced by those of ${dateTime(backup.started_at)}. Everything written since is lost. It is started again at the end.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            {!backup.app_deleted && (
              <label className="flex items-center gap-2">
                <Checkbox checked={safety} onCheckedChange={(v) => setSafety(Boolean(v))} aria-label="Back up the current state first" />
                Back up the current state first (pre-restore backup)
              </label>
            )}
            <label className="flex flex-col gap-1">
              Type <code>{backup.app}</code> to confirm
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm slug" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={loading} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={confirm !== backup.app || loading} onClick={() => void run()}>
              {loading ? "Restoring…" : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const Location = ({ backup }: { backup: BackupRecord }) =>
  backup.location ? (
    <code className="block max-w-xs truncate text-xs" title={backup.location}>
      {backup.location}
    </code>
  ) : null;

const BackupColumns = ({ showApp }: { showApp: boolean }) => (
  <DataTable rowClick={false} bulkActionButtons={false}>
    {showApp && (
      <DataTable.Col
        source="app"
        render={(b: BackupRecord) =>
          b.app_deleted ? (
            <span title="This app was deleted">
              {b.app} <Badge variant="outline">deleted</Badge>
            </span>
          ) : (
            <Link className="underline" to={`/apps/${b.app}/show`} onClick={(e) => e.stopPropagation()}>
              {b.app}
            </Link>
          )
        }
      />
    )}
    <DataTable.Col source="started_at" label="Started" render={(b: BackupRecord) => dateTime(b.started_at)} />
    <DataTable.Col source="kind" render={(b: BackupRecord) => <KindBadge kind={b.kind} />} />
    <DataTable.Col source="status" render={(b: BackupRecord) => <StatusBadge status={b.status} />} />
    <DataTable.Col source="duration_ms" label="Duration" render={(b: BackupRecord) => duration(b.duration_ms)} />
    <DataTable.Col source="size_bytes" label="Size" render={(b: BackupRecord) => (b.size_bytes === null ? "—" : bytes(b.size_bytes))} />
    <DataTable.Col
      label="Versions"
      disableSort
      render={(b: BackupRecord) =>
        b.versions ? `front v${b.versions.frontend ?? "—"} · functions v${b.versions.functions ?? "—"}` : "—"
      }
    />
    <DataTable.Col
      label="Location / error"
      disableSort
      render={(b: BackupRecord) =>
        b.error ? <span className="block max-w-xs truncate text-destructive" title={b.error}>{b.error}</span> : <Location backup={b} />
      }
    />
    <DataTable.Col label="" disableSort render={(b: BackupRecord) => <RestoreButton backup={b} />} />
  </DataTable>
);

const backupFilters = [
  <SearchInput key="q" source="q" alwaysOn placeholder="Search app, location, error" />,
  <SelectInput key="kind" source="kind" choices={KINDS} alwaysOn emptyText="Any kind" />,
  <SelectInput key="status" source="status" choices={STATUSES} alwaysOn emptyText="Any status" />,
];

function BackupSettingsCard() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<BackupStatus>("/backup-settings").then(setStatus, (e: Error) => setError(e.message));
  }, []);
  if (error) return <p className="text-destructive">{error}</p>;
  if (!status) return null;
  const run = status.last_run;
  return (
    <Card className="mb-4" data-testid="backup-settings">
      <CardHeader>
        <CardTitle className="text-base">Settings and last run</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
        <div>
          <div className="text-xs text-muted-foreground">Schedule</div>
          {status.enabled ? `Daily at ${String(status.hour_utc).padStart(2, "0")}:00 UTC` : "Scheduled backups are off"}
          <div className="text-muted-foreground">
            Kept: {status.keep_daily} daily, {status.keep_weekly} weekly; manual {status.manual_retention_days} days; final{" "}
            {status.final_retention_days} days
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Target</div>
          {status.s3 ? (
            <code className="text-xs">
              s3://{status.s3.bucket}/{status.s3.prefix} ({status.s3.endpoint})
            </code>
          ) : (
            "Backups volume of the platform host (no off-site copy: configure the backup_s3_* settings)"
          )}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Last daily run</div>
          {run?.run_started_at ? (
            <>
              {dateTime(run.run_started_at)}
              {run.run_summary
                ? ` · ${run.run_summary.succeeded}/${run.run_summary.apps} succeeded, ${run.run_summary.pruned} pruned`
                : " · running"}
              {run.run_summary?.failed.length ? (
                <div className="text-destructive">Failed: {run.run_summary.failed.map((f) => f.app).join(", ")}</div>
              ) : null}
            </>
          ) : (
            "Not run yet"
          )}
          {status.stale_apps.length > 0 && (
            <div className="text-destructive" data-testid="stale-apps">
              No backup for 36 h: {status.stale_apps.map((a) => a.slug).join(", ")}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export const BackupList = () => (
  <List
    filters={backupFilters}
    sort={{ field: "started_at", order: "DESC" }}
    perPage={50}
    actions={false}
    title="Backups"
  >
    <BackupSettingsCard />
    <div className="mb-3 flex flex-wrap gap-2">
      <ToggleFilterButton className="w-auto border" label="Deleted apps" value={{ deleted: true }} />
    </div>
    <BackupColumns showApp />
  </List>
);

/** App page tab: the app's backups (its deleted predecessors' are on the Backups screen), "Backup now". */
export function AppBackups() {
  const app = useRecordContext<RaRecord & { slug: string; status: string }>();
  if (!app) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ActionButton
          label="Backup now"
          icon={<DatabaseBackup />}
          action={() => api(`/apps/${app.slug}/backup`, { body: {} })}
          successMessage="Backup taken"
          disabled={app.status === "provisioning"}
        />
        <span className="text-sm text-muted-foreground">
          Database, Storage files, live frontend and functions, secrets (encrypted). Daily backups run for every app.
        </span>
      </div>
      <ReferenceManyField
        reference="backups"
        target="app"
        sort={{ field: "started_at", order: "DESC" }}
        perPage={25}
        pagination={<ListPagination />}
        empty={<p className="text-sm text-muted-foreground">No backup yet.</p>}
      >
        <BackupColumns showApp={false} />
      </ReferenceManyField>
    </div>
  );
}
