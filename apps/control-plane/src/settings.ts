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
} as const;

/** Settings that change every app's GoTrue environment: setting them re-provisions the apps' Auth (app-auth.ts). */
export const SMTP_KEYS = ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "smtp_sender_email", "smtp_sender_name"];
/** Settings of the company SSO provider: changing them updates the apps' "custom:company" provider (app-sso.ts). */
export const SSO_PROVIDER_KEYS = ["sso_enabled", "sso_name", "sso_issuer", "sso_client_id", "sso_client_secret"];
/** Stored encrypted with the master key. */
const ENCRYPTED_KEYS = ["smtp_password", "sso_client_secret"];
const BOOLEANS = ["sso_enabled", "sso_require_verified_email"];
const bool = (key: string, value: string) => {
  if (value !== "true" && value !== "false") throw new Error(`${key} must be true or false`);
  return value === "true";
};
/** Same pattern as the apps' allowed email domains (auth-policy.ts). */
const SSO_DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const parseDomains = (value: string) =>
  [...new Set(value.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))].sort();
const EMAIL_RE = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/;

const DAYS = ["abandoned_after_days", "metrics_retention_days"];
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
 * The `uses:` of an app repository's caller workflow (ci/examples/platform.yml), from the first allowed reusable
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
