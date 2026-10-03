// Small display helpers shared by the resources.
import type { ReactNode } from "react";
import { ExternalLink as ExternalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const dateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "—";

export function bytes(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Link that opens outside the admin (app, GitHub, Studio); clicks do not trigger the row click. */
export const ExternalLink = ({ href, children, icon = true }: { href: string | null | undefined; children: ReactNode; icon?: boolean }) =>
  href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
      {icon && <ExternalIcon className="size-3 opacity-60" />}
    </a>
  ) : (
    <>{children}</>
  );

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  succeeded: "default",
  live: "default",
  active: "default",
  stopped: "secondary",
  provisioning: "outline",
  ready: "outline",
  pending: "outline",
  uploaded: "outline",
  revoked: "secondary",
  expired: "secondary",
  error: "destructive",
  failed: "destructive",
};

export const StatusBadge = ({ status }: { status: string | null | undefined }) =>
  status ? <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{status}</Badge> : null;

export interface Flags {
  outside_ci: boolean;
  admin_exception: boolean;
  last_release_failed: boolean;
  stopped: boolean;
  error: boolean;
  accepted_lints: number;
  /** ERROR lints of the latest linter run, not accepted by a migration. */
  lint_errors: number;
  no_repo: boolean;
  schema_drift: number | null;
  abandoned: boolean;
}

/** The A9 flags of an app. */
export const FlagBadges = ({ flags }: { flags: Flags | undefined }) => {
  if (!flags) return null;
  const items: [string, string, "destructive" | "secondary" | "outline"][] = [];
  if (flags.outside_ci) items.push([flags.admin_exception ? "admin exception" : "deployed outside CI", "Last release published with a PAT, not by CI", "destructive"]);
  if (flags.last_release_failed) items.push(["last release failed", "The last release failed", "destructive"]);
  if (flags.schema_drift) items.push([`schema drift: ${flags.schema_drift}`, "DDL commands outside releases since the last succeeded release", "destructive"]);
  if (flags.lint_errors > 0) items.push([`lint errors: ${flags.lint_errors}`, "ERROR lints of the latest security linter run, not accepted by a migration", "destructive"]);
  if (flags.accepted_lints > 0) items.push([`accepted lints: ${flags.accepted_lints}`, "ERROR lints accepted by migrations", "secondary"]);
  if (flags.abandoned) items.push(["abandoned", "No request and no release for the abandoned_after_days setting (30 days by default)", "secondary"]);
  if (flags.no_repo) items.push(["no repo", "No GitHub repository linked: it cannot deploy through CI", "outline"]);
  if (!items.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([label, title, variant]) => (
        <Badge key={label} variant={variant} title={title}>
          {label}
        </Badge>
      ))}
    </div>
  );
};

export interface Release {
  id: string;
  source: "ci" | "direct";
  status: string;
  commit_sha: string | null;
  commit_url?: string | null;
  compare_url?: string | null;
  ci_run_url: string | null;
  github_actor: string | null;
  created_by: string | null;
  admin_exception: boolean;
  reason: string | null;
  error?: string | null;
  started_at: string;
  finished_at: string | null;
}

export const SourceBadge = ({ release }: { release: Pick<Release, "source" | "admin_exception"> }) =>
  release.source === "ci" ? (
    <Badge variant="outline">CI</Badge>
  ) : (
    <Badge variant="destructive">{release.admin_exception ? "admin exception" : "direct"}</Badge>
  );

export const Commit = ({ release }: { release: Release }) =>
  release.commit_sha ? (
    <ExternalLink href={release.commit_url}>
      <code>{release.commit_sha.slice(0, 7)}</code>
    </ExternalLink>
  ) : (
    <span className="text-muted-foreground">no commit</span>
  );

/** Last release of an app in one cell: date, commit, author, source, result, run link. */
export const ReleaseSummary = ({ release }: { release: Release | null | undefined }) => {
  if (!release) return <span className="text-muted-foreground">never deployed</span>;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>{dateTime(release.started_at)}</span>
        <StatusBadge status={release.status} />
        <SourceBadge release={release} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <Commit release={release} />
        <span>by {release.github_actor ?? release.created_by ?? "?"}</span>
        {release.ci_run_url && <ExternalLink href={release.ci_run_url}>run</ExternalLink>}
      </div>
    </div>
  );
};
