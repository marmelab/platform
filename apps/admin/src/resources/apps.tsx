// Apps overview (journey A9) and app page: status and actions, releases and deployments with rollback, members,
// secret names, schema changes, security linter, backups, logs, audit.
import { type ReactNode, useEffect, useState } from "react";
import {
  useCreate,
  useDelete,
  useNotify,
  useRecordContext,
  useRedirect,
  useRefresh,
  useUpdate,
  type RaRecord,
} from "ra-core";
import { Play, Square, Trash2 } from "lucide-react";
import {
  DataTable,
  List,
  ReferenceManyField,
  SearchInput,
  SelectInput,
  Show,
  ToggleFilterButton,
} from "@/components/admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "../providers";
import { count, type Day, type Hour, HourlyChart, Sparkline } from "./charts";
import { ActionButton } from "./actions";
import { AuditTable } from "./audit";
import { AppBackups } from "./backups";
import { AppLints } from "./lints";
import {
  bytes,
  Commit,
  dateTime,
  ExternalLink,
  FlagBadges,
  type Flags,
  type Release,
  ReleaseSummary,
  SourceBadge,
  StatusBadge,
} from "./fields";

interface Owner {
  id: string;
  email: string;
  name: string | null;
}

export interface AppRecord extends RaRecord {
  id: string;
  slug: string;
  name: string;
  status: string;
  error: string | null;
  url: string;
  studio_url: string;
  github_repo: string | null;
  github_url: string | null;
  default_branch: string | null;
  owners: Owner[];
  member_count: number;
  last_release: Release | null;
  flags: Flags;
  db_size: number | null;
  requests_24h: number;
  errors_24h: number;
  memory: number | null;
  traffic_7d: Day[];
  last_request_at: string | null;
  last_activity_at: string;
  frontend_version: number | null;
  functions_version: number | null;
  created_at: string;
  services?: { name: string; service: string; state: string }[];
  /** App page only (M6): the auth policy set by the builder with configure_auth. */
  auth?: AuthPolicy;
  abandoned_notified_at?: string | null;
}

interface AuthPolicy {
  signup_enabled: boolean;
  email_confirmation: boolean;
  email_confirmation_effective: boolean;
  allowed_email_domains: string[];
  redirect_urls: string[];
  site_url: string;
  smtp_configured: boolean;
  sender_name: string;
  sender_email: string | null;
  sender_overridden: boolean;
  updated_at: string | null;
}

const STATUSES = ["running", "stopped", "error", "provisioning"].map((id) => ({ id, name: id }));

const appFilters = [
  <SearchInput key="q" source="q" alwaysOn placeholder="Search slug, name, owner, repo" />,
  <SelectInput key="status" source="status" choices={STATUSES} alwaysOn emptyText="Any status" />,
];

const FlagFilters = () => (
  <div className="mb-3 flex flex-wrap gap-2">
    <ToggleFilterButton className="w-auto border" label="Deployed outside CI" value={{ outside_ci: true }} />
    <ToggleFilterButton className="w-auto border" label="Schema drift" value={{ schema_drift: true }} />
    <ToggleFilterButton className="w-auto border" label="Lint errors" value={{ lint_errors: true }} />
    <ToggleFilterButton className="w-auto border" label="Accepted lints" value={{ accepted_lints: true }} />
    <ToggleFilterButton className="w-auto border" label="Last release failed" value={{ last_release_failed: true }} />
    <ToggleFilterButton className="w-auto border" label="No repo" value={{ no_repo: true }} />
    <ToggleFilterButton className="w-auto border" label="Abandoned" value={{ abandoned: true }} />
  </div>
);

const Owners = ({ owners }: { owners: Owner[] }) =>
  owners.length ? (
    <div className="flex flex-col text-sm">
      {owners.map((o) => (
        <span key={o.id}>
          {o.name ? `${o.name} ` : ""}
          <span className="text-muted-foreground">{o.email}</span>
        </span>
      ))}
    </div>
  ) : (
    <span className="text-muted-foreground">no owner</span>
  );

export const AppList = () => (
  <List filters={appFilters} sort={{ field: "slug", order: "ASC" }} perPage={25} actions={false}>
    <FlagFilters />
    <DataTable<AppRecord> rowClick="show" bulkActionButtons={false}>
      <DataTable.Col
        source="slug"
        label="App"
        render={(app) => (
          <div className="flex flex-col">
            <span className="font-medium">{app.name}</span>
            <ExternalLink href={app.url}>{app.slug}</ExternalLink>
          </div>
        )}
      />
      <DataTable.Col source="status" render={(app) => <StatusBadge status={app.status} />} />
      <DataTable.Col source="owner_email" label="Owners" render={(app) => <Owners owners={app.owners} />} />
      <DataTable.Col
        source="github_repo"
        label="Repository"
        render={(app) => app.github_repo ? <ExternalLink href={app.github_url}>{app.github_repo}</ExternalLink> : "—"}
      />
      <DataTable.Col
        source="last_release_at"
        label="Last release"
        sortByOrder="DESC"
        render={(app) => <ReleaseSummary release={app.last_release} />}
      />
      <DataTable.Col label="Flags" disableSort render={(app) => <FlagBadges flags={app.flags} />} />
      <DataTable.Col
        source="requests_24h"
        label="Requests 24 h"
        sortByOrder="DESC"
        render={(app) => (
          <div className="flex flex-col gap-1 text-sm">
            <span className="tabular-nums">
              {count(app.requests_24h)}
              <span className="text-muted-foreground"> · {count(app.errors_24h)} 5xx</span>
            </span>
            <Sparkline days={app.traffic_7d} label={`${app.slug} requests per day`} />
          </div>
        )}
      />
      <DataTable.Col
        source="db_size"
        label="DB / memory"
        sortByOrder="DESC"
        render={(app) => (
          <div className="flex flex-col text-sm">
            <span>{bytes(app.db_size)}</span>
            <span className="text-muted-foreground" title="GoTrue and PostgREST containers">{bytes(app.memory)}</span>
          </div>
        )}
      />
    </DataTable>
  </List>
);

// --- show page ---

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1">
    <span className="text-xs text-muted-foreground">{label}</span>
    <div className="text-sm">{children}</div>
  </div>
);

function DeleteAppButton({ app }: { app: AppRecord }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [backup, setBackup] = useState(true);
  const [loading, setLoading] = useState(false);
  const notify = useNotify();
  const redirect = useRedirect();
  const run = async () => {
    setLoading(true);
    try {
      const result = await api<{ backup: string | null }>(`/apps/${app.slug}/delete`, { body: { confirm, backup } });
      notify(result.backup ? `App deleted, final backup in ${result.backup}` : "App deleted without backup", {
        type: "success",
      });
      redirect("list", "apps");
    } catch (error) {
      notify((error as Error).message, { type: "error" });
    } finally {
      setLoading(false);
    }
  };
  if (!open) {
    return (
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 /> Delete…
      </Button>
    );
  }
  return (
    <Card className="w-full border-destructive" data-testid="delete-app">
      <CardHeader>
        <CardTitle>Delete {app.slug}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>
          Irreversible: containers, database, roles, deployed files and platform rows are removed. A final backup
          (database, Storage files, live frontend and functions, secrets) is taken first unless unchecked: the app can
          be recreated from it (Backups screen) during the final backup retention.
        </p>
        <label className="flex items-center gap-2">
          <Checkbox checked={backup} onCheckedChange={(v) => setBackup(Boolean(v))} aria-label="Take a final backup" />
          Take a final backup
        </label>
        {!backup && <p className="text-destructive">Without backup, the data is lost for good.</p>}
        <label className="flex flex-col gap-1">
          Type <code>{app.slug}</code> to confirm
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm slug" />
        </label>
        <div className="flex gap-2">
          <Button variant="destructive" disabled={confirm !== app.slug || loading} onClick={() => void run()}>
            Delete permanently
          </Button>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const AppActions = ({ app }: { app: AppRecord }) => (
  <div className="flex flex-wrap items-start gap-2">
    {app.status === "stopped" ? (
      <ActionButton
        label="Start"
        icon={<Play />}
        action={() => api(`/apps/${app.slug}/start`, { body: {} })}
        successMessage="App started"
      />
    ) : (
      <ActionButton
        label="Stop"
        icon={<Square />}
        action={() => api(`/apps/${app.slug}/stop`, { body: {} })}
        confirm={{
          title: `Stop ${app.slug}?`,
          content: "The app is replaced by a maintenance page, its containers are stopped and its database becomes read-only.",
        }}
        successMessage="App stopped"
      />
    )}
    <DeleteAppButton app={app} />
  </div>
);

/** Load of the app (app_metrics): stat tiles and requests per hour over 7 days. */
function Load({ app }: { app: AppRecord }) {
  const [hours, setHours] = useState<Hour[] | null>(null);
  const [sampledAt, setSampledAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ hours: Hour[]; sampled_at: string | null }>(`/apps/${app.slug}/metrics?days=7`).then((m) => {
      setHours(m.hours);
      setSampledAt(m.sampled_at);
    }, (e: Error) => setError(e.message));
  }, [app.slug, app.requests_24h]);
  const rate = app.requests_24h ? ((app.errors_24h / app.requests_24h) * 100).toFixed(1) : null;
  return (
    <Card data-testid="app-load">
      <CardHeader>
        <CardTitle className="text-base">Load</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Field label="Requests, 24 h">{count(app.requests_24h)}</Field>
          <Field label="5xx responses, 24 h">
            {count(app.errors_24h)}
            {rate !== null && <span className="text-muted-foreground"> ({rate}%)</span>}
          </Field>
          <Field label="Database size">{bytes(app.db_size)}</Field>
          <Field label="Memory (GoTrue + PostgREST)">{bytes(app.memory)}</Field>
          <Field label="Last request">{dateTime(app.last_request_at)}</Field>
        </div>
        {error && <p className="text-destructive">{error}</p>}
        {hours ? <HourlyChart hours={hours} /> : !error && <p className="text-sm">Loading…</p>}
        <p className="text-xs text-muted-foreground">
          Requests to the app's host (frontend, API, functions), from Caddy's access log; sampled every minute
          {sampledAt ? `, last at ${dateTime(sampledAt)}` : ""}. Maintenance responses of a stopped app are not counted as
          5xx.
        </p>
      </CardContent>
    </Card>
  );
}

const list = (values: string[], empty: string) => (values.length ? values.join(", ") : empty);

/** The app's auth policy (M6), read-only: builders change it with the configure_auth MCP tool. */
const AuthPolicyCard = ({ auth }: { auth: AuthPolicy }) => (
  <Card data-testid="app-auth">
    <CardHeader>
      <CardTitle className="text-base">Auth</CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="Sign-up">{auth.signup_enabled ? "open" : "disabled (invitations only)"}</Field>
        <Field label="Email confirmation">
          {auth.email_confirmation_effective
            ? "required"
            : auth.email_confirmation
            ? "not required (no SMTP on the platform)"
            : "not required"}
        </Field>
        <Field label="Allowed email domains">{list(auth.allowed_email_domains, "any")}</Field>
        <Field label="Site URL">{auth.site_url}</Field>
        <Field label="Extra redirect URLs">{list(auth.redirect_urls, "none")}</Field>
        <Field label="Sender">
          {auth.smtp_configured ? `${auth.sender_name} <${auth.sender_email}>` : "no SMTP: no email is sent"}
          {auth.sender_overridden && <span className="text-muted-foreground"> (set by the builder)</span>}
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        Changed by the app's owners with the configure_auth tool{auth.updated_at ? `, last on ${dateTime(auth.updated_at)}` : ""}.
        Email templates are GoTrue's defaults.
      </p>
    </CardContent>
  </Card>
);

const Overview = ({ app }: { app: AppRecord }) => (
  <div className="flex flex-col gap-6">
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Field label="Status">
        <StatusBadge status={app.status} />
        {app.error && <p className="mt-1 text-destructive">{app.error}</p>}
      </Field>
      <Field label="URL">
        <ExternalLink href={app.url}>{app.url}</ExternalLink>
      </Field>
      <Field label="Studio">
        <ExternalLink href={app.studio_url}>Open in Studio</ExternalLink>
      </Field>
      <Field label="Repository">
        {app.github_repo ? (
          <ExternalLink href={app.github_url}>
            {app.github_repo}
            {app.default_branch ? ` (${app.default_branch})` : ""}
          </ExternalLink>
        ) : (
          "not linked"
        )}
      </Field>
      <Field label="Owners">
        <Owners owners={app.owners} />
      </Field>
      <Field label="Created">{dateTime(app.created_at)}</Field>
      <Field label="Live versions">
        frontend v{app.frontend_version ?? "—"}, functions v{app.functions_version ?? "—"}
      </Field>
      <Field label="Database size">{bytes(app.db_size)}</Field>
      <Field label="Flags">
        <FlagBadges flags={app.flags} />
      </Field>
    </div>
    <Field label="Services">
      {app.services?.length ? (
        <div className="flex flex-wrap gap-2">
          {app.services.map((s) => (
            <Badge key={s.name} variant={s.state === "running" ? "default" : "secondary"}>
              {s.service}: {s.state}
            </Badge>
          ))}
        </div>
      ) : (
        "no containers"
      )}
    </Field>
    <Field label="Last release">
      <ReleaseSummary release={app.last_release} />
    </Field>
    <Load app={app} />
    {app.auth && <AuthPolicyCard auth={app.auth} />}
    <AppActions app={app} />
  </div>
);

const Releases = ({ app }: { app: AppRecord }) => (
  <div className="flex flex-col gap-6">
    <h3 className="font-semibold">Releases</h3>
    <ReferenceManyField
      reference="releases"
      target="app"
      sort={{ field: "started_at", order: "DESC" }}
      perPage={50}
      empty={<p className="text-sm text-muted-foreground">No release yet.</p>}
    >
      <DataTable<Release & RaRecord> rowClick={false} bulkActionButtons={false}>
        <DataTable.Col source="started_at" label="Started" render={(r) => dateTime(r.started_at)} />
        <DataTable.Col source="status" render={(r) => <StatusBadge status={r.status} />} />
        <DataTable.Col source="source" render={(r) => <SourceBadge release={r as unknown as Release} />} />
        <DataTable.Col source="commit_sha" label="Commit" render={(r) => <Commit release={r as unknown as Release} />} />
        <DataTable.Col
          label="Diff"
          disableSort
          render={(r) => r.compare_url ? <ExternalLink href={r.compare_url}>since previous</ExternalLink> : "—"}
        />
        <DataTable.Col label="Author" disableSort render={(r) => r.github_actor ?? r.created_by ?? "—"} />
        <DataTable.Col label="Run" disableSort render={(r) => r.ci_run_url ? <ExternalLink href={r.ci_run_url}>run</ExternalLink> : "—"} />
        <DataTable.Col
          label="Deployments"
          disableSort
          render={(r) => (
            <span className="text-sm">
              {(r.deployments as { kind: string; version: number }[]).map((d) => `${d.kind} v${d.version}`).join(", ") || "—"}
            </span>
          )}
        />
        <DataTable.Col label="Reason / error" disableSort render={(r) => r.error ?? r.reason ?? ""} />
      </DataTable>
    </ReferenceManyField>
    <h3 className="font-semibold">Deployments</h3>
    <ReferenceManyField
      reference="deployments"
      target="app"
      sort={{ field: "created_at", order: "DESC" }}
      perPage={50}
      empty={<p className="text-sm text-muted-foreground">No deployment yet.</p>}
    >
      <DataTable rowClick={false} bulkActionButtons={false}>
        <DataTable.Col source="created_at" label="Created" render={(d) => dateTime(d.created_at)} />
        <DataTable.Col source="kind" />
        <DataTable.Col source="version" render={(d) => `v${d.version}`} />
        <DataTable.Col source="status" render={(d) => <StatusBadge status={d.status} />} />
        <DataTable.Col source="created_by" label="By" render={(d) => d.created_by ?? "CI"} />
        <DataTable.Col
          label=""
          disableSort
          render={(d) =>
            d.rollbackable ? (
              <ActionButton
                label="Roll back to this version"
                action={() => api(`/apps/${app.slug}/rollback`, { body: { kind: d.kind, version: d.version } })}
                confirm={{
                  title: `Roll ${d.kind} back to v${d.version}?`,
                  content: "The live version is switched to this one. Migrations are never rolled back.",
                }}
                successMessage={`${d.kind} rolled back to v${d.version}`}
                disabled={app.status === "stopped"}
              />
            ) : null}
        />
      </DataTable>
    </ReferenceManyField>
  </div>
);

function Members({ app }: { app: AppRecord }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("collaborator");
  const [create, { isPending }] = useCreate();
  const [update] = useUpdate();
  const [remove] = useDelete();
  const notify = useNotify();
  const refresh = useRefresh();
  const options = {
    onSuccess: () => refresh(),
    onError: (error: unknown) => notify((error as Error).message, { type: "error" }),
  };
  return (
    <div className="flex flex-col gap-4">
      <ReferenceManyField reference="app_members" target="app" perPage={100}>
        <DataTable rowClick={false} bulkActionButtons={false}>
          <DataTable.Col source="email" />
          <DataTable.Col source="name" />
          <DataTable.Col source="role" render={(m) => <Badge variant={m.role === "owner" ? "default" : "outline"}>{m.role}</Badge>} />
          <DataTable.Col
            label=""
            disableSort
            render={(m) => (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    update("app_members", {
                      id: m.id,
                      data: { role: m.role === "owner" ? "collaborator" : "owner" },
                      previousData: m,
                    }, { ...options, mutationMode: "pessimistic" })}
                >
                  Make {m.role === "owner" ? "collaborator" : "owner"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  onClick={() => remove("app_members", { id: m.id, previousData: m }, { ...options, mutationMode: "pessimistic" })}
                >
                  Remove
                </Button>
              </div>
            )}
          />
        </DataTable>
      </ReferenceManyField>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create("app_members", { data: { app: app.slug, email, role } }, {
            ...options,
            onSuccess: () => {
              setEmail("");
              refresh();
            },
          });
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Add a member (existing platform account)
          <Input type="email" required placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label="Role"
        >
          <option value="collaborator">collaborator</option>
          <option value="owner">owner</option>
        </select>
        <Button type="submit" disabled={isPending}>
          Add
        </Button>
      </form>
    </div>
  );
}

const Secrets = () => (
  <ReferenceManyField reference="secrets" target="app" perPage={100} empty={<p className="text-sm text-muted-foreground">No secrets.</p>}>
    <DataTable rowClick={false} bulkActionButtons={false}>
      <DataTable.Col source="name" />
      <DataTable.Col source="updated_at" label="Updated" render={(s) => dateTime(s.updated_at)} />
    </DataTable>
  </ReferenceManyField>
);

function SchemaChanges() {
  const [all, setAll] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={all} onCheckedChange={(v) => setAll(Boolean(v))} />
        Show every recorded change (default: outside releases since the last succeeded release)
      </label>
      <ReferenceManyField
        reference="schema_changes"
        target="app"
        filter={all ? { all: true } : {}}
        perPage={100}
        empty={<p className="text-sm text-muted-foreground">No schema change outside releases.</p>}
      >
        <DataTable rowClick={false} bulkActionButtons={false}>
          <DataTable.Col source="at" render={(s) => dateTime(s.at)} />
          <DataTable.Col source="command_tag" label="Command" />
          <DataTable.Col source="object_identity" label="Object" />
          <DataTable.Col source="role" />
          <DataTable.Col source="application_name" label="Client" />
          <DataTable.Col source="in_release" label="In release" render={(s) => (s.in_release ? "yes" : "no")} />
        </DataTable>
      </ReferenceManyField>
    </div>
  );
}

function Logs({ app }: { app: AppRecord }) {
  const [service, setService] = useState("");
  const [lines, setLines] = useState<{ ts: string; service: string; line: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLines(null);
    api<{ ts: string; service: string; line: string }[]>(`/apps/${app.slug}/logs?limit=200${service ? `&service=${service}` : ""}`)
      .then(setLines, (e: Error) => setError(e.message));
  }, [app.slug, service]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        Service
        <select className="h-8 rounded-md border bg-background px-2" value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">all</option>
          <option value="gotrue">gotrue</option>
          <option value="postgrest">postgrest</option>
          <option value="functions">functions</option>
          <option value="postgres">postgres</option>
        </select>
        <span className="text-muted-foreground">last hour, Docker logs (no history before Loki)</span>
      </div>
      {error && <p className="text-destructive">{error}</p>}
      <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-xs">
        {lines === null ? "Loading…" : lines.length ? lines.map((l) => `${l.ts} [${l.service}] ${l.line}`).join("\n") : "No logs."}
      </pre>
    </div>
  );
}

function AppTabs() {
  const app = useRecordContext<AppRecord>();
  if (!app) return null;
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="releases">Releases</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="secrets">Secrets</TabsTrigger>
        <TabsTrigger value="schema">Schema changes</TabsTrigger>
        <TabsTrigger value="lints">Security linter</TabsTrigger>
        <TabsTrigger value="backups">Backups</TabsTrigger>
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="audit">Audit</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="pt-4">
        <Overview app={app} />
      </TabsContent>
      <TabsContent value="releases" className="pt-4">
        <Releases app={app} />
      </TabsContent>
      <TabsContent value="members" className="pt-4">
        <Members app={app} />
      </TabsContent>
      <TabsContent value="secrets" className="pt-4">
        <p className="mb-2 text-sm text-muted-foreground">Names only: values are never shown.</p>
        <Secrets />
      </TabsContent>
      <TabsContent value="schema" className="pt-4">
        <SchemaChanges />
      </TabsContent>
      <TabsContent value="lints" className="pt-4">
        <AppLints slug={app.slug} />
      </TabsContent>
      <TabsContent value="backups" className="pt-4">
        <AppBackups />
      </TabsContent>
      <TabsContent value="logs" className="pt-4">
        <Logs app={app} />
      </TabsContent>
      <TabsContent value="audit" className="pt-4">
        <AuditTable target="app" />
      </TabsContent>
    </Tabs>
  );
}

export const AppShow = () => (
  <Show actions={false} title={<AppTitle />}>
    <AppTabs />
  </Show>
);

const AppTitle = () => {
  const app = useRecordContext<AppRecord>();
  return <span>{app ? `${app.name} (${app.slug})` : "App"}</span>;
};
