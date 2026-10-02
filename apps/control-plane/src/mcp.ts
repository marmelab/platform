import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolInputs } from "@platform/shared";
import {
  appForUser,
  appInfo,
  appsForUser,
  createApp,
  deleteAppConfirmed,
  linkRepo,
  startApp,
  stopApp,
  UserError,
} from "./apps.ts";
import type { User } from "./auth.ts";
import { BAN_FOREVER_HOURS, deleteUser, inviteUser, listAuthUsers, setBan } from "./auth-users.ts";
import { apiUrl } from "./config.ts";
import {
  createDeployment,
  finalizeDeployment,
  listDeployments,
  loadDeployment,
  rollback,
  setDeploymentRelease,
} from "./deployments.ts";
import { getLogs } from "./logs.ts";
import { addMember, listMembers, removeMember, requireOwner } from "./members.ts";
import {
  beginDirectRelease,
  directRelease,
  finishRelease,
  implicitDirectRelease,
  releaseForUser,
  requireDirectDeploy,
} from "./releases.ts";
import { listSchemaChanges, schemaDrift } from "./schema-changes.ts";
import { listSecrets, setSecrets } from "./secrets.ts";
import { callerWorkflow, getSettings } from "./settings.ts";
import { applyMigrations, executeSql, StructuredUserError } from "./sql.ts";

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (!(error instanceof UserError)) console.error(error);
    const message = error instanceof StructuredUserError
      ? JSON.stringify(error.details, null, 2)
      : error instanceof Error
      ? error.message
      : String(error);
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export function buildMcpServer(user: User): McpServer {
  const server = new McpServer({ name: "platform", version: "0.1.0" });
  const t = toolInputs;

  server.registerTool(
    "whoami",
    {
      description: "Current user, the apps they can access, direct_deploy (whether this user may publish directly " +
        "with their token; otherwise deployments go through the app's GitHub Actions CI) and ci (the reusable " +
        "workflow an app repository calls, and the company GitHub organization; null when CI is not set up)",
    },
    () =>
      run(async () => {
        const settings = await getSettings();
        const { directDeploy } = settings;
        return {
          email: user.email,
          name: user.name,
          role: user.role,
          api_url: apiUrl(),
          // DIRECT_DEPLOY: admins always publish directly (the audited exception when the setting is "admins")
          direct_deploy: user.role === "admin" || directDeploy === "everyone",
          direct_deploy_setting: directDeploy,
          ci: callerWorkflow(settings),
          apps: (await appsForUser(user)).map((a) => ({
            slug: a.slug,
            name: a.name,
            status: a.status,
            role: a.member_role,
          })),
        };
      }),
  );

  server.registerTool("list_apps", { description: "Apps the user can access, with URL and anon key" }, () =>
    run(async () => Promise.all((await appsForUser(user)).map(appInfo))));

  server.registerTool(
    "get_app",
    {
      description:
        "App details: URL, SUPABASE_URL and anon key (use them as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY), live " +
        "versions, linked repository, last release, and schema_drift: schema changes made outside a release since " +
        "the last one (details with list_schema_changes)",
      inputSchema: t.get_app,
    },
    ({ app }) =>
      run(async () => {
        const target = await appForUser(user, app);
        const drift = await schemaDrift(target).catch((error) => {
          console.error(`schema drift of ${target.slug}`, error);
          return null;
        });
        return { ...(await appInfo(target)), schema_drift: drift };
      }),
  );

  server.registerTool(
    "list_schema_changes",
    {
      description: "Schema changes (DDL) recorded in the app database outside a release: Studio SQL or table " +
        "editor, execute_sql with write, functions using SUPABASE_DB_URL. Newest first. all=true also lists the " +
        "changes made by deployed migrations (in_release, release_id)",
      inputSchema: t.list_schema_changes,
    },
    ({ app, all, limit }) =>
      run(async () => listSchemaChanges(await appForUser(user, app), { all: all ?? false, limit: limit ?? 50 })),
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
        "Apply supabase/migrations files. Only versions not yet applied run, all in one transaction, followed " +
        "by the security linter in the same transaction. If the batch introduces an ERROR lint (table without " +
        "RLS, security definer view...), everything is rolled back and the lints are returned: stop and show " +
        "them to the user. dry_run=true always rolls back. accept_lints commits despite the listed ERRORs " +
        "(audited): use it only with the user's explicit consent. Without dry_run this publishes: when the " +
        "platform reserves direct deployment to admins (DIRECT_DEPLOY=admins), builders get an error and deploy " +
        "through CI.",
      inputSchema: t.apply_migrations,
    },
    ({ app, migrations, dry_run, accept_lints, release_id }) =>
      run(async () => {
        const target = await appForUser(user, app);
        const dryRun = dry_run ?? false;
        if (!dryRun) await requireDirectDeploy(user);
        const release = release_id ? await directRelease(target, release_id) : null;
        return applyMigrations(user, target, migrations, {
          dryRun,
          acceptLints: accept_lints ?? [],
          release: async () => release?.id ?? (await implicitDirectRelease(user, target)).id,
        });
      }),
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
        "then call finalize_deployment. Publishing tool: reserved to admins when DIRECT_DEPLOY=admins.",
      inputSchema: t.create_deployment,
    },
    ({ app, kind, release_id }) =>
      run(async () => {
        const target = await appForUser(user, app);
        await requireDirectDeploy(user);
        const release = release_id ? await directRelease(target, release_id) : null;
        return createDeployment(user, target, kind, release?.id ?? null);
      }),
  );

  server.registerTool(
    "finalize_deployment",
    {
      description: "Verify, extract and publish an uploaded deployment. Functions are booted on the new version " +
        "first: if one fails to start (BOOT_ERROR), the deployment fails and the live version is unchanged. " +
        "Publishing tool: reserved to admins when DIRECT_DEPLOY=admins.",
      inputSchema: t.finalize_deployment,
    },
    ({ deployment_id }) =>
      run(async () => {
        const { deployment, app } = await loadDeployment(user, deployment_id);
        await requireDirectDeploy(user);
        if (deployment.release_id) await directRelease(app, deployment.release_id);
        const result = await finalizeDeployment(user, deployment, app);
        if (deployment.release_id) return { ...result, release_id: deployment.release_id };
        const release = await implicitDirectRelease(user, app);
        await setDeploymentRelease(deployment.id, release.id);
        return { ...result, release_id: release.id };
      }),
  );

  server.registerTool(
    "begin_release",
    {
      description: "Direct deployment (outside CI): open a release that groups the next apply_migrations, " +
        "create_deployment and finalize_deployment calls (pass its release_id), then finish_release. Without it, " +
        "each publication is its own release. Reserved to admins when DIRECT_DEPLOY=admins (the audited exception: " +
        "give a reason).",
      inputSchema: t.begin_release,
    },
    ({ app, commit_sha, reason }) =>
      run(async () => {
        const target = await appForUser(user, app);
        const release = await beginDirectRelease(user, target, { commitSha: commit_sha, reason });
        return { release_id: release.id, admin_exception: release.admin_exception };
      }),
  );

  server.registerTool(
    "finish_release",
    { description: "Close a release opened with begin_release", inputSchema: t.finish_release },
    ({ release_id, status, error }) =>
      run(async () => {
        const release = await releaseForUser(user, release_id);
        await appForUser(user, release.slug).catch(() => {
          throw new UserError("release not found");
        });
        if (release.source !== "direct") throw new UserError("a CI release is finished by its CI run");
        return finishRelease(user.id, release, status, error);
      }),
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
    "list_members",
    { description: "Members of the app (platform accounts) and their role: owner or collaborator", inputSchema: t.list_members },
    ({ app }) => run(async () => listMembers(await appForUser(user, app))),
  );

  server.registerTool(
    "add_member",
    {
      description: "Add a platform user to the app, or change their role (owner or admin only). The account must " +
        "already exist on the platform: only an admin can create it.",
      inputSchema: t.add_member,
    },
    ({ app, email, role }) =>
      run(async () => {
        const target = await appForUser(user, app);
        requireOwner(user, target, "manage members");
        return addMember(user, target, email, role ?? "collaborator");
      }),
  );

  server.registerTool(
    "remove_member",
    { description: "Remove a member from the app (owner or admin only). The last owner cannot be removed.", inputSchema: t.remove_member },
    ({ app, email }) =>
      run(async () => {
        const target = await appForUser(user, app);
        requireOwner(user, target, "manage members");
        return removeMember(user, target, email);
      }),
  );

  server.registerTool(
    "list_auth_users",
    {
      description: "Users of the app itself (its Auth/GoTrue accounts, not platform members), newest first: email, " +
        "id, created_at, last_sign_in_at, invited_at, confirmed, banned. Any member of the app. Also works on a " +
        "stopped app (read from the database).",
      inputSchema: t.list_auth_users,
    },
    ({ app, page, per_page, filter }) =>
      run(async () =>
        listAuthUsers(await appForUser(user, app), { page: page ?? 1, perPage: per_page ?? 50, filter })
      ),
  );

  server.registerTool(
    "invite_user",
    {
      description: "Invite a person to the app (any member, audited): creates their app account and returns a " +
        "single-use invite_link valid 24 h. No email is sent (no SMTP yet): give the link to the person privately, " +
        "never paste it in a public place. Refused on a stopped app.",
      inputSchema: t.invite_user,
    },
    ({ app, email }) => run(async () => inviteUser(user, await appForUser(user, app), email)),
  );

  server.registerTool(
    "delete_user",
    {
      description: "Permanently delete a user of the app (any member, audited), by user_id or email. Rows of the " +
        "app's tables that reference auth.users follow their foreign keys (cascade, set null or an error). Only " +
        "with the user's explicit consent. Refused on a stopped app.",
      inputSchema: t.delete_user,
    },
    ({ app, user_id, email }) => run(async () => deleteUser(user, await appForUser(user, app), { user_id, email })),
  );

  server.registerTool(
    "ban_user",
    {
      description: "Block a user of the app (any member, audited), by user_id or email: they can no longer sign in " +
        "nor refresh their session. Indefinitely unless duration_hours. Refused on a stopped app.",
      inputSchema: t.ban_user,
    },
    ({ app, user_id, email, duration_hours }) =>
      run(async () =>
        setBan(user, await appForUser(user, app), { user_id, email }, duration_hours ?? BAN_FOREVER_HOURS)
      ),
  );

  server.registerTool(
    "unban_user",
    {
      description: "Unblock a user of the app banned with ban_user (any member, audited). Refused on a stopped app.",
      inputSchema: t.unban_user,
    },
    ({ app, user_id, email }) => run(async () => setBan(user, await appForUser(user, app), { user_id, email }, null)),
  );

  server.registerTool(
    "link_repo",
    {
      description: "Link the app to its GitHub repository (owner or admin only, audited). CI deployments are then " +
        "accepted only from this repository (by its numeric id, stable across renames), from its default branch " +
        "when protected, through a workflow allowed by the platform admin.",
      inputSchema: t.link_repo,
    },
    ({ app, repo, repository_id, default_branch }) =>
      run(async () => {
        const target = await appForUser(user, app);
        requireOwner(user, target, "link the repository");
        return linkRepo(user, target, repo, repository_id, default_branch);
      }),
  );

  server.registerTool(
    "stop_app",
    {
      description: "Stop the app (owner or admin only): its Auth and REST containers are stopped, functions no longer " +
        "run and every URL of the app answers 503 with a maintenance page. The app becomes read-only: its database " +
        "can still be read (Studio, execute_sql, migrations dry_run, logs), but writes, migrations, secrets, " +
        "deployments, rollbacks and releases are refused (APP_STOPPED) until start_app.",
      inputSchema: t.stop_app,
    },
    ({ app }) =>
      run(async () => {
        const target = await appForUser(user, app);
        requireOwner(user, target, "stop the app");
        return stopApp(user, target);
      }),
  );

  server.registerTool(
    "start_app",
    {
      description: "Restart a stopped app (owner or admin only), make it writable again and restore its routes",
      inputSchema: t.start_app,
    },
    ({ app }) =>
      run(async () => {
        const target = await appForUser(user, app);
        requireOwner(user, target, "start the app");
        return startApp(user, target);
      }),
  );

  server.registerTool(
    "delete_app",
    {
      description: "Irreversibly delete the app (owner or admin only): database, users, files, functions, secrets, " +
        "deployments and members. A final backup (database dump and deployed files, kept on the platform host) is " +
        "taken first and its path returned; if it fails, nothing is deleted. backup: false skips that backup: the " +
        "data is then lost for good, with no way to restore it (only when the user explicitly asks for it). Only " +
        "with the user's explicit consent; confirm must repeat the slug.",
      inputSchema: t.delete_app,
    },
    ({ app, confirm, backup }) =>
      run(async () => {
        const target = await appForUser(user, app);
        requireOwner(user, target, "delete the app");
        return deleteAppConfirmed(user, target, confirm, backup);
      }),
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
