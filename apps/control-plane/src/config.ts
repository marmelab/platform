const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`missing env ${name}`);
  return value;
};

export const config = {
  port: Number(env("PORT", "3000")),
  pg: {
    host: env("PGHOST", "db"),
    port: Number(env("PGPORT", "5432")),
    adminUser: env("PG_ADMIN_USER", "supabase_admin"),
    adminPassword: env("POSTGRES_PASSWORD"),
    platformDb: env("PLATFORM_DB", "platform"),
  },
  masterKey: Buffer.from(env("PLATFORM_MASTER_KEY"), "hex"),
  /** Public URLs: <scheme>://<slug>.<appsDomain><publicPort> */
  publicScheme: env("PUBLIC_SCHEME", "http"),
  appsDomain: env("APPS_DOMAIN", "localhost"),
  publicPort: env("PUBLIC_PORT", "8100"),
  apiHost: env("API_HOST", "api.localhost"),
  caddyAdmin: env("CADDY_ADMIN_URL", "http://caddy:2019"),
  /** Internal Caddy listener used by edge functions to reach their app's API (SUPABASE_URL). */
  internalGateway: env("INTERNAL_GATEWAY_URL", "http://caddy:8180"),
  docker: {
    network: env("DOCKER_NETWORK", "plat"),
    prefix: env("CONTAINER_PREFIX", "plat"),
    edgeContainer: env("EDGE_CONTAINER", "plat-edge"),
    dbContainer: env("DB_CONTAINER", "plat-db"),
    gotrueImage: env("GOTRUE_IMAGE", "supabase/gotrue:v2.196.0"),
    postgrestImage: env("POSTGREST_IMAGE", "postgrest/postgrest:v14.17"),
  },
  dataDir: {
    sites: env("SITES_DIR", "/data/sites"),
    functions: env("FUNCTIONS_DIR", "/data/functions"),
    appsConfig: env("APPS_CONFIG_DIR", "/data/config/apps"),
    uploads: env("UPLOADS_DIR", "/data/uploads"),
  },
  /** Paths as seen by Caddy / the edge runtime (named volumes mounted elsewhere). */
  caddySitesRoot: env("CADDY_SITES_ROOT", "/sites"),
  edgeUpstream: env("EDGE_UPSTREAM", "edge:9000"),
  /** Main worker internal endpoint (/_internal/warm), protected by the edge admin token. */
  edgeAdminToken: env("PLATFORM_EDGE_ADMIN_TOKEN"),
  /** First boot of a function may download its npm: dependencies. */
  warmTimeoutMs: Number(env("WARM_TIMEOUT_MS", "60000")),
  uploadTtlSeconds: Number(env("UPLOAD_TTL_SECONDS", "900")),
  maxUploadBytes: Number(env("MAX_UPLOAD_BYTES", String(200 * 1024 * 1024))),
};

if (config.masterKey.length !== 32) throw new Error("PLATFORM_MASTER_KEY must be 32 bytes hex");

const portSuffix = () => (["80", "443", ""].includes(config.publicPort) ? "" : `:${config.publicPort}`);

export const appHost = (slug: string) => `${slug}.${config.appsDomain}`;
export const appUrl = (slug: string) => `${config.publicScheme}://${appHost(slug)}${portSuffix()}`;
export const apiUrl = () => `${config.publicScheme}://${config.apiHost}${portSuffix()}`;
export const internalAppUrl = (slug: string) => `${config.internalGateway}/${slug}`;
