// OAuth 2.1 authorization for the MCP endpoint (MCP specification, "Authorization"; journey B1): Claude Code finds the
// authorization server from the 401 of /mcp, registers itself (RFC 7591), opens the browser on /oauth/authorize, and
// gets tokens from /oauth/token, which it stores in the keychain and refreshes. claude.ai connectors (used by Claude Code
// on the web) do the same from Anthropic's servers, with claude.ai's callback. The authorization server is the
// platform's GoTrue (platform-auth.ts); these routes, on the API host, front it: they publish the metadata (RFC 9728,
// RFC 8414) and apply the platform's rules before forwarding (oauth-policy.ts): Claude's clients only, PKCE S256, the MCP
// endpoint as the only resource, codes exchanged within 60 s by an active account, a connection row per GoTrue session
// (`tokens`, kind 'oauth') that the admin console lists and revokes. The consent page is on the Studio host, behind
// the platform's login (studio/routes.ts).
import { type Context, Hono } from "hono";
import type { User } from "./auth.ts";
import { audit } from "./audit.ts";
import { apiUrl, config, loopbackTokenHost, oauthTokenEndpoint, studioUrl } from "./config.ts";
import { one, platform } from "./db.ts";
import {
  checkAuthorizeRequest,
  codeFresh,
  errorRedirect,
  isAllowedRedirect,
  OAuthError,
  redirectsToRegister,
  sanitizeRegistration,
} from "./oauth-policy.ts";
import {
  CONSENT_PATH,
  ensureShadowUser,
  gotrue,
  gotrueFetch,
  PlatformAuthError,
  verifyAccessToken,
} from "./platform-auth.ts";
import { requestIp } from "./sessions.ts";

export const mcpResource = () => `${apiUrl()}/mcp`;
const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const resourceMetadataUrl = () => `${apiUrl()}${PROTECTED_RESOURCE_PATH}/mcp`;

/** The 401 challenge of /mcp: where to find the authorization server (RFC 9728 §5.1). */
export const mcpChallenge = (tokenGiven: boolean) =>
  `Bearer realm="platform", resource_metadata="${resourceMetadataUrl()}"${tokenGiven ? ', error="invalid_token"' : ""}`;

export const oauthRoutes = new Hono();

const hostname = (host: string | undefined) => (host ?? "").split(":")[0];

async function apiHostOnly(c: Context, next: () => Promise<void>) {
  const host = hostname(c.req.header("host"));
  const loopbackToken = c.req.path === "/oauth/token" && host === loopbackTokenHost();
  if (host !== config.apiHost && !loopbackToken) return c.notFound();
  // production: HTTPS only (Caddy redirects plain HTTP; a request that still arrives over it is refused)
  if (config.publicScheme === "https" && c.req.header("x-forwarded-proto") === "http") {
    return c.json({ error: "invalid_request", error_description: "HTTPS is required" }, 400);
  }
  await next();
}
oauthRoutes.use("/.well-known/*", apiHostOnly);
oauthRoutes.use("/oauth/*", apiHostOnly);

const protectedResource = (c: Context) =>
  c.json({
    resource: mcpResource(),
    authorization_servers: [apiUrl()],
    bearer_methods_supported: ["header"],
    resource_name: "Platform",
  });

oauthRoutes.get(PROTECTED_RESOURCE_PATH, protectedResource);
oauthRoutes.get(`${PROTECTED_RESOURCE_PATH}/mcp`, protectedResource);

oauthRoutes.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: apiUrl(),
    authorization_endpoint: `${apiUrl()}/oauth/authorize`,
    token_endpoint: oauthTokenEndpoint(),
    registration_endpoint: `${apiUrl()}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${studioUrl()}/_platform/login`,
  }));

const oauthError = (c: Context, error: OAuthError, status: 400 | 401 = 400) =>
  c.json({ error: error.error, error_description: error.description }, status);

/** Forwards GoTrue's answer as is (status and JSON body). */
async function relay(c: Context, response: Response) {
  return c.body(await response.text(), response.status as 200, {
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
}

/**
 * GoTrue's token errors in the RFC 6749 §5.2 shape: its refresh errors are its own ({code, error_code, msg}), and a
 * client only knows it must sign in again from `invalid_grant`.
 */
async function tokenFailure(c: Context, response: Response) {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.error === "string") return c.json(body, response.status >= 500 ? 502 : 400);
  if (response.status >= 500 || response.status === 429) {
    return c.json({ error: "temporarily_unavailable", error_description: String(body.msg ?? "try again later") }, 503);
  }
  return oauthError(c, new OAuthError("invalid_grant", String(body.msg ?? "the grant is invalid")));
}

oauthRoutes.post("/oauth/register", async (c) => {
  let registration;
  try {
    registration = sanitizeRegistration(await c.req.json().catch(() => null));
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(c, error);
    throw error;
  }
  // through the admin API: GoTrue's own dynamic registration is off, so that nothing on the internal network can
  // register a client without these checks
  const response = await gotrueFetch("/admin/oauth/clients", { method: "POST", as: "service", body: registration });
  if (!response.ok) return relay(c, response);
  const client = await response.json() as Record<string, unknown>;
  return c.json({ ...client, registration_type: undefined, client_secret: undefined }, 201);
});

interface ClientRow {
  id: string;
  client_name: string | null;
  redirect_uris: string;
}

const findClient = (id: string) =>
  /^[0-9a-f-]{36}$/i.test(id)
    ? one<ClientRow>("select id, client_name, redirect_uris from auth.oauth_clients where id = $1 and deleted_at is null", [id])
    : Promise.resolve(undefined);

/** Errors that cannot go back to the client (unknown client or redirect URI): shown in the browser. */
const authorizeFailure = (c: Context, message: string) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>This sign-in request is invalid: ${
      message.replace(/[&<>"']/g, "")
    }. Start again from Claude.</p>`,
    400,
  );

oauthRoutes.get("/oauth/authorize", async (c) => {
  c.header("Cache-Control", "no-store");
  const query = c.req.query();
  const client = await findClient(query.client_id ?? "");
  if (!client) return authorizeFailure(c, "unknown client");
  const redirectUri = query.redirect_uri ?? "";
  if (!isAllowedRedirect(redirectUri)) return authorizeFailure(c, "redirect_uri is not allowed");
  try {
    // GoTrue matches redirect URIs exactly: a loopback URI on another port (RFC 8252) is added to the client first
    const redirects = redirectsToRegister(client.redirect_uris.split(","), redirectUri);
    if (redirects) await gotrue(`/admin/oauth/clients/${client.id}`, { method: "PUT", as: "service", body: { redirect_uris: redirects } });
  } catch (error) {
    if (error instanceof OAuthError) return authorizeFailure(c, error.description);
    throw error;
  }
  try {
    checkAuthorizeRequest(query, mcpResource());
  } catch (error) {
    if (error instanceof OAuthError) return c.redirect(errorRedirect(redirectUri, error, query.state), 302);
    throw error;
  }
  const response = await gotrueFetch(`/oauth/authorize?${new URL(c.req.url).searchParams}`, {
    manual: true,
    clientIp: await requestIp(c),
  });
  const location = response.headers.get("location");
  // GoTrue sends the browser to the consent page, or the client an error about its request
  if (response.status === 302 && location && (location.startsWith(studioUrl(CONSENT_PATH)) || location.startsWith(redirectUri))) {
    return c.redirect(location, 302);
  }
  console.error(`oauth authorize: unexpected answer from the platform's GoTrue: ${response.status} ${await response.text()}`);
  return authorizeFailure(c, "the platform could not start the sign-in");
});

interface TokenAnswer {
  access_token?: string;
  [key: string]: unknown;
}

/**
 * The connection row of a GoTrue session, created at the code exchange; refused (and the session ended) when the
 * account was disabled or the connection revoked meanwhile.
 */
async function recordConnection(accessToken: string, created: boolean): Promise<boolean> {
  const claims = await verifyAccessToken(accessToken);
  if (!claims) return false;
  if (created) {
    const client = await one<{ client_name: string | null }>("select client_name from auth.oauth_clients where id = $1", [claims.client_id]);
    const inserted = await one<{ id: string }>(
      `insert into tokens (user_id, name, kind, oauth_session_id, oauth_client_id, last_used_at)
       select u.id, $3, 'oauth', $2, $4, now() from users u where u.id = $1 and u.active
       on conflict (oauth_session_id) do nothing returning id`,
      [claims.sub, claims.session_id, client?.client_name || "OAuth client", claims.client_id],
    );
    if (inserted) {
      await audit(claims.sub, null, "oauth_connect", { token_id: inserted.id, client_id: claims.client_id, client_name: client?.client_name ?? null });
    }
  }
  const live = await one(
    `select 1 from tokens t join users u on u.id = t.user_id
      where t.kind = 'oauth' and t.oauth_session_id = $1 and t.revoked_at is null and u.active`,
    [claims.session_id],
  );
  if (!live) await platform.query("delete from auth.sessions where id = $1", [claims.session_id]);
  return !!live;
}

oauthRoutes.post("/oauth/token", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  const form = new URLSearchParams(await c.req.text());
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    if (!form.get("code_verifier") || !form.get("redirect_uri")) {
      return oauthError(c, new OAuthError("invalid_request", "code_verifier and redirect_uri are required"));
    }
    const pending = await one<{ approved_at: Date | null; active: boolean | null }>(
      `select a.approved_at, u.active from auth.oauth_authorizations a left join users u on u.id = a.user_id
        where a.authorization_code = $1`,
      [form.get("code") ?? ""],
    );
    if (pending && !codeFresh(pending.approved_at, new Date())) {
      return oauthError(c, new OAuthError("invalid_grant", "the authorization code expired"));
    }
    if (pending && !pending.active) return oauthError(c, new OAuthError("invalid_grant", "the account is disabled"));
  } else if (grant !== "refresh_token") {
    return oauthError(c, new OAuthError("unsupported_grant_type", "authorization_code and refresh_token only"));
  }
  const response = await gotrueFetch("/oauth/token", { method: "POST", body: form, clientIp: await requestIp(c) });
  if (!response.ok) return tokenFailure(c, response);
  const answer = await response.json() as TokenAnswer;
  if (!answer.access_token || !(await recordConnection(answer.access_token, grant === "authorization_code"))) {
    return oauthError(c, new OAuthError("invalid_grant", "the account is disabled or its access was revoked"));
  }
  return c.json(answer);
});

// ---------------------------------------------------------------------------------------------------------------
// Consent (Studio host, studio/routes.ts): GoTrue's authorization details and decision, for the signed-in account

export interface ConsentRequest {
  authorizationId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
}

export class ConsentError extends Error {}

/**
 * What the consent page shows, or the client's redirect when the account already consented to this client (GoTrue
 * approves at once: a revoked connection asks again).
 */
export async function consentRequest(user: User, authorizationId: string): Promise<ConsentRequest | { redirect: string }> {
  await ensureShadowUser(user);
  let details: Record<string, any>;
  try {
    details = await gotrue(`/oauth/authorizations/${encodeURIComponent(authorizationId)}`, { as: user });
  } catch (error) {
    if (error instanceof PlatformAuthError && error.status < 500) {
      throw new ConsentError("This sign-in request expired or was already used. Start again from Claude.");
    }
    throw error;
  }
  if (typeof details.redirect_url === "string") {
    const client = await clientOf(authorizationId);
    await audit(user.id, null, "oauth_authorize", { client_id: client?.id ?? null, client_name: client?.client_name ?? null, approved: true, remembered: true });
    return { redirect: checkedRedirect(details.redirect_url) };
  }
  return {
    authorizationId,
    clientId: String(details.client?.id ?? ""),
    clientName: String(details.client?.name || "An application"),
    redirectUri: String(details.redirect_uri ?? ""),
  };
}

const clientOf = (authorizationId: string) =>
  one<{ id: string; client_name: string | null }>(
    `select c.id, c.client_name from auth.oauth_authorizations a join auth.oauth_clients c on c.id = a.client_id
      where a.authorization_id = $1`,
    [authorizationId],
  );

/** GoTrue only redirects to the client's registered URIs, all allowed ones: checked again before sending the browser. */
function checkedRedirect(url: string) {
  const parsed = new URL(url);
  if (!isAllowedRedirect(`${parsed.origin}${parsed.pathname}`)) throw new Error(`unexpected OAuth redirect ${parsed.origin}`);
  return url;
}

/** Approves or denies; returns where to send the browser (the client, with its code or the refusal). */
export async function decideConsent(user: User, authorizationId: string, approve: boolean): Promise<string> {
  await ensureShadowUser(user);
  const client = await clientOf(authorizationId);
  let answer: { redirect_url?: string };
  try {
    answer = await gotrue(`/oauth/authorizations/${encodeURIComponent(authorizationId)}/consent`, {
      method: "POST",
      as: user,
      body: { action: approve ? "approve" : "deny" },
    });
  } catch (error) {
    if (error instanceof PlatformAuthError && error.status < 500) {
      throw new ConsentError("This sign-in request expired or was already used. Start again from Claude.");
    }
    throw error;
  }
  if (typeof answer.redirect_url !== "string") throw new Error("the platform's GoTrue returned no redirect");
  await audit(user.id, null, "oauth_authorize", { client_id: client?.id ?? null, client_name: client?.client_name ?? null, approved: approve });
  return checkedRedirect(answer.redirect_url);
}
