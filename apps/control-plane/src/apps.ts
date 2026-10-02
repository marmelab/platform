import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appDatabaseSql,
  appRoles,
  clusterRolesSql,
  createDatabaseSql,
  databaseExistsSql,
  databaseGrantsSql,
  databaseIsReadOnlySql,
  databaseReadOnlySql,
  dropAppSql,
  schemaChangesSql,
  terminateAppSessionsSql,
} from "@platform/sql";
import { type AppInfo, SLUG_RE } from "@platform/shared";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { backupApp } from "./backups.ts";
import { appHost, appUrl, config, internalAppUrl } from "./config.ts";
import { decrypt, encrypt, randomHex, signJwt } from "./crypto.ts";
import { many, one, platform, runAll, withAdmin } from "./db.ts";
import { currentTarget, switchCurrent, writeFileAtomic } from "./fsutil.ts";
import { DockerOrchestrator, type Orchestrator } from "./orchestrator.ts";
import { CaddyRouter, type Router } from "./router.ts";
import { lastRelease } from "./releases.ts";
import { MultiHeadStudio, type StudioRegistry } from "./studio/registry.ts";

export const orchestrator: Orchestrator = new DockerOrchestrator();
export const router: Router = new CaddyRouter();
export const studio: StudioRegistry = new MultiHeadStudio(router);

export class UserError extends Error {}

/** A write refused because the app is stopped (B8: a stopped app is read-only). */
export class AppStoppedError extends UserError {
  readonly code = "APP_STOPPED";
}

/**
 * The single guard of every write the control plane makes on behalf of a user or CI: migrations (except dry_run),
 * execute_sql with write, secrets, deployments, rollbacks, releases, repository link. Reads, logs, members,
 * start_app and delete_app stay available on a stopped app.
 */
export function requireWritable(app: Pick<AppRow, "slug" | "status">, action: string) {
  if (app.status === "stopped") {
    throw new AppStoppedError(
      `APP_STOPPED: app "${app.slug}" is stopped and read-only, ${action} is refused. An owner or an admin must ` +
        "start_app first.",
    );
  }
}

export interface AppRow {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  status: string;
  db_name: string;
  secrets_enc: string;
  error: string | null;
  github_repo: string | null;
  /** bigint: returned as a string by pg. */
  github_repo_id: string | null;
  default_branch: string | null;
  created_at: Date;
}

export interface AppSecrets {
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
  passwords: { authenticator: string; authAdmin: string; owner: string };
}

export const dbId = (slug: string) => slug.replace(/-/g, "_");
export const appSecrets = (app: AppRow): AppSecrets => JSON.parse(decrypt(app.secrets_enc));
export const containerName = (slug: string, service: "auth" | "rest") => `${config.docker.prefix}-${slug}-${service}`;

function generateSecrets(slug: string): AppSecrets {
  const jwtSecret = randomHex(32);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 3600;
  return {
    jwt_secret: jwtSecret,
    anon_key: signJwt({ iss: "supabase", ref: slug, role: "anon", iat, exp }, jwtSecret),
    service_role_key: signJwt({ iss: "supabase", ref: slug, role: "service_role", iat, exp }, jwtSecret),
    passwords: { authenticator: randomHex(16), authAdmin: randomHex(16), owner: randomHex(16) },
  };
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
}

/** Resolves an app the user may access. Unknown and forbidden apps look the same. */
export async function appForUser(user: User, slug: string): Promise<AppRow & { member_role: string }> {
  const app = await one<AppRow & { member_role: string }>(
    `select a.*, coalesce(m.role, 'admin') as member_role
       from apps a left join app_members m on m.app_id = a.id and m.user_id = $2
      where a.slug = $1 and a.status <> 'deleted' and (m.user_id is not null or $3)`,
    [slug, user.id, user.role === "admin"],
  );
  if (!app) throw new UserError(`app "${slug}" not found`);
  return app;
}

export async function appsForUser(user: User) {
  return many<AppRow & { member_role: string }>(
    `select a.*, coalesce(m.role, 'admin') as member_role
       from apps a left join app_members m on m.app_id = a.id and m.user_id = $1
      where a.status <> 'deleted' and (m.user_id is not null or $2)
      order by a.slug`,
    [user.id, user.role === "admin"],
  );
}

export async function appInfo(app: AppRow & { member_role: string }): Promise<AppInfo> {
  const versions = await many<{ kind: string; version: number }>(
    "select kind, version from deployments where app_id = $1 and status = 'live'",
    [app.id],
  );
  const live = (kind: string) => versions.find((v) => v.kind === kind)?.version ?? null;
  return {
    slug: app.slug,
    name: app.name,
    status: app.status,
    url: appUrl(app.slug),
    supabase_url: appUrl(app.slug),
    anon_key: appSecrets(app).anon_key,
    role: app.member_role,
    frontend_version: live("frontend"),
    functions_version: live("functions"),
    studio_url: studio.deepLink(app.slug),
    github_repo: app.github_repo,
    github_repo_id: app.github_repo_id === null ? null : Number(app.github_repo_id),
    default_branch: app.default_branch,
    last_release: await lastRelease(app),
    created_at: app.created_at.toISOString(),
  };
}

/** /config/apps/<slug>.json read by the edge main worker (format defined in M1). */
export async function writeEdgeConfig(app: AppRow) {
  const secrets = appSecrets(app);
  const roles = appRoles(dbId(app.slug));
  const userSecrets = await many<{ name: string; value_enc: string }>(
    "select name, value_enc from app_secrets where app_id = $1 order by name",
    [app.id],
  );
  const env: Record<string, string> = {};
  for (const s of userSecrets) env[s.name] = decrypt(s.value_enc);
  Object.assign(env, {
    SUPABASE_URL: internalAppUrl(app.slug),
    SUPABASE_PUBLIC_URL: appUrl(app.slug),
    SUPABASE_ANON_KEY: secrets.anon_key,
    SUPABASE_SERVICE_ROLE_KEY: secrets.service_role_key,
    SUPABASE_DB_URL:
      `postgresql://${roles.owner}:${secrets.passwords.owner}@${config.pg.host}:${config.pg.port}/${roles.database}`,
  });
  await writeFileAtomic(
    join(config.dataDir.appsConfig, `${app.slug}.json`),
    JSON.stringify({ app: app.slug, jwt_secret: secrets.jwt_secret, env }, null, 2),
    0o644,
  );
}

async function waitHealthy(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} not healthy: ${last}`);
}

async function provisionDatabase(slug: string, secrets: AppSecrets) {
  const id = dbId(slug);
  const roles = appRoles(id);
  await withAdmin("postgres", async (c) => {
    await runAll(c, clusterRolesSql(id, secrets.passwords));
    const exists = (await c.query(databaseExistsSql, [roles.database])).rowCount === 1;
    if (!exists) await c.query(createDatabaseSql(id));
    await runAll(c, databaseGrantsSql(id));
  });
  await withAdmin(roles.database, async (c) => {
    await runAll(c, appDatabaseSql(id));
    await c.query(schemaChangesSql());
  });
}

/** DDL event trigger (PLAN_1 §7) for apps created before it was in the template. Idempotent. */
async function ensureSchemaChanges(slug: string) {
  const roles = appRoles(dbId(slug));
  const exists = await withAdmin("postgres", async (c) => (await c.query(databaseExistsSql, [roles.database])).rowCount === 1);
  if (exists) await withAdmin(roles.database, (c) => c.query(schemaChangesSql()));
}

async function startServices(slug: string, secrets: AppSecrets) {
  const roles = appRoles(dbId(slug));
  const publicUrl = appUrl(slug);
  const dbUrl = (user: string, password: string) =>
    `postgres://${user}:${password}@${config.pg.host}:${config.pg.port}/${roles.database}`;
  await orchestrator.ensure({
    name: containerName(slug, "auth"),
    image: config.docker.gotrueImage,
    app: slug,
    service: "gotrue",
    memoryMb: 256,
    cmd: ["auth"],
    env: {
      GOTRUE_API_HOST: "0.0.0.0",
      GOTRUE_API_PORT: "9999",
      API_EXTERNAL_URL: `${publicUrl}/auth/v1`,
      GOTRUE_DB_DRIVER: "postgres",
      GOTRUE_DB_DATABASE_URL: `${dbUrl(roles.authAdmin, secrets.passwords.authAdmin)}?sslmode=disable`,
      GOTRUE_DB_MAX_POOL_SIZE: "3",
      GOTRUE_SITE_URL: publicUrl,
      GOTRUE_URI_ALLOW_LIST: `${publicUrl}/**`,
      GOTRUE_DISABLE_SIGNUP: "false",
      GOTRUE_JWT_ADMIN_ROLES: "service_role",
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
      GOTRUE_JWT_EXP: "3600",
      GOTRUE_JWT_ISSUER: `${publicUrl}/auth/v1`,
      GOTRUE_JWT_SECRET: secrets.jwt_secret,
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
      GOTRUE_MAILER_AUTOCONFIRM: "true",
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false",
      GOTRUE_EXTERNAL_PHONE_ENABLED: "false",
    },
  });
  await orchestrator.ensure({
    name: containerName(slug, "rest"),
    image: config.docker.postgrestImage,
    app: slug,
    service: "postgrest",
    memoryMb: 256,
    env: {
      PGRST_DB_URI: dbUrl(roles.authenticator, secrets.passwords.authenticator),
      PGRST_DB_SCHEMAS: "public,graphql_public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_DB_POOL: "3",
      PGRST_DB_USE_LEGACY_GUCS: "false",
      PGRST_JWT_SECRET: secrets.jwt_secret,
      PGRST_APP_SETTINGS_JWT_SECRET: secrets.jwt_secret,
      PGRST_APP_SETTINGS_JWT_EXP: "3600",
      PGRST_ADMIN_SERVER_PORT: "3001",
      GHCRTS: "-N2",
    },
  });
}

async function prepareDirectories(slug: string) {
  const sites = join(config.dataDir.sites, slug);
  if (!(await currentTarget(sites))) {
    await mkdir(join(sites, "v0"), { recursive: true });
    await writeFile(
      join(sites, "v0", "index.html"),
      `<!doctype html><meta charset="utf-8"><title>${slug}</title><h1>${slug}</h1><p>Nothing deployed yet.</p>\n`,
    );
    await switchCurrent(sites, "v0");
  }
  await mkdir(join(config.dataDir.functions, slug), { recursive: true });
}

/** Runs every provisioning step (PLAN §4.2, without Storage/Realtime/Studio). Each step is idempotent. */
export async function provision(app: AppRow) {
  const secrets = appSecrets(app);
  try {
    await provisionDatabase(app.slug, secrets);
    await startServices(app.slug, secrets);
    await prepareDirectories(app.slug);
    await writeEdgeConfig(app);
    await router.upsertApp({
      slug: app.slug,
      host: appHost(app.slug),
      gotrue: `${containerName(app.slug, "auth")}:9999`,
      postgrest: `${containerName(app.slug, "rest")}:3000`,
    });
    await waitHealthy(`http://${containerName(app.slug, "auth")}:9999/health`);
    await waitHealthy(`http://${containerName(app.slug, "rest")}:3000/`);
    await studio.register(app);
    await platform.query("update apps set status = 'running', error = null, updated_at = now() where id = $1", [app.id]);
  } catch (error) {
    await platform.query("update apps set status = 'error', error = $2, updated_at = now() where id = $1", [
      app.id,
      String(error),
    ]);
    throw error;
  }
}

export async function createApp(user: User, name: string, requestedSlug?: string) {
  const slug = requestedSlug ?? slugify(name);
  if (!SLUG_RE.test(slug) || ["api", "admin", "studio", "www", "default"].includes(slug)) {
    throw new UserError(`invalid slug "${slug}": provide a slug matching ${SLUG_RE}`);
  }
  let app = await one<AppRow>("select * from apps where slug = $1", [slug]);
  if (app) {
    const allowed = user.role === "admin" || app.owner_id === user.id;
    if (!allowed) throw new UserError(`slug "${slug}" is already taken`);
  } else {
    app = await one<AppRow>(
      `insert into apps (slug, name, owner_id, db_name, secrets_enc) values ($1, $2, $3, $4, $5)
       on conflict (slug) do nothing returning *`,
      [slug, name, user.id, appRoles(dbId(slug)).database, encrypt(JSON.stringify(generateSecrets(slug)))],
    );
    if (!app) throw new UserError(`slug "${slug}" is already taken`);
    await platform.query("insert into app_members (app_id, user_id, role) values ($1, $2, 'owner')", [
      app.id,
      user.id,
    ]);
  }
  if (app.status === "stopped") throw new UserError(`app "${slug}" is stopped: use start_app`);
  const started = Date.now();
  await provision(app);
  await audit(user.id, app.id, "create_app", { slug, ms: Date.now() - started });
  return appInfo(await appForUser(user, slug));
}

/** Re-applies routes and edge configs for every app (Caddy restarted, volumes recreated...). */
export async function syncAll() {
  const apps = await many<AppRow>("select * from apps where status in ('running', 'error', 'stopped')");
  for (const app of apps) {
    try {
      await prepareDirectories(app.slug);
      await writeEdgeConfig(app);
      await ensureSchemaChanges(app.slug);
      // apps stopped before B8 made them read-only, or a stop/start interrupted half-way
      await setDatabaseReadOnly(app.slug, app.status === "stopped");
      if (app.status === "stopped") {
        await router.maintenanceApp(app.slug, appHost(app.slug));
        continue;
      }
      await router.upsertApp({
        slug: app.slug,
        host: appHost(app.slug),
        gotrue: `${containerName(app.slug, "auth")}:9999`,
        postgrest: `${containerName(app.slug, "rest")}:3000`,
      });
    } catch (error) {
      console.error(`sync ${app.slug} failed`, error);
    }
  }
  await studio.syncAll(apps).catch((error) => console.error("studio sync failed", error));
}

/** Links the app to its GitHub repository (owner or admin, checked by the caller). Audited. */
export async function linkRepo(actor: User, app: AppRow, repo: string, repositoryId: number, defaultBranch: string) {
  requireWritable(app, "link_repo");
  await platform.query(
    "update apps set github_repo = $2, github_repo_id = $3, default_branch = $4, updated_at = now() where id = $1",
    [app.id, repo, repositoryId, defaultBranch],
  );
  await audit(actor.id, app.id, "link_repo", {
    from: app.github_repo_id === null
      ? null
      : { repo: app.github_repo, repository_id: Number(app.github_repo_id), default_branch: app.default_branch },
    to: { repo, repository_id: repositoryId, default_branch: defaultBranch },
  });
  return { slug: app.slug, github_repo: repo, github_repo_id: repositoryId, default_branch: defaultBranch };
}

export async function pathExists(path: string) {
  return stat(path).then(() => true, () => false);
}

/**
 * B8: database-level `default_transaction_read_only` for a stopped app. Idempotent. When it turns on (or with
 * `terminate`), the sessions of the app's own roles are terminated so that their next session gets the setting.
 */
export async function setDatabaseReadOnly(slug: string, readOnly: boolean, terminate = false) {
  const id = dbId(slug);
  const roles = appRoles(id);
  await withAdmin("postgres", async (c) => {
    if ((await c.query(databaseExistsSql, [roles.database])).rowCount !== 1) return;
    const current = (await c.query(databaseIsReadOnlySql, [roles.database])).rowCount === 1;
    if (current !== readOnly) await c.query(databaseReadOnlySql(id, readOnly));
    if (readOnly && (terminate || !current)) {
      await c.query(terminateAppSessionsSql, [roles.database, [roles.owner, roles.authenticator, roles.authAdmin]]);
    }
  });
}

/**
 * B8: maintenance page first (Caddy then serves no static file, API or function), then containers are stopped and
 * the database becomes read-only (Studio and execute_sql still read it; the control plane refuses writes).
 */
export async function stopApp(actor: User | null, app: AppRow) {
  if (app.status === "stopped") {
    await setDatabaseReadOnly(app.slug, true);
    return { slug: app.slug, status: "stopped", changed: false };
  }
  await router.maintenanceApp(app.slug, appHost(app.slug));
  await orchestrator.stopApp(app.slug);
  await setDatabaseReadOnly(app.slug, true, true);
  await platform.query("update apps set status = 'stopped', updated_at = now() where id = $1", [app.id]);
  await audit(actor?.id ?? null, app.id, "stop_app", { slug: app.slug });
  return { slug: app.slug, status: "stopped", changed: true };
}

/** Reverse of stopApp(): read-write again, then provision() (idempotent) restarts the containers and the routes. */
export async function startApp(actor: User | null, app: AppRow) {
  const changed = app.status !== "running";
  if (changed) {
    await setDatabaseReadOnly(app.slug, false);
    await provision(app);
    await audit(actor?.id ?? null, app.id, "start_app", { slug: app.slug, from: app.status });
  }
  return { slug: app.slug, status: "running", changed };
}

/**
 * Symmetric of provision(): routes, containers, database and roles, files, rows. A final backup is taken first
 * (backups.ts); if it fails, nothing is deleted. `backup: false` skips it (the data is then lost for good). Audited,
 * with the backup path, or `backup: null` and `backup_skipped: true` (audit_log.app_id becomes null when the row goes
 * away: the slug stays in the details).
 */
export async function deleteApp(actor: User | null, slug: string, { backup: withBackup = true } = {}) {
  const app = await one<AppRow>("select * from apps where slug = $1", [slug]);
  const backup = withBackup ? await backupApp(slug, app) : null;
  await audit(actor?.id ?? null, app?.id ?? null, "delete_app", {
    slug,
    status: app?.status ?? null,
    backup: backup?.path ?? null,
    backup_files: backup?.files ?? null,
    backup_skipped: !withBackup,
  });
  await router.removeApp(slug);
  await studio.unregister(slug);
  await orchestrator.removeApp(slug);
  await withAdmin("postgres", (c) => runAll(c, dropAppSql(dbId(slug))));
  await rm(join(config.dataDir.appsConfig, `${slug}.json`), { force: true });
  await rm(join(config.dataDir.sites, slug), { recursive: true, force: true });
  await rm(join(config.dataDir.functions, slug), { recursive: true, force: true });
  await platform.query("delete from apps where slug = $1", [slug]);
  return { slug, deleted: true, backup: backup?.path ?? null, backup_skipped: !withBackup };
}

/** B8 through MCP: destructive, so the caller must repeat the slug. */
export async function deleteAppConfirmed(user: User, app: AppRow, confirm: string, backup = true) {
  if (confirm !== app.slug) {
    throw new UserError(`deleting "${app.slug}" is irreversible: pass confirm="${app.slug}" with the user's explicit consent`);
  }
  return deleteApp(user, app.slug, { backup });
}
