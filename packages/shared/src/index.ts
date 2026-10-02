import { z } from "zod";

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const FUNCTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** GitHub "owner/name". */
export const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** A branch name (not a full ref): no "refs/" prefix, no spaces or git-forbidden characters. */
export const BRANCH_RE = /^(?!refs\/)(?!-)[^\s~^:?*[\\]{1,255}$/;

export const slug = z.string().regex(SLUG_RE, "lowercase letters, digits and dashes (3-32 chars)");
export const deploymentKind = z.enum(["frontend", "functions"]);
export type DeploymentKind = z.infer<typeof deploymentKind>;
export const memberRole = z.enum(["owner", "collaborator"]);
export type MemberRole = z.infer<typeof memberRole>;

export const migration = z.object({
  version: z.string().regex(/^\d{1,20}$/, "numeric version, e.g. 20260101120000"),
  name: z.string().max(200).optional(),
  sql: z.string().min(1),
});
export type Migration = z.infer<typeof migration>;

/** A lint name accepts it on every object; {name, object} accepts it on one object only. */
export const acceptedLint = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), object: z.string().min(1) }),
]);
export type AcceptedLint = z.infer<typeof acceptedLint>;

const releaseId = z.uuid()
  .describe("Release from begin_release; omitted: the publication gets its own release (source direct)");
export const releaseStatus = z.enum(["succeeded", "failed"]);
export const releaseFinish = {
  status: releaseStatus,
  error: z.string().max(2000).optional().describe("Why the release failed"),
};

export const toolInputs = {
  get_app: { app: slug },
  create_app: {
    name: z.string().min(1).max(100).describe("Human readable name"),
    slug: slug.optional().describe("Subdomain; derived from the name when omitted"),
  },
  apply_migrations: {
    app: slug,
    migrations: z.array(migration).describe("Contents of supabase/migrations/<version>_<name>.sql"),
    dry_run: z.boolean().default(false)
      .describe("Apply, run the linter, then always roll back: nothing is committed"),
    accept_lints: z.array(acceptedLint).optional()
      .describe("ERROR lints to accept (audited). Only with the user's explicit consent"),
    release_id: releaseId.optional(),
  },
  execute_sql: {
    app: slug,
    sql: z.string().min(1),
    write: z.boolean().default(false).describe("Allow writes (logged). Read-only mode accepts a single statement"),
  },
  create_deployment: { app: slug, kind: deploymentKind, release_id: releaseId.optional() },
  finalize_deployment: { deployment_id: z.uuid() },
  list_deployments: { app: slug, kind: deploymentKind.optional() },
  rollback: {
    app: slug,
    kind: deploymentKind,
    version: z.number().int().positive().optional().describe("Defaults to the previous version"),
  },
  set_secrets: {
    app: slug,
    secrets: z.record(z.string().regex(SECRET_NAME_RE), z.string().nullable())
      .describe("NAME -> value; null deletes the secret"),
  },
  list_secrets: { app: slug },
  list_members: { app: slug },
  add_member: {
    app: slug,
    email: z.email().describe("Email of an existing platform account"),
    role: memberRole.default("collaborator")
      .describe("collaborator: deploy, inspect, manage app users; owner: also members, stop, start, delete"),
  },
  remove_member: { app: slug, email: z.email() },
  link_repo: {
    app: slug,
    repo: z.string().regex(GITHUB_REPO_RE, "owner/name").describe("GitHub repository, owner/name"),
    repository_id: z.number().int().positive()
      .describe("Numeric repository id, stable across renames: gh api repos/<owner>/<name> --jq .id"),
    default_branch: z.string().regex(BRANCH_RE, "branch name, without refs/heads/")
      .describe("Only this branch, when protected, can deploy from CI"),
  },
  begin_release: {
    app: slug,
    commit_sha: z.string().regex(/^[0-9a-f]{7,64}$/).optional().describe("Commit being deployed"),
    reason: z.string().min(1).max(500).optional()
      .describe("Why this is deployed outside CI (expected from admins when direct deployment is reserved to them)"),
  },
  finish_release: { release_id: z.uuid(), ...releaseFinish },
  stop_app: { app: slug },
  start_app: { app: slug },
  delete_app: {
    app: slug,
    confirm: z.string().describe("Must repeat the app slug: deletion is irreversible, ask the user first"),
    backup: z.boolean().default(true)
      .describe("false skips the final backup: the data is then lost for good. Only if the user explicitly asks"),
  },
  list_schema_changes: {
    app: slug,
    all: z.boolean().default(false)
      .describe("false: changes outside releases since the last succeeded release; true: every recorded change"),
    limit: z.number().int().positive().max(500).default(50),
  },
  get_logs: {
    app: slug,
    service: z.enum(["gotrue", "postgrest", "functions", "postgres"]).optional(),
    since_minutes: z.number().int().positive().max(1440).default(60),
    limit: z.number().int().positive().max(1000).default(200),
    query: z.string().optional().describe("Case-insensitive substring filter"),
  },
};

/** Bodies of the CI REST API (/ci/apps/:app/...), authenticated by a GitHub OIDC token. */
export const ciInputs = {
  apply_migrations: {
    migrations: toolInputs.apply_migrations.migrations,
    dry_run: toolInputs.apply_migrations.dry_run,
    accept_lints: toolInputs.apply_migrations.accept_lints,
  },
  create_deployment: { kind: deploymentKind },
  finish_release: releaseFinish,
};

export interface ReleaseInfo {
  id: string;
  source: "ci" | "direct";
  status: "running" | "succeeded" | "failed";
  commit_sha: string | null;
  ci_run_url: string | null;
  github_actor: string | null;
  /** Platform account of a direct deployment. */
  created_by: string | null;
  admin_exception: boolean;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface AppInfo {
  slug: string;
  name: string;
  status: string;
  url: string;
  supabase_url: string;
  anon_key: string;
  role: string;
  frontend_version: number | null;
  functions_version: number | null;
  /** Deep link to the app in Studio (behind the platform login). */
  studio_url: string;
  /** Linked GitHub repository (link_repo), null until linked. */
  github_repo: string | null;
  github_repo_id: number | null;
  default_branch: string | null;
  last_release: ReleaseInfo | null;
  created_at: string;
  /**
   * get_app only: DDL commands recorded outside a release since the last succeeded release (Studio, execute_sql with
   * write...); null when it cannot be read.
   */
  schema_drift?: { count: number; last_at: string | null; since: string | null } | null;
}

export interface LintResult {
  name: string;
  level: "ERROR" | "WARN" | "INFO";
  object: string;
  detail: string;
}

export interface LogLine {
  ts: string;
  service: string;
  line: string;
}
