// App auth policy (M6, journeys B6 and U1): the platform SMTP in every app's GoTrue, and the per-app settings the
// builder changes with `configure_auth` (table app_auth_config; no row means the defaults): sign-up on or off, email
// confirmation, allowed email domains, extra redirect URLs, sender override. Every change recreates the app's GoTrue
// container with its new environment (a few seconds without /auth/v1 for that app).
import { appRoles } from "@platform/sql";
import { type AppRow, dbId, ensureAuthService, requireWritable, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { appUrl } from "./config.ts";
import { one, withAdmin } from "./db.ts";
import { companySso, ensureCompanySso } from "./app-sso.ts";
import { getSettings, ssoActive } from "./settings.ts";
import {
  type AuthConfig,
  authHookSql,
  authView,
  DEFAULT_AUTH,
  DOMAIN_RE,
  oneLine,
  type PolicyApp,
  REDIRECT_URL_RE,
  SENDER_EMAIL_RE,
} from "./auth-policy.ts";

export type { AuthConfig } from "./auth-policy.ts";
export { authEnv } from "./auth-policy.ts";

/** The policy's view of an app. */
export const policyApp = (app: Pick<AppRow, "slug" | "name">): PolicyApp => ({ slug: app.slug, name: app.name, url: appUrl(app.slug) });

export async function authConfig(app: Pick<AppRow, "id">): Promise<AuthConfig> {
  const row = await one<AuthConfig>(
    `select signup_enabled, email_confirmation, allowed_email_domains, redirect_urls, sender_name, sender_email,
       sso_provider, updated_at
       from app_auth_config where app_id = $1`,
    [app.id],
  );
  return row ?? { ...DEFAULT_AUTH };
}

export async function ensureAuthHook(app: Pick<AppRow, "slug">, auth: AuthConfig) {
  const roles = appRoles(dbId(app.slug));
  await withAdmin(roles.database, async (c) => {
    for (const sql of authHookSql(roles.authAdmin, auth.allowed_email_domains)) await c.query(sql);
  });
}

export async function appAuthView(app: Pick<AppRow, "id" | "name" | "slug">) {
  const { smtp, sso } = await getSettings();
  return authView(policyApp(app), await authConfig(app), smtp, companySso(sso));
}

export interface AuthChanges {
  signup_enabled?: boolean;
  email_confirmation?: boolean;
  allowed_email_domains?: string[];
  redirect_urls?: string[];
  sender_name?: string | null;
  sender_email?: string | null;
  /** M6 part 2 (U2): the platform's company SSO for the app's users, or null to remove it. */
  sso?: { provider: "company" } | null;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * configure_auth (owner or admin, checked by the caller): partial update, audited with the changed fields, refused on
 * a stopped app. The GoTrue container is recreated only when its environment changes.
 */
export async function configureAuth(actor: User, app: AppRow, input: AuthChanges) {
  requireWritable(app, "configure_auth");
  const { smtp, sso } = await getSettings();
  const before = await authConfig(app);
  const next: AuthConfig = { ...before };
  const warnings: string[] = [];

  if (input.signup_enabled !== undefined) next.signup_enabled = input.signup_enabled;
  if (input.email_confirmation !== undefined) next.email_confirmation = input.email_confirmation;
  if (input.allowed_email_domains !== undefined) {
    const domains = [...new Set(input.allowed_email_domains.map((d) => d.trim().toLowerCase().replace(/^@/, "")))];
    for (const d of domains) if (!DOMAIN_RE.test(d)) throw new UserError(`invalid email domain "${d}" (e.g. example.com)`);
    next.allowed_email_domains = domains.sort();
  }
  if (input.redirect_urls !== undefined) {
    const urls = [...new Set(input.redirect_urls.map((u) => u.trim()))];
    for (const u of urls) {
      if (!REDIRECT_URL_RE.test(u)) throw new UserError(`invalid redirect URL "${u}": http(s)://host/path, globs allowed, no comma`);
    }
    next.redirect_urls = urls;
  }
  if (input.sender_name !== undefined) {
    const name = input.sender_name === null ? null : oneLine(input.sender_name);
    if (name !== null && (name === "" || /[<>"]/.test(name))) throw new UserError("invalid sender_name");
    next.sender_name = name;
  }
  if (input.sender_email !== undefined) {
    const email = input.sender_email === null ? null : input.sender_email.trim().toLowerCase();
    if (email !== null) {
      if (!SENDER_EMAIL_RE.test(email)) throw new UserError(`invalid sender_email "${email}"`);
      // builders may only send from the platform sender's domain (the relay's SPF/DKIM, no spoofed addresses);
      // admins may set any address the relay accepts
      if (actor.role !== "admin") {
        if (!smtp) throw new UserError("sender_email: the platform has no SMTP configured, ask an admin");
        if (domainOf(email) !== domainOf(smtp.senderEmail)) {
          throw new UserError(`sender_email must be an address of ${domainOf(smtp.senderEmail)} (the platform sender's domain); ask an admin for another domain`);
        }
      }
    }
    next.sender_email = email;
  }

  if (input.sso !== undefined) {
    next.sso_provider = input.sso === null ? null : input.sso.provider;
    if (next.sso_provider === "company" && !ssoActive(sso)) {
      throw new UserError("the platform has no company SSO: an admin configures it in the admin console (SSO)");
    }
  }

  if (!smtp) {
    if (next.email_confirmation) {
      warnings.push("the platform has no SMTP: users are confirmed automatically until an admin configures it");
    }
    if (next.sender_name !== null || next.sender_email !== null) {
      warnings.push("the platform has no SMTP: the sender is stored but no email is sent");
    }
  }

  const fields = ["signup_enabled", "email_confirmation", "allowed_email_domains", "redirect_urls", "sender_name", "sender_email",
    "sso_provider"] as const;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (JSON.stringify(before[f]) !== JSON.stringify(next[f])) changes[f] = { from: before[f], to: next[f] };
  }
  if (Object.keys(changes).length === 0) {
    return { app: app.slug, changed: false, auth: authView(policyApp(app), before, smtp, companySso(sso)), warnings };
  }

  const saved = await one<AuthConfig>(
    `insert into app_auth_config (app_id, signup_enabled, email_confirmation, allowed_email_domains, redirect_urls,
       sender_name, sender_email, sso_provider, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (app_id) do update set signup_enabled = excluded.signup_enabled,
       email_confirmation = excluded.email_confirmation, allowed_email_domains = excluded.allowed_email_domains,
       redirect_urls = excluded.redirect_urls, sender_name = excluded.sender_name, sender_email = excluded.sender_email,
       sso_provider = excluded.sso_provider, updated_by = excluded.updated_by, updated_at = now()
     returning signup_enabled, email_confirmation, allowed_email_domains, redirect_urls, sender_name, sender_email,
       sso_provider, updated_at`,
    [app.id, next.signup_enabled, next.email_confirmation, next.allowed_email_domains, next.redirect_urls,
      next.sender_name, next.sender_email, next.sso_provider, actor.id],
  );
  await ensureAuthHook(app, saved!);
  await ensureAuthService(app);
  if (changes.sso_provider) await ensureCompanySso(app, saved!.sso_provider);
  await audit(actor.id, app.id, "configure_auth", { changes });
  return { app: app.slug, changed: true, auth: authView(policyApp(app), saved!, smtp, companySso(sso)), warnings };
}
