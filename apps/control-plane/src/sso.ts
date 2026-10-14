// Company SSO for the platform's web logins (M6 part 2, journey A7): Studio's /_platform/login and the admin console.
// OpenID Connect authorization code flow with PKCE (S256), state and nonce. The pending login (state, nonce, PKCE
// verifier, where to go next) lives in a short-lived cookie encrypted with the master key (AES-GCM), bound to the host
// that started it; the ID token is verified against the issuer's JWKS (jose), then its email is checked against the
// platform policy (verified, allowed domains) and linked to a platform account: by its IdP subject once linked, by
// email the first time, or created as a developer when just-in-time creation is on. Sessions are the platform's usual
// browser sessions (sessions.ts). Every SSO login, accepted or refused, is audited.
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { User } from "./auth.ts";
import { audit } from "./audit.ts";
import { adminUrl, studioUrl } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { one } from "./db.ts";
import { getSettings, ssoActive, type SsoSettings } from "./settings.ts";
import {
  basicAuth,
  checkAuthorizedParty,
  checkedEmail,
  pkceChallenge,
  sameSecret,
  SsoError,
  tokenAuthMethod,
} from "./sso-policy.ts";
import { randomBytes } from "node:crypto";

export { SsoError } from "./sso-policy.ts";

/** Where the login started and returns: Studio, or the admin console (admins only). */
export type SsoVia = "studio" | "admin";

export const SSO_COOKIE = "platform_sso";
/** Time allowed between the redirect to the IdP and the callback. */
export const SSO_PENDING_SECONDS = 600;
const SCOPE = "openid email profile";
/** Asymmetric algorithms only: an HS256 ID token would be signed with our own client secret. */
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

export const ssoCallbackUrl = (via: SsoVia) =>
  via === "studio" ? studioUrl("/_platform/sso/callback") : adminUrl("/api/auth/sso/callback");
/** Path of the pending-login cookie: only sent to the callback. */
export const ssoCookiePath = (via: SsoVia) => (via === "studio" ? "/_platform/sso" : "/api/auth/sso");

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const discoveries = new Map<string, { doc: Discovery; at: number }>();
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * The IdP's discovery document (cached 10 minutes). Its issuer must be the configured one, exactly (OIDC Discovery
 * §4.3). `fresh` skips the cache: the admin console checks a new configuration with it.
 */
/** "fetch failed" says nothing, a JSON parse error quotes the page: the cause's code, "timeout" or "not JSON". */
function shortReason(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return "timeout";
  if (error instanceof SyntaxError) return "not JSON";
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : error.message;
}

export async function discover(sso: Pick<SsoSettings, "issuer" | "discoveryUrl">, { fresh = false } = {}): Promise<Discovery> {
  const cached = discoveries.get(sso.discoveryUrl);
  if (!fresh && cached && cached.doc.issuer === sso.issuer && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  let doc: Discovery;
  try {
    const response = await fetch(sso.discoveryUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    doc = await response.json() as Discovery;
  } catch (error) {
    throw new SsoError("discovery_failed", `Discovery document unreachable (${shortReason(error)}): ${sso.discoveryUrl}`);
  }
  if (doc.issuer !== sso.issuer) {
    throw new SsoError("discovery_failed", `The discovery document's issuer is "${doc.issuer}", not the configured "${sso.issuer}".`);
  }
  const missing = (["authorization_endpoint", "token_endpoint", "jwks_uri"] as const).filter((k) => typeof doc[k] !== "string" || !doc[k]);
  if (missing.length) throw new SsoError("discovery_failed", `The discovery document has no ${missing.join(", ")}.`);
  discoveries.set(sso.discoveryUrl, { doc, at: Date.now() });
  return doc;
}

function keySet(jwksUri: string) {
  let set = keySets.get(jwksUri);
  if (!set) {
    // jose caches the keys and refetches on an unknown kid (key rotation)
    set = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 10_000 });
    keySets.set(jwksUri, set);
  }
  return set;
}

interface Pending {
  via: SsoVia;
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
}

const random = () => randomBytes(32).toString("base64url");

/** The redirect to the IdP, and the encrypted pending-login cookie to set with it. */
export async function startSsoLogin(via: SsoVia, next: string) {
  const { sso } = await getSettings();
  if (!ssoActive(sso)) throw new SsoError("sso_disabled", "Company SSO is not enabled on this platform.");
  const doc = await discover(sso);
  const pending: Pending = {
    via,
    state: random(),
    nonce: random(),
    verifier: random(),
    next,
    exp: Math.floor(Date.now() / 1000) + SSO_PENDING_SECONDS,
  };
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    ...Object.fromEntries(url.searchParams),
    response_type: "code",
    client_id: sso.clientId,
    redirect_uri: ssoCallbackUrl(via),
    scope: SCOPE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: pkceChallenge(pending.verifier),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), cookie: encrypt(JSON.stringify(pending)) };
}

function readPending(via: SsoVia, cookie: string | undefined): Pending {
  const expired = new SsoError("no_pending_login", "This sign-in attempt expired or was started in another browser: sign in again.");
  if (!cookie) throw expired;
  let pending: Pending;
  try {
    pending = JSON.parse(decrypt(cookie)) as Pending;
  } catch {
    throw expired;
  }
  if (pending.via !== via || pending.exp < Date.now() / 1000) throw expired;
  return pending;
}

async function exchangeCode(sso: SsoSettings, doc: Discovery, via: SsoVia, code: string, verifier: string) {
  const method = tokenAuthMethod(doc.token_endpoint_auth_methods_supported);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ssoCallbackUrl(via),
    code_verifier: verifier,
    ...(method === "post" ? { client_id: sso.clientId, client_secret: sso.clientSecret } : {}),
  });
  let response: Response;
  try {
    response = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...(method === "basic" ? { authorization: basicAuth(sso.clientId, sso.clientSecret) } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new SsoError("token_failed", `The identity provider's token endpoint is unreachable: ${error instanceof Error ? error.message : error}`);
  }
  const json = await response.json().catch(() => ({})) as { id_token?: unknown; error?: string; error_description?: string };
  if (!response.ok) {
    throw new SsoError("token_failed", `The identity provider refused the code: ${json.error_description ?? json.error ?? `HTTP ${response.status}`}`);
  }
  if (typeof json.id_token !== "string") throw new SsoError("token_failed", "The identity provider returned no ID token.");
  return json.id_token;
}

async function verifyIdToken(sso: SsoSettings, doc: Discovery, idToken: string, nonce: string) {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, keySet(doc.jwks_uri), {
      issuer: sso.issuer,
      audience: sso.clientId,
      algorithms: ALGORITHMS,
      clockTolerance: 60,
      requiredClaims: ["exp", "iat", "sub"],
    }));
  } catch (error) {
    if (error instanceof errors.JWTClaimValidationFailed) {
      throw new SsoError("invalid_id_token", `The ID token was rejected (${error.claim} ${error.reason === "check_failed" ? "mismatch" : error.reason}).`);
    }
    if (error instanceof errors.JOSEError) throw new SsoError("invalid_id_token", `The ID token was rejected (${error.code}).`);
    throw error;
  }
  checkAuthorizedParty(payload as { aud?: string | string[]; azp?: unknown }, sso.clientId);
  if (typeof payload.nonce !== "string" || !sameSecret(payload.nonce, nonce)) {
    throw new SsoError("nonce_mismatch", "The ID token does not belong to this sign-in attempt (nonce).");
  }
  return payload;
}

interface Account extends User {
  active: boolean;
  sso_issuer: string | null;
  sso_subject: string | null;
}

const ACCOUNT = "select id, email, name, role, active, sso_issuer, sso_subject from users";

/** The platform account of this IdP identity: linked subject, else verified email (then linked), else JIT or refusal. */
async function resolveAccount(sso: SsoSettings, via: SsoVia, subject: string, email: string, name: string | null) {
  let account = await one<Account>(`${ACCOUNT} where sso_issuer = $1 and sso_subject = $2`, [sso.issuer, subject]);
  let linked = false;
  let created = false;
  if (!account) {
    account = await one<Account>(`${ACCOUNT} where email = $1`, [email]);
    if (account?.sso_subject && account.sso_issuer === sso.issuer) {
      throw new SsoError("subject_mismatch", `The account ${email} is linked to another identity of the identity provider: ask an admin to unlink it.`, email);
    }
    if (!account) {
      // just-in-time accounts are developers: never created from the admin console's sign-in
      if (sso.autoCreate !== "developer" || via === "admin") {
        throw new SsoError("unknown_user", `There is no platform account for ${email}: ask an admin to create it.`, email);
      }
      account = await one<Account>(
        `insert into users (email, name, role, sso_issuer, sso_subject) values ($1, $2, 'developer', $3, $4)
         on conflict (email) do nothing returning id, email, name, role, active, sso_issuer, sso_subject`,
        [email, name, sso.issuer, subject],
      );
      if (!account) throw new SsoError("unknown_user", "The account was created concurrently: sign in again.", email);
      created = true;
    } else {
      await one("update users set sso_issuer = $2, sso_subject = $3 where id = $1", [account.id, sso.issuer, subject]);
      linked = true;
    }
  }
  if (!account.active) throw new SsoError("account_disabled", `The account ${account.email} is disabled.`, account.email);
  const user: User = { id: account.id, email: account.email, name: account.name, role: account.role };
  return { user, linked, created };
}

/**
 * Handles the IdP's redirect: pending login (state), code exchange with the PKCE verifier, ID token (signature, issuer,
 * audience, expiry, nonce), email policy, account. Throws SsoError (audited as login_sso_refused) on any refusal.
 */
export async function finishSsoLogin(
  via: SsoVia,
  query: { code?: string; state?: string; error?: string; error_description?: string },
  cookie: string | undefined,
): Promise<{ user: User; next: string }> {
  let email: string | null = null;
  try {
    const pending = readPending(via, cookie);
    if (!query.state || !sameSecret(query.state, pending.state)) {
      throw new SsoError("state_mismatch", "This sign-in response does not match the sign-in attempt (state): sign in again.");
    }
    if (query.error) {
      throw new SsoError("idp_error", `The identity provider refused the sign-in: ${query.error_description ?? query.error}`);
    }
    if (!query.code) throw new SsoError("no_code", "The identity provider sent no authorization code.");
    const { sso } = await getSettings();
    if (!ssoActive(sso)) throw new SsoError("sso_disabled", "Company SSO is not enabled on this platform.");
    const doc = await discover(sso);
    const idToken = await exchangeCode(sso, doc, via, query.code, pending.verifier);
    const claims = await verifyIdToken(sso, doc, idToken, pending.nonce);
    email = checkedEmail(claims, sso);
    const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 200) : null;
    const { user, linked, created } = await resolveAccount(sso, via, String(claims.sub), email, name);
    if (via === "admin" && user.role !== "admin") {
      throw new SsoError("not_admin", "This console is reserved to platform admins.", user.email);
    }
    await audit(user.id, null, "login_sso", { via, issuer: sso.issuer, subject: String(claims.sub), linked, created });
    return { user, next: pending.next };
  } catch (error) {
    if (error instanceof SsoError) {
      const who = error.email ?? email;
      const account = who ? await one<{ id: string }>("select id from users where email = $1", [who]) : undefined;
      await audit(account?.id ?? null, null, "login_sso_refused", { via, email: who, reason: error.reason });
      console.warn(`sso login refused (${via}): ${error.reason}${who ? ` for ${who}` : ""}`);
    }
    throw error;
  }
}

/** The public view of SSO for the login pages. */
export async function ssoLoginOptions() {
  const { sso } = await getSettings();
  const active = ssoActive(sso);
  return { enabled: active, name: sso.name, password_login: active ? sso.passwordLogin : "everyone" };
}
