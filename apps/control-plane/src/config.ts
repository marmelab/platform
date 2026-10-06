const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`missing env ${name}`);
  return value;
};

/** Optional setting: unset and empty mean "use the default". */
const optional = (name: string): string | undefined => process.env[name] || undefined;

/**
 * The platform's domain (install.sh --domain): apps on <slug>.<domain>, the API on api.<domain>, the admin console on
 * admin.<domain>, Studio on studio.<domain>. Each host can still be set on its own (APPS_DOMAIN, API_HOST...).
 * `localhost` for local installs.
 */
const domain = env("PLATFORM_DOMAIN", "localhost");

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
  domain,
  publicScheme: env("PUBLIC_SCHEME", "http"),
  appsDomain: env("APPS_DOMAIN", domain),
  publicPort: env("PUBLIC_PORT", "8100"),
  apiHost: env("API_HOST", `api.${domain}`),
  /** Admin SPA and its API (admin.<domain>/api/*), same origin (M4). */
  adminHost: env("ADMIN_HOST", `admin.${domain}`),
  /**
   * TLS of the public server (router.ensureEdge): `off` (local installs: plain HTTP on PUBLIC_PORT), `acme` (Let's
   * Encrypt or ACME_CA, certificates obtained on demand for the hosts that the `ask` endpoint approves, tls.ts) or
   * `internal` (Caddy's own CA: tests, or a private network whose clients trust that CA).
   */
  tls: {
    mode: env("TLS_MODE", "off") as "off" | "acme" | "internal",
    acmeEmail: optional("ACME_EMAIL"),
    /** ACME directory, e.g. Let's Encrypt staging; default: Let's Encrypt production. */
    acmeCa: optional("ACME_CA"),
    httpPort: Number(env("HTTP_PORT", "80")),
  },
  /** The internal listener as Caddy reaches it (forward auth, TLS `ask` endpoint). */
  internalListener: env("INTERNAL_LISTENER", "control-plane:3001"),
  /** Built admin SPA (apps/admin/dist), copied into the control plane image. */
  adminStaticDir: env("ADMIN_STATIC_DIR", "/repo/apps/admin/dist"),
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
  /**
   * Shared multi-tenant Storage API (M5): admin API (tenants, internal network only), upstream of the app routes,
   * its tenants metadata database, and its file backend (volume also mounted in the control plane for backups).
   */
  storage: {
    adminUrl: env("STORAGE_ADMIN_URL", "http://storage:5001"),
    upstream: env("STORAGE_UPSTREAM", "storage:5000"),
    adminKey: env("STORAGE_ADMIN_KEY"),
    dbRole: env("STORAGE_DB_ROLE", "platform_storage"),
    dbPassword: env("STORAGE_DB_PASSWORD"),
    /** <dataDir>/<bucket>/<slug>/: the app's files (FILE_STORAGE_BACKEND_PATH and GLOBAL_S3_BUCKET of Storage). */
    dataDir: env("STORAGE_DATA_DIR", "/data/storage"),
    bucket: env("STORAGE_BUCKET", "tenants"),
    fileSizeLimit: Number(env("STORAGE_FILE_SIZE_LIMIT", String(50 * 1024 * 1024))),
    /**
     * The Storage container and its file backend path (FILE_STORAGE_BACKEND_PATH): backups read and restore the
     * files' extended attributes (content type, cache control) there, with Storage's own fs-xattr module.
     */
    container: env("STORAGE_CONTAINER", "plat-storage"),
    containerDataDir: env("STORAGE_CONTAINER_DATA_DIR", "/var/lib/storage"),
    /** Postgres connections of Storage's pool per app (freed after a minute without requests). */
    maxConnections: Number(env("STORAGE_TENANT_MAX_CONNECTIONS", "3")),
  },
  /** Shared multi-tenant Realtime (M5): tenant management API (internal network only) and its metadata database. */
  realtime: {
    url: env("REALTIME_URL", "http://realtime:4000"),
    upstream: env("REALTIME_UPSTREAM", "realtime:4000"),
    apiJwtSecret: env("REALTIME_API_JWT_SECRET"),
    dbRole: env("REALTIME_DB_ROLE", "platform_realtime"),
    dbPassword: env("REALTIME_DB_PASSWORD"),
  },
  /**
   * Connection pooler (PgBouncer, README.md, "Connection pooler"): PostgREST and Storage reach the app databases through it,
   * in transaction mode. The control plane writes its [databases] entries (one per app) into `databasesFile` (volume
   * shared with the pooler) and reloads it through the admin console.
   */
  pooler: {
    host: env("POOLER_HOST", "pooler"),
    port: Number(env("POOLER_PORT", "6432")),
    adminUser: env("POOLER_ADMIN_USER", "pooler_admin"),
    adminPassword: env("POOLER_ADMIN_PASSWORD"),
    /** Password of the auth_query role (POOLER_AUTH_ROLE), set by init. */
    authPassword: env("POOLER_AUTH_PASSWORD"),
    databasesFile: env("POOLER_DATABASES_FILE", "/data/pooler/databases.ini"),
    /** Server connections per app database, all roles together (PgBouncer max_db_connections). */
    maxDbConnections: Number(env("POOLER_MAX_DB_CONNECTIONS", "6")),
  },
  dataDir: {
    sites: env("SITES_DIR", "/data/sites"),
    functions: env("FUNCTIONS_DIR", "/data/functions"),
    appsConfig: env("APPS_CONFIG_DIR", "/data/config/apps"),
    uploads: env("UPLOADS_DIR", "/data/uploads"),
    /**
     * Backups (M7, backups.ts): <backups>/<slug>-<timestamp>/, kept here when no S3 target is configured; with S3, the
     * staging area of backups being taken or restored.
     */
    backups: env("BACKUPS_DIR", "/data/backups"),
  },
  /** Caddy's access log of the app hosts (metrics.ts): the file as Caddy writes it, and as the control plane reads it. */
  accessLog: {
    caddyPath: env("CADDY_ACCESS_LOG", "/var/log/caddy/access.log"),
    path: env("ACCESS_LOG", "/data/caddy-logs/access.log"),
  },
  /** Seconds between two checks of the backup scheduler (is today's run due?). */
  backupCheckIntervalSeconds: Number(env("BACKUP_CHECK_INTERVAL_SECONDS", "300")),
  /** Seconds between two metrics samples (app_metrics). */
  metricsIntervalSeconds: Number(env("METRICS_INTERVAL_SECONDS", "60")),
  /** Paths as seen by Caddy / the edge runtime (named volumes mounted elsewhere). */
  caddySitesRoot: env("CADDY_SITES_ROOT", "/sites"),
  edgeUpstream: env("EDGE_UPSTREAM", "edge:9000"),
  /** Main worker internal endpoint (/_internal/warm), protected by the edge admin token. */
  edgeAdminToken: env("PLATFORM_EDGE_ADMIN_TOKEN"),
  /** First boot of a function may download its npm: dependencies. */
  warmTimeoutMs: Number(env("WARM_TIMEOUT_MS", "60000")),
  studio: {
    host: env("STUDIO_HOST", `studio.${domain}`),
    upstream: env("STUDIO_UPSTREAM", "studio:3000"),
    forwardAuth: env("STUDIO_FORWARD_AUTH", "control-plane:3001"),
    /** HMAC key of the X-Platform-* headers trusted by Studio. */
    headerSecret: env("PLATFORM_STUDIO_HEADER_SECRET"),
    /** Bearer token Studio uses to read project configs from the internal listener. */
    configToken: env("PLATFORM_STUDIO_CONFIG_TOKEN"),
    /** Password of the unprivileged role behind postgres-meta's default connection. */
    metaDefaultPassword: env("STUDIO_META_DEFAULT_PASSWORD"),
  },
  /**
   * Reverse proxies whose X-Forwarded-For is trusted for the client IP (login throttling, SEC-3): host names resolved
   * on the Docker network, or IPs. Every public request arrives through Caddy.
   */
  trustedProxies: env("TRUSTED_PROXIES", "caddy").split(",").map((s) => s.trim()).filter(Boolean),
  /** VERSION file of the repository, copied into the image (version.ts). */
  versionFile: env("PLATFORM_VERSION_FILE", "/repo/VERSION"),
  /** Hours between two linter runs of an app by the periodic sweep (lint.ts); 0 turns the sweep off. */
  lintSweepIntervalHours: Number(env("LINT_SWEEP_INTERVAL_HOURS", "6")),
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
    abandonedAfterDays: optional("ABANDONED_AFTER_DAYS") ?? "30",
    metricsRetentionDays: optional("METRICS_RETENTION_DAYS") ?? "30",
    /** Platform SMTP (M6): app emails (each app's GoTrue) and the platform's own (abandoned apps...). No host: none. */
    smtpHost: optional("SMTP_HOST") ?? "",
    smtpPort: optional("SMTP_PORT") ?? "587",
    smtpUser: optional("SMTP_USER") ?? "",
    smtpPassword: optional("SMTP_PASSWORD") ?? "",
    smtpSenderEmail: optional("SMTP_SENDER_EMAIL") ?? "",
    smtpSenderName: optional("SMTP_SENDER_NAME") ?? "Platform",
    /** Company SSO (M6 part 2, sso.ts): off until an admin configures it (admin console, SSO). */
    ssoEnabled: optional("SSO_ENABLED") ?? "false",
    ssoName: optional("SSO_NAME") ?? "company SSO",
    ssoIssuer: optional("SSO_ISSUER") ?? "",
    ssoDiscoveryUrl: optional("SSO_DISCOVERY_URL") ?? "",
    ssoClientId: optional("SSO_CLIENT_ID") ?? "",
    ssoClientSecret: optional("SSO_CLIENT_SECRET") ?? "",
    ssoAllowedDomains: optional("SSO_ALLOWED_DOMAINS") ?? "",
    ssoRequireVerifiedEmail: optional("SSO_REQUIRE_VERIFIED_EMAIL") ?? "true",
    ssoAutoCreate: optional("SSO_AUTO_CREATE") ?? "off",
    ssoPasswordLogin: optional("SSO_PASSWORD_LOGIN") ?? "everyone",
    /** Backups (M7, backups.ts): daily at BACKUP_HOUR (UTC), on the backups volume unless the S3 target is set. */
    backupEnabled: optional("BACKUP_ENABLED") ?? "true",
    backupHour: optional("BACKUP_HOUR") ?? "2",
    backupKeepDaily: optional("BACKUP_KEEP_DAILY") ?? "7",
    backupKeepWeekly: optional("BACKUP_KEEP_WEEKLY") ?? "4",
    backupManualRetentionDays: optional("BACKUP_MANUAL_RETENTION_DAYS") ?? "30",
    backupFinalRetentionDays: optional("BACKUP_FINAL_RETENTION_DAYS") ?? "90",
    backupS3Endpoint: optional("BACKUP_S3_ENDPOINT") ?? "",
    backupS3Bucket: optional("BACKUP_S3_BUCKET") ?? "",
    backupS3Region: optional("BACKUP_S3_REGION") ?? "us-east-1",
    backupS3AccessKeyId: optional("BACKUP_S3_ACCESS_KEY_ID") ?? "",
    backupS3SecretAccessKey: optional("BACKUP_S3_SECRET_ACCESS_KEY") ?? "",
    backupS3Prefix: optional("BACKUP_S3_PREFIX") ?? "",
    backupS3PathStyle: optional("BACKUP_S3_PATH_STYLE") ?? "true",
  },
  /**
   * Local installs only (written by deploy/install.sh, never in production): the mock IdP of the dev stack (`idp`
   * service, profile sso-test) is reached by the apps' GoTrue over HTTPS on a network with a non-private address
   * (GoTrue refuses private and plain-HTTP issuers for custom providers). Each app's GoTrue joins this network and
   * trusts the mock's CA (volume mounted on /etc/platform-test-ca).
   */
  ssoTest: {
    network: optional("SSO_TEST_NETWORK"),
    caVolume: optional("SSO_TEST_CA_VOLUME"),
  },
  /**
   * SEC-10: the test-only `oidc_jwks` setting (inline JWKS trusted by the CI API) is honoured only with
   * ALLOW_TEST_OIDC_JWKS=1, written by deploy/install.sh for local installs. Never set it in production.
   */
  allowTestOidcJwks: optional("ALLOW_TEST_OIDC_JWKS") === "1",
};

if (config.masterKey.length !== 32) throw new Error("PLATFORM_MASTER_KEY must be 32 bytes hex");
if (!["off", "acme", "internal"].includes(config.tls.mode)) throw new Error("TLS_MODE must be off, acme or internal");
if (config.tls.mode !== "off" && config.publicScheme !== "https") throw new Error("TLS_MODE requires PUBLIC_SCHEME=https");

const portSuffix = () => (["80", "443", ""].includes(config.publicPort) ? "" : `:${config.publicPort}`);

export const appHost = (slug: string) => `${slug}.${config.appsDomain}`;
export const appUrl = (slug: string) => `${config.publicScheme}://${appHost(slug)}${portSuffix()}`;
export const apiUrl = () => `${config.publicScheme}://${config.apiHost}${portSuffix()}`;
export const adminUrl = (path = "") => `${config.publicScheme}://${config.adminHost}${portSuffix()}${path}`;
export const studioUrl = (path = "") => `${config.publicScheme}://${config.studio.host}${portSuffix()}${path}`;
export const internalAppUrl = (slug: string) => `${config.internalGateway}/${slug}`;

/**
 * Local installs (plain HTTP on *.localhost): Claude Code only sends OAuth token requests over HTTPS or to a loopback
 * host, and api.localhost does not count as one. The token endpoint is then announced on http://localhost:<port>,
 * which Caddy routes to the control plane for that path only (router.ensureEdge). Never in production (HTTPS).
 */
export const loopbackTokenHost = () =>
  config.publicScheme === "http" && config.apiHost.endsWith(".localhost") ? "localhost" : null;
export const oauthTokenEndpoint = () =>
  loopbackTokenHost() ? `http://localhost${portSuffix()}/oauth/token` : `${apiUrl()}/oauth/token`;
