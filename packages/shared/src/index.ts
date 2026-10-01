import { z } from "zod";

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const FUNCTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export const slug = z.string().regex(SLUG_RE, "lowercase letters, digits and dashes (3-32 chars)");
export const deploymentKind = z.enum(["frontend", "functions"]);
export type DeploymentKind = z.infer<typeof deploymentKind>;

export const migration = z.object({
  version: z.string().regex(/^\d{1,20}$/, "numeric version, e.g. 20260101120000"),
  name: z.string().max(200).optional(),
  sql: z.string().min(1),
});
export type Migration = z.infer<typeof migration>;

export const toolInputs = {
  get_app: { app: slug },
  create_app: {
    name: z.string().min(1).max(100).describe("Human readable name"),
    slug: slug.optional().describe("Subdomain; derived from the name when omitted"),
  },
  apply_migrations: {
    app: slug,
    migrations: z.array(migration).describe("Contents of supabase/migrations/<version>_<name>.sql"),
  },
  execute_sql: {
    app: slug,
    sql: z.string().min(1),
    write: z.boolean().default(false).describe("Allow writes (logged). Read-only mode accepts a single statement"),
  },
  create_deployment: { app: slug, kind: deploymentKind },
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
  get_logs: {
    app: slug,
    service: z.enum(["gotrue", "postgrest", "functions", "postgres"]).optional(),
    since_minutes: z.number().int().positive().max(1440).default(60),
    limit: z.number().int().positive().max(1000).default(200),
    query: z.string().optional().describe("Case-insensitive substring filter"),
  },
};

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
  created_at: string;
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
