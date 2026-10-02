// Storage and Realtime (M5): one shared multi-tenant instance of each, one tenant per app (tenant id = app slug).
// See spikes/m5-storage-realtime/REPORT.md for the choices made here.
//
// Storage API (supabase/storage-api, IS_MULTITENANT=true): tenants are registered through its admin API
// (`PUT /tenants/<slug>`, internal network only, `apikey` header) with the app's database URL (role
// app_<id>_storage_admin), JWT secret and keys. Registering runs Storage's own migrations in the app database
// (storage.*), as that role. Caddy passes the tenant in X-Forwarded-Host (router.ts). Files live on the shared volume,
// under <dataDir>/<bucket>/<slug>/.
//
// Realtime (supabase/realtime): tenants are registered through its API (`/api/tenants`, internal network only, bearer
// JWT signed with API_JWT_SECRET) with the app's JWT secret and the `postgres_cdc_rls` extension settings (database,
// role app_<id>_realtime, publication supabase_realtime, a slot name per app). Caddy passes the tenant as the first
// label of the Host header (router.ts). Realtime's tenant migrations need a superuser: creating a tenant (which runs
// them synchronously) is done with a short-lived superuser login (platform_realtime_migrator, one-time password,
// locked again right after), then the tenant is switched to the app's own role.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appRoles,
  REALTIME_MIGRATOR_ROLE,
  realtimeDatabaseSql,
  realtimeMigratorSql,
} from "@platform/sql";
import { type AppRow, appSecrets, dbId } from "./apps.ts";
import { config } from "./config.ts";
import { randomHex, signJwt } from "./crypto.ts";
import { runAll, withAdmin } from "./db.ts";

const TIMEOUT = 30_000;

async function call(service: string, url: string, init: RequestInit & { ok?: number[] } = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await response.text();
  const accepted = init.ok ?? [];
  if (!response.ok && !accepted.includes(response.status)) {
    throw new Error(`${service} ${init.method ?? "GET"} ${new URL(url).pathname}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}

const dbUrl = (user: string, password: string, database: string) =>
  `postgres://${user}:${password}@${config.pg.host}:${config.pg.port}/${database}`;

// --- Storage ---

/** The app's files in the shared Storage volume (as mounted in the control plane). */
export const storageFilesDir = (slug: string) => join(config.storage.dataDir, config.storage.bucket, slug);

const storageAdmin = (path: string, init: RequestInit & { ok?: number[] } = {}) =>
  call("storage", `${config.storage.adminUrl}/tenants${path}`, {
    ...init,
    headers: { apikey: config.storage.adminKey, "content-type": "application/json", ...init.headers },
  });

/** Creates or updates the app's Storage tenant; Storage runs its migrations in the app database. Idempotent. */
export async function registerStorage(app: AppRow) {
  const secrets = appSecrets(app);
  const roles = appRoles(dbId(app.slug));
  await storageAdmin(`/${app.slug}`, {
    method: "PUT",
    body: JSON.stringify({
      anonKey: secrets.anon_key,
      serviceKey: secrets.service_role_key,
      jwtSecret: secrets.jwt_secret,
      databaseUrl: dbUrl(roles.storageAdmin, secrets.passwords.storageAdmin, roles.database),
      maxConnections: config.storage.maxConnections,
      fileSizeLimit: config.storage.fileSizeLimit,
      features: { imageTransformation: { enabled: false }, s3Protocol: { enabled: false } },
    }),
  });
  const { body } = await storageAdmin(`/${app.slug}/migrations`);
  const status = (body as { migrationsStatus?: string } | null)?.migrationsStatus;
  if (status !== "COMPLETED") throw new Error(`storage migrations of ${app.slug} not completed: ${JSON.stringify(body)}`);
}

/** Removes the tenant and its files. Idempotent. */
export async function deleteStorage(slug: string) {
  await storageAdmin(`/${slug}`, { method: "DELETE", ok: [404] });
  await rm(storageFilesDir(slug), { recursive: true, force: true });
}

// --- Realtime ---

const realtimeApi = (path: string, init: RequestInit & { ok?: number[] } = {}) => {
  const iat = Math.floor(Date.now() / 1000);
  const token = signJwt({ iss: "platform", role: "service_role", iat, exp: iat + 60 }, config.realtime.apiJwtSecret);
  return call("realtime", `${config.realtime.url}/api/tenants${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
};

function realtimeTenant(app: AppRow, login: { user: string; password: string }) {
  const roles = appRoles(dbId(app.slug));
  return {
    tenant: {
      name: app.slug,
      external_id: app.slug,
      jwt_secret: appSecrets(app).jwt_secret,
      max_concurrent_users: 200,
      extensions: [{
        type: "postgres_cdc_rls",
        settings: {
          db_host: config.pg.host,
          db_port: String(config.pg.port),
          db_name: roles.database,
          db_user: login.user,
          db_password: login.password,
          region: "local",
          publication: "supabase_realtime",
          // replication slots are cluster-wide: one name per app (Realtime appends "_")
          slot_name: `realtime_${dbId(app.slug)}`,
          poll_interval_ms: 100,
          poll_max_record_bytes: 1048576,
          // sic (Realtime's spelling): connections of the postgres_changes subscription pool, 4 by default
          subcriber_pool_size: 1,
          ssl_enforced: false,
        },
      }],
    },
  };
}

/** One tenant creation at a time: the migrator role has a single one-time password. */
let realtimeQueue: Promise<unknown> = Promise.resolve();
const serializedRealtime = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = realtimeQueue.then(fn);
  realtimeQueue = next.catch(() => undefined);
  return next;
};

/**
 * Creates (with its migrations) or updates the app's Realtime tenant. `migrate`: delete and recreate it, to run the
 * migrations of a newer Realtime (connected clients are disconnected and reconnect). Idempotent.
 */
export function registerRealtime(app: AppRow, { migrate = false } = {}) {
  return serializedRealtime(async () => {
    const roles = appRoles(dbId(app.slug));
    if (migrate) await realtimeApi(`/${app.slug}`, { method: "DELETE", ok: [404] });
    const existing = await realtimeApi(`/${app.slug}`, { ok: [404] });
    if (existing.status === 404) {
      const password = randomHex(24);
      await withAdmin("postgres", (c) => runAll(c, realtimeMigratorSql(password)));
      try {
        await realtimeApi("", {
          method: "POST",
          body: JSON.stringify(realtimeTenant(app, { user: REALTIME_MIGRATOR_ROLE, password })),
        });
      } finally {
        await withAdmin("postgres", (c) => runAll(c, realtimeMigratorSql(null)));
      }
    }
    await withAdmin(roles.database, (c) => runAll(c, realtimeDatabaseSql(dbId(app.slug))));
    await realtimeApi(`/${app.slug}`, {
      method: "PUT",
      body: JSON.stringify(realtimeTenant(app, { user: roles.realtime, password: appSecrets(app).passwords.realtime })),
    });
  });
}

/** Closes every Realtime connection of the app (stop_app); clients that reconnect get the maintenance response. */
export async function disconnectRealtime(slug: string) {
  await realtimeApi(`/${slug}/reload`, { method: "POST", ok: [404] });
}

/** Removes the tenant (and its replication slot, while the database still exists). Idempotent. */
export async function deleteRealtime(slug: string) {
  await realtimeApi(`/${slug}`, { method: "DELETE", ok: [404] });
}
