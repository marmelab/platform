// The platform's own GoTrue (Supabase Auth), used as the OAuth 2.1 authorization server of the MCP endpoint: browser
// sign-in for Claude Code (journey B1, oauth.ts). One container managed like the apps' GoTrue (orchestrator), its
// `auth` schema in the platform database, never routed publicly: the control plane fronts it (oauth.ts). GoTrue keeps
// the OAuth clients (registered by the control plane), the pending authorizations and their PKCE challenge, the single-use codes,
// the consents, and the sessions with their rotating refresh tokens (reuse revokes the family).
//
// Platform accounts stay in `users` (passwords, company SSO, sessions.ts). GoTrue only holds a shadow user per account
// that signed in with Claude Code (same id and email, no password): the consent page acts for it with a short-lived
// JWT signed with GoTrue's secret, after the platform's own login.
import { jwtVerify } from "jose";
import { PLATFORM_AUTH_ROLE, platformAuthSql } from "@platform/sql";
import { ensureService, waitHealthy } from "./apps.ts";
import type { User } from "./auth.ts";
import { apiUrl, config, studioUrl } from "./config.ts";
import { derivedSecret, signJwt } from "./crypto.ts";
import { one, platform, runAll, withAdmin } from "./db.ts";
import type { ServiceSpec } from "./orchestrator.ts";

/** Where GoTrue sends the browser after /oauth/authorize (on the Studio host, with the platform's login). */
export const CONSENT_PATH = "/_platform/oauth/consent";
/** Lifetime of the OAuth access tokens (GoTrue JWTs). */
export const ACCESS_TOKEN_SECONDS = 3600;

const CONTAINER = `${config.docker.prefix}-oauth`;
const BASE_URL = `http://${CONTAINER}:9999`;
/** Header carrying the browser's or client's address, for GoTrue's per-IP rate limits (it only sees the control plane). */
export const CLIENT_IP_HEADER = "X-Platform-Client-Ip";

const jwtSecret = () => derivedSecret("platform-auth-jwt");
const dbPassword = () => derivedSecret("platform-auth-db");
/** `iss` of the access tokens: the authorization server is the API host (oauth.ts publishes its metadata). */
export const tokenIssuer = () => apiUrl();

function spec(): ServiceSpec {
  return {
    name: CONTAINER,
    image: config.docker.gotrueImage,
    // not an app slug (they never start with "_"): removeApp() and the app views never see it
    app: "_platform",
    service: "gotrue",
    memoryMb: 256,
    cmd: ["auth"],
    health: { port: 9999, path: "/health" },
    env: {
      GOTRUE_API_HOST: "0.0.0.0",
      GOTRUE_API_PORT: "9999",
      API_EXTERNAL_URL: apiUrl(),
      GOTRUE_SITE_URL: studioUrl(),
      GOTRUE_DB_DRIVER: "postgres",
      GOTRUE_DB_DATABASE_URL:
        `postgres://${PLATFORM_AUTH_ROLE}:${dbPassword()}@${config.pg.host}:${config.pg.port}/${config.pg.platformDb}?sslmode=disable`,
      GOTRUE_DB_MAX_POOL_SIZE: "3",
      GOTRUE_JWT_SECRET: jwtSecret(),
      GOTRUE_JWT_ISSUER: tokenIssuer(),
      GOTRUE_JWT_EXP: String(ACCESS_TOKEN_SECONDS),
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_JWT_ADMIN_ROLES: "service_role",
      GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
      // accounts come from the platform only: no sign-up, no password, no email
      GOTRUE_DISABLE_SIGNUP: "true",
      GOTRUE_MAILER_AUTOCONFIRM: "true",
      GOTRUE_EXTERNAL_PHONE_ENABLED: "false",
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false",
      GOTRUE_OAUTH_SERVER_ENABLED: "true",
      // clients register through the control plane (oauth.ts), which uses the admin API after its own checks
      GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION: "false",
      GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH: CONSENT_PATH,
      // from /oauth/authorize to the code exchange, sign-in included (the control plane also limits the code to 60 s)
      GOTRUE_OAUTH_SERVER_AUTHORIZATION_TTL: "10m",
      GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "true",
      // a reused refresh token revokes the session's whole token family at once. No grace interval: GoTrue already
      // answers the parent of the current token with the current one (concurrent refreshes, a lost answer), and the
      // interval would also let the current token through for that long after a revocation
      GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: "0",
      GOTRUE_RATE_LIMIT_HEADER: CLIENT_IP_HEADER,
      GOTRUE_LOG_LEVEL: "info",
    },
  };
}

/** Role, schema and container; waits until GoTrue answers (its migrations ran). Idempotent, at every start. */
export async function ensurePlatformAuth() {
  await withAdmin(config.pg.platformDb, (c) => runAll(c, platformAuthSql(config.pg.platformDb, dbPassword())));
  await ensureService(spec());
  await waitHealthy(`${BASE_URL}/health`);
}

export class PlatformAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const serviceToken = () =>
  signJwt({ iss: tokenIssuer(), role: "service_role", iat: now(), exp: now() + 60 }, jwtSecret());
/** Acts for a platform user on GoTrue's user endpoints (consent): no session, valid one minute. */
const userToken = (user: User) =>
  signJwt({
    iss: tokenIssuer(),
    sub: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    iat: now(),
    exp: now() + 60,
  }, jwtSecret());

interface Call {
  method?: string;
  /** JSON body, or a form (URLSearchParams) for /oauth/token. */
  body?: unknown;
  as?: "service" | User | null;
  clientIp?: string;
  /** Do not follow redirects: the caller reads Location (/oauth/authorize). */
  manual?: boolean;
}

/** Raw call to the platform's GoTrue (internal network). */
export async function gotrueFetch(path: string, { method = "GET", body, as = null, clientIp, manual }: Call = {}) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (as) headers.authorization = `Bearer ${as === "service" ? serviceToken() : userToken(as)}`;
  if (clientIp) headers[CLIENT_IP_HEADER] = clientIp;
  let payload: string | undefined;
  if (body instanceof URLSearchParams) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    payload = body.toString();
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: payload,
    redirect: manual ? "manual" : "follow",
    signal: AbortSignal.timeout(15_000),
  });
}

/** JSON call; throws PlatformAuthError on an error status. */
export async function gotrue<T = Record<string, unknown>>(path: string, call: Call = {}): Promise<T> {
  const response = await gotrueFetch(path, call);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON */ }
  if (!response.ok) {
    const message = String(json?.msg ?? json?.message ?? json?.error_description ?? json?.error ?? text.slice(0, 200));
    throw new PlatformAuthError(response.status, `platform auth ${call.method ?? "GET"} ${path}: ${response.status} ${message}`);
  }
  return json as T;
}

/**
 * The account's shadow user in GoTrue (same id and email), created at its first consent. A stale shadow with the same
 * email (account deleted, then created again) is removed first.
 */
export async function ensureShadowUser(user: User) {
  const shadow = await one<{ id: string; email: string | null }>("select id, email from auth.users where id = $1 or email = $2", [
    user.id,
    user.email,
  ]);
  if (shadow?.id === user.id && shadow.email === user.email) return;
  if (shadow) await gotrue(`/admin/users/${shadow.id}`, { method: "DELETE", as: "service" });
  await gotrue("/admin/users", {
    method: "POST",
    as: "service",
    body: { id: user.id, email: user.email, email_confirm: true, app_metadata: { provider: "platform" } },
  });
}

/** Removes an account's shadow user (sessions, consents and pending codes go with it). Best effort. */
export async function deleteShadowUser(userId: string) {
  await gotrue(`/admin/users/${userId}`, { method: "DELETE", as: "service" }).catch((error) => {
    if (!(error instanceof PlatformAuthError && error.status === 404)) console.error("deleting the shadow user failed", error);
  });
}

export interface AccessClaims {
  sub: string;
  session_id: string;
  client_id: string;
}

/** Verifies an OAuth access token issued by the platform's GoTrue; null if it is not one (or invalid, or expired). */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret()), {
      algorithms: ["HS256"],
      issuer: tokenIssuer(),
      requiredClaims: ["exp", "sub", "session_id", "client_id"],
    });
    const { sub, session_id, client_id } = payload as Record<string, unknown>;
    if (typeof sub !== "string" || typeof session_id !== "string" || typeof client_id !== "string") return null;
    return { sub, session_id, client_id };
  } catch {
    return null;
  }
}

/**
 * Revokes an account's Claude Code connection with this client: GoTrue revokes the consent (the next sign-in asks
 * again) and deletes the sessions, hence their refresh tokens.
 */
export async function revokeGrant(user: User, clientId: string) {
  // no shadow user: the account never consented, there is nothing to revoke in GoTrue
  if (!(await one("select 1 from auth.users where id = $1", [user.id]))) return;
  await gotrue(`/user/oauth/grants?client_id=${encodeURIComponent(clientId)}`, { method: "DELETE", as: user }).catch(
    (error) => {
      if (!(error instanceof PlatformAuthError && error.status === 404)) throw error;
    },
  );
}

/** Ends every GoTrue session of an account (disabled account): their refresh tokens stop working at once. */
export async function endOAuthSessions(userId: string) {
  await platform.query("delete from auth.sessions where user_id = $1", [userId]);
}
