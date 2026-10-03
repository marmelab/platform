// Company SSO for an app's users (M6 part 2, journey U2): `configure_auth({ sso: { provider: "company" } })` adds the
// platform's OIDC provider (admin console, SSO) to the app's GoTrue as the custom provider "custom:company", through
// GoTrue's admin API (/admin/custom-providers, GoTrue >= 2.19x): the app signs its users in with
// `supabase.auth.signInWithOAuth({ provider: "custom:company" })`, GoTrue runs the authorization code flow with PKCE
// and verifies the ID token against the issuer's JWKS, and creates the account on the first login (subject to the
// app's sign-up switch and allowed email domains). No container restart: the provider lives in the app database
// (auth.custom_oauth_providers, readable by GoTrue's role only). The IdP client is the platform's: the app's callback
// (<app URL>/auth/v1/callback) must be registered at the IdP as a redirect URI of that client.
import type { AppRow } from "./apps.ts";
import { COMPANY_SSO_PROVIDER, type CompanySso } from "./auth-policy.ts";
import { many, one } from "./db.ts";
import { getSettings, ssoActive, type SsoSettings } from "./settings.ts";

export const companySso = (sso: SsoSettings): CompanySso => ({ name: sso.name, active: ssoActive(sso) });

/**
 * Makes the app's GoTrue match its policy: the provider exists (and is up to date) when the app asks for company SSO
 * and the platform's SSO is active, and is removed otherwise. GoTrue must be running. Idempotent.
 */
export async function ensureCompanySso(app: AppRow, ssoProvider?: string | null) {
  const provider = ssoProvider !== undefined
    ? ssoProvider
    : (await one<{ sso_provider: string | null }>("select sso_provider from app_auth_config where app_id = $1", [app.id]))?.sso_provider ?? null;
  const { sso } = await getSettings();
  // loaded here: auth-users.ts imports apps.ts, which imports this module (provisioning)
  const { gotrueAdmin } = await import("./auth-users.ts");
  const path = `/admin/custom-providers/${COMPANY_SSO_PROVIDER}`;
  const existing = await gotrueAdmin(app, "GET", path, undefined, { allowNotFound: true });
  if (provider === "company" && ssoActive(sso)) {
    const body = {
      name: sso.name,
      client_id: sso.clientId,
      client_secret: sso.clientSecret,
      issuer: sso.issuer,
      scopes: ["openid", "email", "profile"],
      pkce_enabled: true,
      enabled: true,
    };
    // GoTrue fetches the issuer's discovery document on both (an unreachable IdP fails here, not at the first login)
    if (existing) await gotrueAdmin(app, "PUT", path, body);
    else await gotrueAdmin(app, "POST", "/admin/custom-providers", { provider_type: "oidc", identifier: COMPANY_SSO_PROVIDER, ...body });
    return { provider: COMPANY_SSO_PROVIDER, present: true };
  }
  if (existing) await gotrueAdmin(app, "DELETE", path);
  return { provider: COMPANY_SSO_PROVIDER, present: false };
}

/** After a change of the platform's SSO provider settings: every running app that uses it. */
export async function syncCompanySso() {
  const apps = await many<AppRow>(
    `select a.* from apps a join app_auth_config c on c.app_id = a.id
      where a.status = 'running' and c.sso_provider = 'company' order by a.slug`,
  );
  const failed: { app: string; error: string }[] = [];
  for (const app of apps) {
    try {
      await ensureCompanySso(app, "company");
    } catch (error) {
      console.error(`company SSO of ${app.slug} failed`, error);
      failed.push({ app: app.slug, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { apps: apps.length, failed };
}
