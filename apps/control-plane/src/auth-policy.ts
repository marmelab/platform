// Pure part of the app auth policy (M6, app-auth.ts): GoTrue environment, hook SQL, view. No I/O and no platform
// configuration import, so that the unit tests (test/auth-policy.test.ts) load it alone.
import type { SmtpSettings } from "./settings.ts";

/** The app as the policy sees it: its name (default sender name), slug, and public URL (site URL, links). */
export interface PolicyApp {
  slug: string;
  name: string;
  url: string;
}

export interface AuthConfig {
  signup_enabled: boolean;
  /** Stored choice; only effective when the platform has an SMTP (otherwise users are auto-confirmed). */
  email_confirmation: boolean;
  /** Lowercase domains; empty: any address. Enforced by GoTrue's before-user-created hook (sign-up, invite, SSO). */
  allowed_email_domains: string[];
  /** Redirect URLs allowed besides the app's own URL (GoTrue's URI allow list, globs allowed). */
  redirect_urls: string[];
  /** Sender of the app's emails; null: the app's name and the platform sender address. */
  sender_name: string | null;
  sender_email: string | null;
  /** M6 part 2 (U2): "company" adds the platform's company SSO to the app's GoTrue (app-sso.ts). */
  sso_provider: "company" | null;
  updated_at: Date | null;
}

/** The app's company SSO provider in GoTrue: supabase-js signs in with signInWithOAuth({ provider: this }). */
export const COMPANY_SSO_PROVIDER = "custom:company";

/** The platform's company SSO, as the app policy needs it (no secret). */
export interface CompanySso {
  name: string;
  active: boolean;
}

export const DEFAULT_AUTH: AuthConfig = {
  signup_enabled: true,
  email_confirmation: true,
  allowed_email_domains: [],
  redirect_urls: [],
  sender_name: null,
  sender_email: null,
  sso_provider: null,
  updated_at: null,
};

export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** http(s) URL, globs allowed, no comma (GOTRUE_URI_ALLOW_LIST is comma-separated) nor whitespace. */
export const REDIRECT_URL_RE = /^https?:\/\/[^\s,/?#]+(?:[/?#][^\s,]*)?$/;
export const SENDER_EMAIL_RE = /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/;
/** GoTrue's link paths: the app's API is served under /auth/v1 on the app host (ARCHITECTURE §3). */
export const VERIFY_PATH = "/auth/v1/verify";
/** The before-user-created hook (allowed email domains): owned by supabase_admin, executed by GoTrue's role. */
export const HOOK_FUNCTION = "_platform.before_user_created";
export const HOOK_URI = "pg-functions://postgres/_platform/before_user_created";

export const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** The effective sender of an app's emails. */
export function appSender(app: PolicyApp, auth: AuthConfig, smtp: SmtpSettings | null) {
  return {
    name: oneLine(auth.sender_name ?? app.name ?? app.slug),
    email: auth.sender_email ?? smtp?.senderEmail ?? null,
  };
}

/**
 * The policy part of an app's GoTrue environment (startServices adds the database, JWT and API settings). Pure: the
 * unit tests check it. Without SMTP, GoTrue cannot send anything: users are auto-confirmed, and invite_user returns
 * the link instead (auth-users.ts).
 */
export function authEnv(app: PolicyApp, auth: AuthConfig, smtp: SmtpSettings | null) {
  const publicUrl = app.url;
  const env: Record<string, string> = {
    GOTRUE_SITE_URL: publicUrl,
    GOTRUE_URI_ALLOW_LIST: [`${publicUrl}/**`, ...auth.redirect_urls].join(","),
    GOTRUE_DISABLE_SIGNUP: String(!auth.signup_enabled),
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
    GOTRUE_MAILER_AUTOCONFIRM: String(!(smtp && auth.email_confirmation)),
    // links in the emails: GoTrue resolves these paths against API_EXTERNAL_URL's host (its own /verify would drop
    // the /auth/v1 prefix of the app host)
    GOTRUE_MAILER_URLPATHS_INVITE: VERIFY_PATH,
    GOTRUE_MAILER_URLPATHS_CONFIRMATION: VERIFY_PATH,
    GOTRUE_MAILER_URLPATHS_RECOVERY: VERIFY_PATH,
    GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: VERIFY_PATH,
  };
  if (smtp) {
    const sender = appSender(app, auth, smtp);
    Object.assign(env, {
      GOTRUE_SMTP_HOST: smtp.host,
      GOTRUE_SMTP_PORT: String(smtp.port),
      GOTRUE_SMTP_USER: smtp.user,
      GOTRUE_SMTP_PASS: smtp.password,
      GOTRUE_SMTP_ADMIN_EMAIL: sender.email!,
      GOTRUE_SMTP_SENDER_NAME: sender.name,
    });
  }
  if (auth.allowed_email_domains.length > 0) {
    Object.assign(env, {
      GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true",
      GOTRUE_HOOK_BEFORE_USER_CREATED_URI: HOOK_URI,
    });
  }
  return env;
}

/** The hook function of the allowed domains, (re)created before GoTrue starts with the hook enabled. Idempotent. */
export function authHookSql(authAdminRole: string, domains: string[]): string[] {
  for (const d of domains) if (!DOMAIN_RE.test(d)) throw new Error(`unsafe domain ${d}`);
  const list = domains.length ? `array[${domains.map((d) => `'${d}'`).join(", ")}]::text[]` : "array[]::text[]";
  const message = `Sign-ups are restricted to email addresses of: ${domains.join(", ")}`;
  return [
    `create or replace function ${HOOK_FUNCTION}(event jsonb) returns jsonb
      language plpgsql stable set search_path = '' as $$
      declare
        allowed text[] := ${list};
        email_domain text := lower(split_part(coalesce(event->'user'->>'email', ''), '@', 2));
      begin
        if cardinality(allowed) = 0 or email_domain = any(allowed) then
          return '{}'::jsonb;
        end if;
        return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', '${message}'));
      end $$`,
    `alter function ${HOOK_FUNCTION}(jsonb) owner to supabase_admin`,
    `revoke all on function ${HOOK_FUNCTION}(jsonb) from public`,
    `grant usage on schema _platform to ${authAdminRole}`,
    `grant execute on function ${HOOK_FUNCTION}(jsonb) to ${authAdminRole}`,
  ];
}

/** get_app and the admin console: the stored policy and what is in effect. No secret. */
export function authView(app: PolicyApp, auth: AuthConfig, smtp: SmtpSettings | null, companySso: CompanySso | null = null) {
  const sender = appSender(app, auth, smtp);
  return {
    signup_enabled: auth.signup_enabled,
    email_confirmation: auth.email_confirmation,
    /** Confirmation is only required when the platform can send emails. */
    email_confirmation_effective: Boolean(smtp) && auth.email_confirmation,
    allowed_email_domains: auth.allowed_email_domains,
    redirect_urls: auth.redirect_urls,
    site_url: app.url,
    uri_allow_list: [`${app.url}/**`, ...auth.redirect_urls],
    smtp_configured: Boolean(smtp),
    sender_name: sender.name,
    sender_email: sender.email,
    sender_overridden: auth.sender_name !== null || auth.sender_email !== null,
    email_templates: "default",
    sso: auth.sso_provider === "company"
      ? {
        provider: "company",
        name: companySso?.name ?? null,
        /** False while the platform's company SSO is off or incomplete: the app's provider is then removed. */
        effective: Boolean(companySso?.active),
        gotrue_provider: COMPANY_SSO_PROVIDER,
        /** Redirect URI to register at the identity provider for the platform's SSO client. */
        callback_url: `${app.url}/auth/v1/callback`,
        sign_in: `supabase.auth.signInWithOAuth({ provider: "${COMPANY_SSO_PROVIDER}", options: { redirectTo } })`,
      }
      : null,
    updated_at: auth.updated_at,
  };
}

