const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`missing env ${name}`);
  return value;
};

/** Optional setting: unset and empty mean "use the default". */
const optional = (name: string): string | undefined => process.env[name] || undefined;

export const config = {
  port: Number(env("PORT", "3000")),
  /** Internal listener (Caddy forward auth, Studio project config): never routed publicly. */
  internalPort: Number(env("INTERNAL_PORT", "3001")),
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
  studio: {
    host: env("STUDIO_HOST", "studio.localhost"),
    upstream: env("STUDIO_UPSTREAM", "studio:3000"),
    forwardAuth: env("STUDIO_FORWARD_AUTH", "control-plane:3001"),
    /** HMAC key of the X-Platform-* headers trusted by Studio. */
    headerSecret: env("PLATFORM_STUDIO_HEADER_SECRET"),
    /** Bearer token Studio uses to read project configs from the internal listener. */
    configToken: env("PLATFORM_STUDIO_CONFIG_TOKEN"),
    /** Password of the unprivileged role behind postgres-meta's default connection. */
    metaDefaultPassword: env("STUDIO_META_DEFAULT_PASSWORD"),
  },
  sessionTtlSeconds: Number(env("SESSION_TTL_SECONDS", String(12 * 3600))),
  uploadTtlSeconds: Number(env("UPLOAD_TTL_SECONDS", "900")),
  maxUploadBytes: Number(env("MAX_UPLOAD_BYTES", String(200 * 1024 * 1024))),
  /**
   * Defaults of the platform settings (settings.ts): a row of the `settings` table overrides them at runtime.
   * DIRECT_DEPLOY unset means "admins" (production); deploy/install.sh writes "everyone" for local installs.
   */
  defaults: {
    directDeploy: optional("DIRECT_DEPLOY") ?? "admins",
    ciAllowedWorkflows: optional("CI_ALLOWED_WORKFLOWS") ?? "",
    oidcIssuer: optional("OIDC_ISSUER") ?? "https://token.actions.githubusercontent.com",
    oidcAudience: optional("OIDC_AUDIENCE"),
    oidcJwksUrl: optional("OIDC_JWKS_URL"),
  },
};

if (config.masterKey.length !== 32) throw new Error("PLATFORM_MASTER_KEY must be 32 bytes hex");

const portSuffix = () => (["80", "443", ""].includes(config.publicPort) ? "" : `:${config.publicPort}`);

export const appHost = (slug: string) => `${slug}.${config.appsDomain}`;
export const appUrl = (slug: string) => `${config.publicScheme}://${appHost(slug)}${portSuffix()}`;
export const apiUrl = () => `${config.publicScheme}://${config.apiHost}${portSuffix()}`;
export const studioUrl = (path = "") => `${config.publicScheme}://${config.studio.host}${portSuffix()}${path}`;
export const internalAppUrl = (slug: string) => `${config.internalGateway}/${slug}`;
