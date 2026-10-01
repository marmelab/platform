import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolInputs } from "@platform/shared";
import { appForUser, appInfo, appsForUser, createApp, UserError } from "./apps.ts";
import type { User } from "./auth.ts";
import { apiUrl } from "./config.ts";
import { createDeployment, finalizeDeployment, listDeployments, rollback } from "./deployments.ts";
import { getLogs } from "./logs.ts";
import { listSecrets, setSecrets } from "./secrets.ts";
import { applyMigrations, executeSql } from "./sql.ts";

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (!(error instanceof UserError)) console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export function buildMcpServer(user: User): McpServer {
  const server = new McpServer({ name: "platform", version: "0.1.0" });
  const t = toolInputs;

  server.registerTool("whoami", { description: "Current user and the apps they can access" }, () =>
    run(async () => ({
      email: user.email,
      name: user.name,
      role: user.role,
      api_url: apiUrl(),
      apps: (await appsForUser(user)).map((a) => ({ slug: a.slug, name: a.name, status: a.status, role: a.member_role })),
    })));

  server.registerTool("list_apps", { description: "Apps the user can access, with URL and anon key" }, () =>
    run(async () => Promise.all((await appsForUser(user)).map(appInfo))));

  server.registerTool(
    "get_app",
    {
      description:
        "App details: URL, SUPABASE_URL and anon key (use them as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY), live versions",
      inputSchema: t.get_app,
    },
    ({ app }) => run(async () => appInfo(await appForUser(user, app))),
  );

  server.registerTool(
    "create_app",
    {
      description: "Provision a new app (Postgres database, Auth, REST API, functions, static hosting). Idempotent.",
      inputSchema: t.create_app,
    },
    ({ name, slug }) => run(() => createApp(user, name, slug)),
  );

  server.registerTool(
    "apply_migrations",
    {
      description:
        "Apply supabase/migrations files. Only versions not yet applied run, all in one transaction. " +
        "Returns the security linter results: stop and warn the user when a public table has no RLS.",
      inputSchema: t.apply_migrations,
    },
    ({ app, migrations }) => run(async () => applyMigrations(user, await appForUser(user, app), migrations)),
  );

  server.registerTool(
    "execute_sql",
    {
      description: "Run SQL as the app owner role. Read-only (single statement) unless write=true (audited).",
      inputSchema: t.execute_sql,
    },
    ({ app, sql, write }) => run(async () => executeSql(user, await appForUser(user, app), sql, write ?? false)),
  );

  server.registerTool(
    "create_deployment",
    {
      description:
        "Start a frontend or functions deployment. Returns a single-use pre-signed upload URL: upload a tar.gz " +
        "with curl (frontend: content of dist/; functions: supabase/functions and optional supabase/config.toml), " +
        "then call finalize_deployment.",
      inputSchema: t.create_deployment,
    },
    ({ app, kind }) => run(async () => createDeployment(user, await appForUser(user, app), kind)),
  );

  server.registerTool(
    "finalize_deployment",
    { description: "Verify, extract and publish an uploaded deployment", inputSchema: t.finalize_deployment },
    ({ deployment_id }) => run(() => finalizeDeployment(user, deployment_id)),
  );

  server.registerTool(
    "list_deployments",
    { description: "Deployment history (frontend, functions, migrations)", inputSchema: t.list_deployments },
    ({ app, kind }) => run(async () => listDeployments(await appForUser(user, app), kind)),
  );

  server.registerTool(
    "rollback",
    { description: "Point frontend or functions back to a previous version", inputSchema: t.rollback },
    ({ app, kind, version }) => run(async () => rollback(user, await appForUser(user, app), kind, version)),
  );

  server.registerTool(
    "set_secrets",
    { description: "Set (or delete with null) edge function secrets", inputSchema: t.set_secrets },
    ({ app, secrets }) => run(async () => setSecrets(user, await appForUser(user, app), secrets)),
  );

  server.registerTool(
    "list_secrets",
    { description: "Names of the edge function secrets (values are never returned)", inputSchema: t.list_secrets },
    ({ app }) => run(async () => listSecrets(await appForUser(user, app))),
  );

  server.registerTool(
    "get_logs",
    {
      description: "Recent logs of the app: gotrue, postgrest, functions (edge runtime), postgres",
      inputSchema: t.get_logs,
    },
    ({ app, service, since_minutes, limit, query }) =>
      run(async () =>
        getLogs(await appForUser(user, app), {
          service,
          sinceMinutes: since_minutes ?? 60,
          limit: limit ?? 200,
          query,
        })
      ),
  );

  return server;
}
