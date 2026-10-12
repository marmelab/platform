import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appDatabaseSql,
  appLoginRoles,
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
import { takeBackup } from "./backups.ts";
import { appUrl, config, internalAppUrl } from "./config.ts";
import { decrypt, encrypt, randomHex, signJwt } from "./crypto.ts";
import { many, one, platform, runAll, withAdmin, withClient } from "./db.ts";
import { currentTarget, switchCurrent, writeFileAtomic } from "./fsutil.ts";
import { DockerOrchestrator, type Orchestrator } from "./orchestrator.ts";
import { CaddyRouter, type Router } from "./router.ts";
import { lastRelease } from "./releases.ts";
import { MultiHeadStudio, type StudioRegistry } from "./studio/registry.ts";
import { deleteRealtime, deleteStorage, disconnectRealtime, registerRealtime, registerStorage } from "./storage-realtime.ts";
import { killPoolerDatabase, poolerUrl, syncPooler } from "./pooler.ts";
import { unwatchSchema, watchSchema } from "./pgrst-relay.ts";
import { authConfig, authEnv, ensureAuthHook, policyApp } from "./app-auth.ts";
import { ensureCompanySso } from "./app-sso.ts";
import { getSettings } from "./settings.ts";
import type { EnsureResult, ServiceSpec } from "./orchestrator.ts";

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
  /** Last restore from a backup (A4); null if never restored. */
  restored_at: Date | null;
}

export interface AppSecrets {
  jwt_secret: string;
  anon_key: string;
  service_role_key: string;
  /** storageAdmin and realtime: added by M5, generated on the next provisioning for older apps (ensurePasswords). */
  passwords: { authenticator: string; authAdmin: string; owner: string; storageAdmin: string; realtime: string };
}

export const dbId = (slug: string) => slug.replace(/-/g, "_");
export const appSecrets = (app: AppRow): AppSecrets => JSON.parse(decrypt(app.secrets_enc));
export const containerName = (slug: string, service: "auth" | "rest") => `${config.docker.prefix}-${slug}-${service}`;

export function generateSecrets(slug: string): AppSecrets {
  const jwtSecret = randomHex(32);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 3600;
  return {
    jwt_secret: jwtSecret,
    anon_key: signJwt({ iss: "supabase", ref: slug, role: "anon", iat, exp }, jwtSecret),
    service_role_key: signJwt({ iss: "supabase", ref: slug, role: "service_role", iat, exp }, jwtSecret),
    passwords: {
      authenticator: randomHex(16),
      authAdmin: randomHex(16),
      owner: randomHex(16),
      storageAdmin: randomHex(16),
      realtime: randomHex(16),
    },
  };
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
}

/** Resolves an app the user may access. Unknown and forbidden apps look the same. */
/**
 * The app if the user is a member (or an admin), and if the request's credential reaches it: a token restricted to
 * some apps (a deploy token, SEC-8) sees no other app.
 */
export async function appForUser(user: User, slug: string): Promise<AppRow & { member_role: string }> {
  const app = await one<AppRow & { member_role: string }>(
    `select a.*, coalesce(m.role, 'admin') as member_role
       from apps a left join app_members m on m.app_id = a.id and m.user_id = $2
      where a.slug = $1 and a.status <> 'deleted' and (m.user_id is not null or $3)
        and ($4::uuid[] is null or a.id = any($4))`,
    [slug, user.id, user.role === "admin", user.token?.appIds ?? null],
  );
  if (!app) throw new UserError(`app "${slug}" not found`);
  return app;
}

export async function appsForUser(user: User) {
  return many<AppRow & { member_role: string }>(
    `select a.*, coalesce(m.role, 'admin') as member_role
       from apps a left join app_members m on m.app_id = a.id and m.user_id = $1
      where a.status <> 'deleted' and (m.user_id is not null or $2) and ($3::uuid[] is null or a.id = any($3))
      order by a.slug`,
    [user.id, user.role === "admin", user.token?.appIds ?? null],
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

export async function waitHealthy(url: string, timeoutMs = 60_000) {
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

/**
 * The app's GoTrue: database, JWT and API settings, plus the auth policy and the platform SMTP (app-auth.ts). Any change
 * of this spec (configure_auth, SMTP settings, an upgrade) recreates the container (orchestrator.ensure).
 */
async function authServiceSpec(app: AppRow, secrets: AppSecrets): Promise<ServiceSpec> {
  const roles = appRoles(dbId(app.slug));
  const publicUrl = appUrl(app.slug);
  const [auth, { smtp }] = await Promise.all([authConfig(app), getSettings()]);
  // the hook function must exist before GoTrue starts with it enabled
  if (auth.allowed_email_domains.length > 0) await ensureAuthHook(app, auth);
  return {
    name: containerName(app.slug, "auth"),
    image: config.docker.gotrueImage,
    app: app.slug,
    service: "gotrue",
    memoryMb: 256,
    cmd: ["auth"],
    health: { port: 9999, path: "/health" },
    env: {
      GOTRUE_API_HOST: "0.0.0.0",
      GOTRUE_API_PORT: "9999",
      API_EXTERNAL_URL: `${publicUrl}/auth/v1`,
      GOTRUE_DB_DRIVER: "postgres",
      GOTRUE_DB_DATABASE_URL:
        `postgres://${roles.authAdmin}:${secrets.passwords.authAdmin}@${config.pg.host}:${config.pg.port}/${roles.database}?sslmode=disable`,
      GOTRUE_DB_MAX_POOL_SIZE: "3",
      GOTRUE_JWT_ADMIN_ROLES: "service_role",
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
      GOTRUE_JWT_EXP: "3600",
      GOTRUE_JWT_ISSUER: `${publicUrl}/auth/v1`,
      GOTRUE_JWT_SECRET: secrets.jwt_secret,
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false",
      GOTRUE_EXTERNAL_PHONE_ENABLED: "false",
      // site URL, redirect allow list, sign-up, confirmation, SMTP, link paths, allowed domains hook
      ...authEnv(policyApp(app), auth, smtp),
      // local installs only (config.ssoTest): trust the mock IdP's CA besides the system ones
      ...(config.ssoTest.caVolume ? { SSL_CERT_DIR: `/etc/ssl/certs:${SSO_TEST_CA_DIR}` } : {}),
    },
    ...(config.ssoTest.network ? { networks: [config.ssoTest.network] } : {}),
    ...(config.ssoTest.caVolume ? { volumes: [{ source: config.ssoTest.caVolume, target: SSO_TEST_CA_DIR }] } : {}),
  };
}

/** Where the mock IdP's CA is mounted in the apps' GoTrue on local installs (config.ssoTest). */
const SSO_TEST_CA_DIR = "/etc/platform-test-ca";

/** Recreates the app's GoTrue if its environment changed (configure_auth, SMTP settings), and waits for it. */
export async function ensureAuthService(app: AppRow) {
  await ensureService(await authServiceSpec(app, appSecrets(app)));
  await waitHealthy(`http://${containerName(app.slug, "auth")}:9999/health`);
}

/**
 * orchestrator.ensure() under a cluster-wide advisory lock per container: the server's startup sync, a configure_auth
 * call and the upgrade's `recycle-apps` (another process) never recreate the same container at the same time.
 */
export async function ensureService(spec: ServiceSpec, options: { force?: boolean } = {}): Promise<EnsureResult> {
  return withClient({ database: config.pg.platformDb, applicationName: "control-plane-ensure" }, async (c) => {
    await c.query("select pg_advisory_lock(hashtext($1))", [`container:${spec.name}`]);
    try {
      return await orchestrator.ensure(spec, options);
    } finally {
      await c.query("select pg_advisory_unlock(hashtext($1))", [`container:${spec.name}`]).catch(() => {});
    }
  });
}

function restServiceSpec(app: AppRow, secrets: AppSecrets): ServiceSpec {
  const slug = app.slug;
  const roles = appRoles(dbId(slug));
  return {
    name: containerName(slug, "rest"),
    image: config.docker.postgrestImage,
    app: slug,
    service: "postgrest",
    memoryMb: 256,
    // the admin server's readiness: connected, schema cache loaded
    health: { port: 3001, path: "/ready" },
    env: {
      // through the pooler in transaction mode (README.md, "Connection pooler"): no prepared statements, and no LISTEN
      // channel: the control plane relays the "pgrst" notifications as signals (pgrst-relay.ts)
      PGRST_DB_URI: poolerUrl(roles.authenticator, secrets.passwords.authenticator, roles.database),
      PGRST_DB_PREPARED_STATEMENTS: "false",
      PGRST_DB_CHANNEL_ENABLED: "false",
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
  };
}

async function startServices(app: AppRow, secrets: AppSecrets, options: { force?: boolean } = {}) {
  const auth = await ensureService(await authServiceSpec(app, secrets), options);
  const rest = await ensureService(restServiceSpec(app, secrets), options);
  return { auth, rest };
}

/**
 * A8, platform upgrade: recreates the GoTrue and PostgREST containers of every running app (or the given slugs), one
 * app at a time, each container replaced only once its successor is ready (orchestrator.replace: no downtime). Only
 * the containers whose spec or image changed, unless `force`. Then the steps that a new GoTrue or Storage may need:
 * GoTrue's migrations ran at its start; Studio's `platform_owner_read` policies on auth.users and auth.identities are
 * re-applied (PG-4), Storage's tenant migrations re-run, the edge config rewritten.
 */
export async function recycleApps({ only, force = false }: { only?: string[]; force?: boolean } = {}) {
  const apps = await many<AppRow>(
    "select * from apps where status = 'running' and ($1::text[] is null or slug = any($1)) order by slug",
    [only ?? null],
  );
  const results: { app: string; auth?: EnsureResult; rest?: EnsureResult; ms: number; error?: string }[] = [];
  for (const app of apps) {
    const started = Date.now();
    try {
      await ensurePasswords(app);
      const secrets = appSecrets(app);
      const { auth, rest } = await startServices(app, secrets, { force });
      await waitHealthy(`http://${containerName(app.slug, "auth")}:9999/health`);
      await waitHealthy(`http://${containerName(app.slug, "rest")}:3001/ready`);
      await studio.register(app);
      await registerStorage(app);
      await writeEdgeConfig(app);
      results.push({ app: app.slug, auth, rest, ms: Date.now() - started });
    } catch (error) {
      results.push({ app: app.slug, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
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

/** Apps created before M5 have no Storage and Realtime role passwords: generate and store them. */
async function ensurePasswords(app: AppRow) {
  const secrets = appSecrets(app);
  const missing = (["storageAdmin", "realtime"] as const).filter((key) => !secrets.passwords[key]);
  if (missing.length === 0) return;
  for (const key of missing) secrets.passwords[key] = randomHex(16);
  app.secrets_enc = encrypt(JSON.stringify(secrets));
  await platform.query("update apps set secrets_enc = $2, updated_at = now() where id = $1", [app.id, app.secrets_enc]);
}

/** Runs every provisioning step (PLAN §4.2). Each step is idempotent. */
export async function provision(app: AppRow) {
  try {
    await ensurePasswords(app);
    const secrets = appSecrets(app);
    await provisionDatabase(app.slug, secrets);
    await syncPooler();
    await startServices(app, secrets);
    await prepareDirectories(app.slug);
    await writeEdgeConfig(app);
    await router.upsertApp(app.slug);
    await waitHealthy(`http://${containerName(app.slug, "auth")}:9999/health`);
    await waitHealthy(`http://${containerName(app.slug, "rest")}:3000/`);
    // company SSO (U2): an unreachable IdP must not prevent the app from starting
    await ensureCompanySso(app).catch((error) => console.error(`company SSO of ${app.slug} failed`, error));
    // after GoTrue's migrations: Storage's and Realtime's run in the same database
    await registerStorage(app);
    await registerRealtime(app);
    await studio.register(app);
    watchSchema(app.slug);
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
  await router.ensureAccessLog({
    file: config.accessLog.caddyPath,
    skipHosts: [config.apiHost, config.adminHost, config.studio.host],
  }).catch((error) => console.error("access log setup failed", error));
  const apps = await many<AppRow>("select * from apps where status in ('running', 'error', 'stopped')");
  // the pooler may still be starting: its entries file is written anyway (read when it starts)
  await syncPooler().catch((error) => console.error("pooler sync failed", error));
  for (const app of apps) {
    try {
      await prepareDirectories(app.slug);
      await writeEdgeConfig(app);
      await ensureSchemaChanges(app.slug);
      // apps stopped before B8 made them read-only, or a stop/start interrupted half-way
      await setDatabaseReadOnly(app.slug, app.status === "stopped");
      if (app.status === "stopped") {
        await router.maintenanceApp(app.slug);
        continue;
      }
      await router.upsertApp(app.slug);
      if (app.status === "running") watchSchema(app.slug);
    } catch (error) {
      console.error(`sync ${app.slug} failed`, error);
    }
  }
  await studio.syncAll(apps).catch((error) => console.error("studio sync failed", error));
  // Storage and Realtime tenants (apps created before M5, a reset service): in the background, since both services
  // may still be starting (they wait for the databases created by initCluster)
  void syncServiceTenants(apps.filter((app) => app.status === "running"));
  await router.upsertAdmin({ host: config.adminHost, upstream: `control-plane:${config.port}` })
    .catch((error) => console.error("admin route failed", error));
}

/**
 * After a change of the platform SMTP settings (CLI set-setting smtp_*): every running app's GoTrue gets the new
 * environment, one app at a time (each is recreated, a few seconds without /auth/v1). Stopped apps get it at start.
 */
export async function syncAuthServices() {
  const apps = await many<AppRow>("select * from apps where status = 'running' order by slug");
  const failed: string[] = [];
  for (const app of apps) {
    try {
      await ensureAuthService(app);
    } catch (error) {
      console.error(`auth service of ${app.slug} failed`, error);
      failed.push(app.slug);
    }
  }
  return { apps: apps.length, failed };
}

async function syncServiceTenants(apps: AppRow[], attempts = 30) {
  let pending = apps;
  for (let attempt = 1; pending.length > 0 && attempt <= attempts; attempt++) {
    const failed: AppRow[] = [];
    for (const app of pending) {
      try {
        await ensurePasswords(app);
        await provisionDatabase(app.slug, appSecrets(app));
        // containers whose settings changed (apps created before the pooler): recreated, as in provision()
        await startServices(app, appSecrets(app));
        await waitHealthy(`http://${containerName(app.slug, "auth")}:9999/health`);
        await ensureCompanySso(app).catch((error) => console.error(`company SSO of ${app.slug} failed`, error));
        await registerStorage(app);
        await registerRealtime(app);
      } catch (error) {
        if (attempt === attempts) console.error(`storage/realtime tenant of ${app.slug} failed`, error);
        failed.push(app);
      }
    }
    pending = failed;
    if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
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
 * B8: database-level `default_transaction_read_only` for a stopped app. Idempotent. When it changes (or with
 * `terminate`), the sessions of the app's own roles are terminated so that their next session gets the setting:
 * this includes the pooler's server connections (same roles), which it opens again on demand.
 */
export async function setDatabaseReadOnly(slug: string, readOnly: boolean, terminate = false) {
  const id = dbId(slug);
  const roles = appRoles(id);
  await withAdmin("postgres", async (c) => {
    if ((await c.query(databaseExistsSql, [roles.database])).rowCount !== 1) return;
    const current = (await c.query(databaseIsReadOnlySql, [roles.database])).rowCount === 1;
    if (current !== readOnly) await c.query(databaseReadOnlySql(id, readOnly));
    if (terminate || current !== readOnly) {
      await c.query(terminateAppSessionsSql, [roles.database, appLoginRoles(roles)]);
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
  await router.maintenanceApp(app.slug);
  await orchestrator.stopApp(app.slug);
  await unwatchSchema(app.slug);
  // open websockets survive the route change: close them (clients that reconnect get the maintenance response)
  await disconnectRealtime(app.slug).catch((error) => console.error(`realtime disconnect of ${app.slug} failed`, error));
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
 * (backups.ts, kind "final"); if it fails, nothing is deleted. `backup: false` skips it (the data is then lost for
 * good). Audited, with the backup's location and id, or `backup: null` and `backup_skipped: true` (audit_log.app_id
 * becomes null when the row goes away: the slug stays in the details).
 */
export async function deleteApp(actor: User | null, slug: string, { backup: withBackup = true } = {}) {
  const app = (await one<AppRow>("select * from apps where slug = $1", [slug])) ?? null;
  let backup: Awaited<ReturnType<typeof takeBackup>> = null;
  if (withBackup) {
    try {
      backup = await takeBackup(slug, "final", { actor, app });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}: nothing was deleted`);
    }
  }
  await audit(actor?.id ?? null, app?.id ?? null, "delete_app", {
    slug,
    status: app?.status ?? null,
    backup: backup?.location ?? null,
    backup_id: backup?.id ?? null,
    backup_files: backup?.files ?? null,
    backup_skipped: !withBackup,
  });
  await router.removeApp(slug);
  await studio.unregister(slug);
  await orchestrator.removeApp(slug);
  await unwatchSchema(slug);
  // the Realtime tenant first: its replication slot is dropped through the app database
  await deleteRealtime(slug);
  await deleteStorage(slug);
  // Storage's pooled connections (and any other): closed before DROP DATABASE; the entry goes with the row below
  await killPoolerDatabase(slug);
  await withAdmin("postgres", (c) => runAll(c, dropAppSql(dbId(slug))));
  await rm(join(config.dataDir.appsConfig, `${slug}.json`), { force: true });
  await rm(join(config.dataDir.sites, slug), { recursive: true, force: true });
  await rm(join(config.dataDir.functions, slug), { recursive: true, force: true });
  await platform.query("delete from apps where slug = $1", [slug]);
  // the app's pooler entry goes (an unreachable pooler gets it at its next sync)
  await syncPooler().catch((error) => console.error("pooler sync failed", error));
  return { slug, deleted: true, backup: backup?.location ?? null, backup_id: backup?.id ?? null, backup_skipped: !withBackup };
}

/** B8 through MCP: destructive, so the caller must repeat the slug. */
export async function deleteAppConfirmed(user: User, app: AppRow, confirm: string, backup = true) {
  if (confirm !== app.slug) {
    throw new UserError(`deleting "${app.slug}" is irreversible: pass confirm="${app.slug}" with the user's explicit consent`);
  }
  return deleteApp(user, app.slug, { backup });
}
