// Platform settings: environment defaults (config.defaults), overridden by rows of the `settings` table
// (CLI set-setting / unset-setting). Read on every CI request and every MCP publishing call: no restart needed.
import { apiUrl, config } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { many, platform } from "./db.ts";

export type DirectDeploy = "admins" | "everyone";

export interface Settings {
  /** Who may publish with a PAT (MCP): only admins (the audited exception), or every member of the app. */
  directDeploy: DirectDeploy;
  /** Allowed `job_workflow_ref` values (see ciWorkflowAllowed). Empty: the CI API refuses every token. */
  ciAllowedWorkflows: string[];
  oidcIssuer: string;
  /** Expected `aud` claim; defaults to the platform API URL. */
  oidcAudience: string;
  /** Defaults to `<issuer>/.well-known/jwks` (github.com and GHES). */
  oidcJwksUrl: string;
  /** TEST ONLY: inline JWKS (JSON) trusted instead of fetching oidcJwksUrl. Ignored without ALLOW_TEST_OIDC_JWKS=1. */
  oidcJwks: string | null;
  /** An app without request nor release for this many days is flagged "abandoned" (A6). */
  abandonedAfterDays: number;
  /** app_metrics rows older than this are deleted by the sampler. */
  metricsRetentionDays: number;
  /** Platform SMTP (M6): null when no host or no sender address is set (apps then auto-confirm their users). */
  smtp: SmtpSettings | null;
  /** Company SSO (M6 part 2, sso.ts): platform login (A7) and the apps' "custom:company" provider (U2). */
  sso: SsoSettings;
  /** Backups (M7, A4, backups.ts): schedule, retention and the optional S3 target. */
  backup: BackupSettings;
}

export interface BackupSettings {
  /** Daily scheduled backups of every app (the scheduler runs once per UTC day, at or after `hour`). */
  enabled: boolean;
  /** Hour of the day (UTC, 0 to 23) at or after which the daily run starts. */
  hour: number;
  /** Scheduled backups kept: the newest of each of the last `keepDaily` days... */
  keepDaily: number;
  /** ...and the newest of each of the last `keepWeekly` ISO weeks. */
  keepWeekly: number;
  /** Manual and pre-restore backups are kept this many days. */
  manualRetentionDays: number;
  /** Final backups (delete_app) are kept this many days. */
  finalRetentionDays: number;
  /** Off-site target; null: backups stay on the platform's backups volume. */
  s3: S3Settings | null;
}

export interface S3Settings {
  /** e.g. https://s3.eu-west-3.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://seaweedfs:8333 */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  /** Never returned by an API, never logged. Stored encrypted in the settings table. */
  secretAccessKey: string;
  /** Key prefix of every backup ("" or e.g. "platform/backups"), without leading or trailing slash. */
  prefix: string;
  /** Path-style URLs (<endpoint>/<bucket>/<key>), the default; false: virtual-hosted (<bucket>.<endpoint host>). */
  pathStyle: boolean;
}

/** What may be shown of the backup settings (CLI, admin API): no secret key. */
export function backupSummary(backup: BackupSettings) {
  return {
    enabled: backup.enabled,
    hour_utc: backup.hour,
    keep_daily: backup.keepDaily,
    keep_weekly: backup.keepWeekly,
    manual_retention_days: backup.manualRetentionDays,
    final_retention_days: backup.finalRetentionDays,
    target: backup.s3 ? "s3" : "local",
    s3: backup.s3
      ? {
        endpoint: backup.s3.endpoint,
        bucket: backup.s3.bucket,
        region: backup.s3.region,
        prefix: backup.s3.prefix,
        path_style: backup.s3.pathStyle,
        access_key_id: backup.s3.accessKeyId,
        secret_access_key_set: backup.s3.secretAccessKey !== "",
      }
      : null,
  };
}

export type SsoAutoCreate = "off" | "developer";
export type PasswordLogin = "everyone" | "admins";

export interface SsoSettings {
  /** Turned on by an admin; effective only when `configured` (ssoActive). */
  enabled: boolean;
  /** Issuer, client id and secret are all set. */
  configured: boolean;
  /** Shown on the buttons ("Sign in with <name>") and as the provider name in the apps' GoTrue. */
  name: string;
  issuer: string;
  /** Where the control plane reads the discovery document; `<issuer>/.well-known/openid-configuration` by default. */
  discoveryUrl: string;
  clientId: string;
  /** Never returned by an API, never logged. Stored encrypted in the settings table. */
  clientSecret: string;
  /** Lowercase email domains allowed to sign in to the platform with SSO; empty: any address the IdP vouches for. */
  allowedDomains: string[];
  /** Refuse an ID token whose `email_verified` is not true (turn off for IdPs that never send it, e.g. Entra ID). */
  requireVerifiedEmail: boolean;
  /** Unknown email: refuse ("off", the default) or create a developer account (just-in-time provisioning). */
  autoCreate: SsoAutoCreate;
  /** "admins": password sign-in is refused to developers while SSO is active (admins keep it: break-glass). */
  passwordLogin: PasswordLogin;
}

/** SSO usable: turned on and fully configured. */
export const ssoActive = (sso: SsoSettings) => sso.enabled && sso.configured;

/** What may be shown of the SSO settings (CLI, admin API): no client secret. */
export function ssoSummary(sso: SsoSettings) {
  return {
    enabled: sso.enabled,
    configured: sso.configured,
    active: ssoActive(sso),
    name: sso.name,
    issuer: sso.issuer || null,
    discovery_url: sso.discoveryUrl || null,
    client_id: sso.clientId || null,
    client_secret_set: sso.clientSecret !== "",
    allowed_domains: sso.allowedDomains,
    require_verified_email: sso.requireVerifiedEmail,
    auto_create: sso.autoCreate,
    password_login: sso.passwordLogin,
  };
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  /** Never returned by an API, never logged. Stored encrypted in the settings table. */
  password: string;
  senderEmail: string;
  senderName: string;
}

/** What may be shown of the SMTP settings (CLI, APIs): no password. */
export function smtpSummary(smtp: SmtpSettings | null) {
  return smtp
    ? {
      configured: true,
      host: smtp.host,
      port: smtp.port,
      user: smtp.user || null,
      password_set: smtp.password !== "",
      sender_email: smtp.senderEmail,
      sender_name: smtp.senderName,
    }
    : { configured: false };
}

/** The effective settings without any secret (CLI `settings`, admin API). */
export function settingsSummary(settings: Settings) {
  return {
    ...settings,
    oidcJwks: settings.oidcJwks ? "(inline JWKS set: test only)" : null,
    smtp: smtpSummary(settings.smtp),
    sso: ssoSummary(settings.sso),
    backup: backupSummary(settings.backup),
  };
}

/**
 * The values set with set-setting, which override the environment (or the default when the variable is unset):
 * secrets and the inline JWKS are never returned.
 */
export async function settingOverrides() {
  const rows = await many<{ key: string; value: string; updated_at: Date }>(
    "select key, value, updated_at from settings order by key",
  );
  return rows.map(({ key, value, updated_at }) => ({
    key,
    value: ENCRYPTED_KEYS.includes(key) ? "(secret)" : key === "oidc_jwks" ? "(inline JWKS)" : value,
    env: (SETTING_KEYS as Record<string, string>)[key] ?? null,
    updated_at,
  }));
}

/** Keys accepted by set-setting, with their environment variable. */
export const SETTING_KEYS = {
  direct_deploy: "DIRECT_DEPLOY",
  ci_allowed_workflows: "CI_ALLOWED_WORKFLOWS",
  oidc_issuer: "OIDC_ISSUER",
  oidc_audience: "OIDC_AUDIENCE",
  oidc_jwks_url: "OIDC_JWKS_URL",
  oidc_jwks: "(none, test only: requires ALLOW_TEST_OIDC_JWKS=1)",
  abandoned_after_days: "ABANDONED_AFTER_DAYS",
  metrics_retention_days: "METRICS_RETENTION_DAYS",
  smtp_host: "SMTP_HOST",
  smtp_port: "SMTP_PORT",
  smtp_user: "SMTP_USER",
  smtp_password: "SMTP_PASSWORD",
  smtp_sender_email: "SMTP_SENDER_EMAIL",
  smtp_sender_name: "SMTP_SENDER_NAME",
  sso_enabled: "SSO_ENABLED",
  sso_name: "SSO_NAME",
  sso_issuer: "SSO_ISSUER",
  sso_discovery_url: "SSO_DISCOVERY_URL",
  sso_client_id: "SSO_CLIENT_ID",
  sso_client_secret: "SSO_CLIENT_SECRET",
  sso_allowed_domains: "SSO_ALLOWED_DOMAINS",
  sso_require_verified_email: "SSO_REQUIRE_VERIFIED_EMAIL",
  sso_auto_create: "SSO_AUTO_CREATE",
  sso_password_login: "SSO_PASSWORD_LOGIN",
  backup_enabled: "BACKUP_ENABLED",
  backup_hour: "BACKUP_HOUR",
  backup_keep_daily: "BACKUP_KEEP_DAILY",
  backup_keep_weekly: "BACKUP_KEEP_WEEKLY",
  backup_manual_retention_days: "BACKUP_MANUAL_RETENTION_DAYS",
  backup_final_retention_days: "BACKUP_FINAL_RETENTION_DAYS",
  backup_s3_endpoint: "BACKUP_S3_ENDPOINT",
  backup_s3_bucket: "BACKUP_S3_BUCKET",
  backup_s3_region: "BACKUP_S3_REGION",
  backup_s3_access_key_id: "BACKUP_S3_ACCESS_KEY_ID",
  backup_s3_secret_access_key: "BACKUP_S3_SECRET_ACCESS_KEY",
  backup_s3_prefix: "BACKUP_S3_PREFIX",
  backup_s3_path_style: "BACKUP_S3_PATH_STYLE",
} as const;

/** Settings that change every app's GoTrue environment: setting them re-provisions the apps' Auth (app-auth.ts). */
export const SMTP_KEYS = ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_sender_email", "smtp_sender_name"];
/** Settings of the company SSO provider: changing them updates the apps' "custom:company" provider (app-sso.ts). */
export const SSO_PROVIDER_KEYS = ["sso_enabled", "sso_name", "sso_issuer", "sso_client_id", "sso_client_secret"];
/** Stored encrypted with the master key. */
export const ENCRYPTED_KEYS = ["smtp_password", "sso_client_secret", "backup_s3_secret_access_key"];
const BOOLEANS = ["sso_enabled", "sso_require_verified_email", "backup_enabled", "backup_s3_path_style"];
const bool = (key: string, value: string) => {
  if (value !== "true" && value !== "false") throw new Error(`${key} must be true or false`);
  return value === "true";
};
/** Same pattern as the apps' allowed email domains (auth-policy.ts). */
const SSO_DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const parseDomains = (value: string) =>
  [...new Set(value.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))].sort();
const EMAIL_RE = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/;

const DAYS = ["abandoned_after_days", "metrics_retention_days", "backup_manual_retention_days", "backup_final_retention_days"];
const integer = (key: string, value: string, min: number, max: number) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`);
  return n;
};
const INTEGERS: Record<string, [number, number]> = {
  backup_hour: [0, 23],
  backup_keep_daily: [1, 366],
  backup_keep_weekly: [0, 520],
};
const days = (key: string, value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error(`${key} must be a whole number of days (1 to 3650)`);
  return n;
};
export type SettingKey = keyof typeof SETTING_KEYS;

export function validateSetting(key: string, value: string): asserts key is SettingKey {
  if (!(key in SETTING_KEYS)) throw new Error(`unknown setting ${key}: ${Object.keys(SETTING_KEYS).join(", ")}`);
  if (key === "direct_deploy" && !["admins", "everyone"].includes(value)) {
    throw new Error("direct_deploy must be admins or everyone");
  }
  if (DAYS.includes(key)) days(key, value);
  if (key in INTEGERS) integer(key, value, ...INTEGERS[key]!);
  if (key === "backup_s3_endpoint" && value !== "") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("backup_s3_endpoint must be a URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("backup_s3_endpoint must be an http(s) URL");
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      throw new Error("backup_s3_endpoint: scheme, host and port only (the bucket is backup_s3_bucket)");
    }
  }
  if (key === "backup_s3_bucket" && value !== "" && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)) {
    throw new Error("backup_s3_bucket must be an S3 bucket name");
  }
  if (key === "backup_s3_region" && !/^[a-z0-9-]{1,40}$/.test(value)) throw new Error("backup_s3_region: e.g. eu-west-3");
  if (key === "backup_s3_prefix" && (!/^[A-Za-z0-9._\/-]{0,200}$/.test(value) || value.split("/").includes(".."))) {
    throw new Error("backup_s3_prefix: letters, digits, . _ - and /");
  }
  if (key === "backup_s3_access_key_id" && /\s/.test(value)) throw new Error("backup_s3_access_key_id: no whitespace");
  if (key === "smtp_port" && !(Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535)) {
    throw new Error("smtp_port must be a port number");
  }
  if (key === "smtp_sender_email" && value !== "" && !EMAIL_RE.test(value)) {
    throw new Error("smtp_sender_email must be an email address");
  }
  if (key === "smtp_host" && /[\s,]/.test(value)) throw new Error("smtp_host must be a host name");
  if (key === "smtp_sender_name" && /[\r\n<>"]/.test(value)) throw new Error("smtp_sender_name: no quotes, angle brackets or line breaks");
  if (BOOLEANS.includes(key)) bool(key, value);
  if (key === "sso_auto_create" && !["off", "developer"].includes(value)) throw new Error("sso_auto_create must be off or developer");
  if (key === "sso_password_login" && !["everyone", "admins"].includes(value)) {
    throw new Error("sso_password_login must be everyone or admins");
  }
  if ((key === "sso_issuer" || key === "sso_discovery_url") && value !== "") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${key} must be a URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${key} must be an http(s) URL`);
    if (url.search || url.hash) throw new Error(`${key}: no query string nor fragment`);
  }
  if (key === "sso_allowed_domains") {
    for (const d of parseDomains(value)) if (!SSO_DOMAIN_RE.test(d)) throw new Error(`invalid email domain "${d}"`);
  }
  if (key === "sso_name" && (value.trim() === "" || value.length > 60 || /[\r\n<>"]/.test(value))) {
    throw new Error("sso_name: 1 to 60 characters, no quotes, angle brackets or line breaks");
  }
  if (key === "sso_client_id" && /[\s]/.test(value)) throw new Error("sso_client_id: no whitespace");
  if (key === "oidc_jwks") {
    if (!config.allowTestOidcJwks) {
      throw new Error("oidc_jwks is test only: it requires ALLOW_TEST_OIDC_JWKS=1 on the control plane (local installs)");
    }
    JSON.parse(value);
  }
}

export async function getSettings(): Promise<Settings> {
  const rows = new Map(
    (await many<{ key: string; value: string }>("select key, value from settings")).map((r) => [r.key, r.value]),
  );
  const d = config.defaults;
  const directDeploy = rows.get("direct_deploy") ?? d.directDeploy;
  if (directDeploy !== "admins" && directDeploy !== "everyone") {
    throw new Error(`invalid DIRECT_DEPLOY "${directDeploy}": admins or everyone`);
  }
  const issuer = (rows.get("oidc_issuer") ?? d.oidcIssuer).replace(/\/+$/, "");
  const smtpPassword = rows.has("smtp_password") ? decrypt(rows.get("smtp_password")!) : d.smtpPassword;
  const smtpHost = rows.get("smtp_host") ?? d.smtpHost;
  // kept as typed: the ID token's `iss` must match it exactly (some IdPs end it with a slash)
  const ssoIssuer = rows.get("sso_issuer") ?? d.ssoIssuer;
  const ssoClientId = rows.get("sso_client_id") ?? d.ssoClientId;
  const ssoClientSecret = rows.has("sso_client_secret") ? decrypt(rows.get("sso_client_secret")!) : d.ssoClientSecret;
  const smtpSender = rows.get("smtp_sender_email") ?? d.smtpSenderEmail;
  const get = (key: SettingKey, fallback: string) => rows.get(key) ?? fallback;
  const s3 = {
    endpoint: get("backup_s3_endpoint", d.backupS3Endpoint).replace(/\/+$/, ""),
    bucket: get("backup_s3_bucket", d.backupS3Bucket),
    region: get("backup_s3_region", d.backupS3Region),
    accessKeyId: get("backup_s3_access_key_id", d.backupS3AccessKeyId),
    secretAccessKey: rows.has("backup_s3_secret_access_key")
      ? decrypt(rows.get("backup_s3_secret_access_key")!)
      : d.backupS3SecretAccessKey,
    prefix: get("backup_s3_prefix", d.backupS3Prefix).replace(/^\/+|\/+$/g, ""),
    pathStyle: bool("backup_s3_path_style", get("backup_s3_path_style", d.backupS3PathStyle)),
  };
  return {
    directDeploy,
    ciAllowedWorkflows: (rows.get("ci_allowed_workflows") ?? d.ciAllowedWorkflows)
      .split(",").map((s) => s.trim()).filter(Boolean),
    oidcIssuer: issuer,
    oidcAudience: rows.get("oidc_audience") ?? d.oidcAudience ?? apiUrl(),
    oidcJwksUrl: rows.get("oidc_jwks_url") ?? d.oidcJwksUrl ?? `${issuer}/.well-known/jwks`,
    // SEC-10: a test value left behind is ignored unless the environment explicitly allows it
    oidcJwks: config.allowTestOidcJwks ? rows.get("oidc_jwks") ?? null : null,
    abandonedAfterDays: days("abandoned_after_days", rows.get("abandoned_after_days") ?? d.abandonedAfterDays),
    metricsRetentionDays: days("metrics_retention_days", rows.get("metrics_retention_days") ?? d.metricsRetentionDays),
    // an empty smtp_host row disables the environment's SMTP
    smtp: smtpHost && smtpSender
      ? {
        host: smtpHost,
        port: Number(rows.get("smtp_port") ?? d.smtpPort),
        user: rows.get("smtp_user") ?? d.smtpUser,
        password: smtpPassword,
        senderEmail: smtpSender,
        senderName: rows.get("smtp_sender_name") ?? d.smtpSenderName,
      }
      : null,
    sso: {
      enabled: bool("sso_enabled", rows.get("sso_enabled") ?? d.ssoEnabled),
      configured: Boolean(ssoIssuer && ssoClientId && ssoClientSecret),
      name: rows.get("sso_name") ?? d.ssoName,
      issuer: ssoIssuer,
      discoveryUrl: (rows.get("sso_discovery_url") ?? d.ssoDiscoveryUrl) ||
        (ssoIssuer ? `${ssoIssuer.replace(/\/+$/, "")}/.well-known/openid-configuration` : ""),
      clientId: ssoClientId,
      clientSecret: ssoClientSecret,
      allowedDomains: parseDomains(rows.get("sso_allowed_domains") ?? d.ssoAllowedDomains),
      requireVerifiedEmail: bool("sso_require_verified_email", rows.get("sso_require_verified_email") ?? d.ssoRequireVerifiedEmail),
      autoCreate: (rows.get("sso_auto_create") ?? d.ssoAutoCreate) as SsoAutoCreate,
      passwordLogin: (rows.get("sso_password_login") ?? d.ssoPasswordLogin) as PasswordLogin,
    },
    backup: {
      enabled: bool("backup_enabled", get("backup_enabled", d.backupEnabled)),
      hour: integer("backup_hour", get("backup_hour", d.backupHour), 0, 23),
      keepDaily: integer("backup_keep_daily", get("backup_keep_daily", d.backupKeepDaily), 1, 366),
      keepWeekly: integer("backup_keep_weekly", get("backup_keep_weekly", d.backupKeepWeekly), 0, 520),
      manualRetentionDays: days("backup_manual_retention_days", get("backup_manual_retention_days", d.backupManualRetentionDays)),
      finalRetentionDays: days("backup_final_retention_days", get("backup_final_retention_days", d.backupFinalRetentionDays)),
      // usable only when complete: an empty backup_s3_endpoint row turns the environment's target off
      s3: s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey ? s3 : null,
    },
  };
}

export async function setSetting(key: string, value: string) {
  validateSetting(key, value);
  await platform.query(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, ENCRYPTED_KEYS.includes(key) ? encrypt(value) : value],
  );
}

export async function unsetSetting(key: string) {
  await platform.query("delete from settings where key = $1", [key]);
}

/**
 * The `uses:` of an app repository's caller workflow (plugin/skills/deploy/assets/platform.yml), from the first allowed reusable
 * workflow: `org/platform/.github/workflows/deploy.yml@refs/heads/main` gives `...deploy.yml@main`. An entry without a
 * ref gives `@main`. Null when the CI API accepts no workflow (CI deployment not set up on this platform).
 */
export function callerWorkflow(settings: Settings): { uses: string; github_org: string } | null {
  const entry = settings.ciAllowedWorkflows[0];
  if (!entry) return null;
  const [path, ref] = entry.split("@") as [string, string | undefined];
  return {
    uses: `${path}@${ref ? ref.replace(/^refs\/(heads|tags)\//, "") : "main"}`,
    github_org: path.split("/")[0]!,
  };
}
