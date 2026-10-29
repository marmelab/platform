import { createHmac, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { appsForUser, studio, UserError } from "../apps.ts";
import type { User } from "../auth.ts";
import { audit } from "../audit.ts";
import { apiUrl, config, studioUrl } from "../config.ts";
import { TooManyAttempts } from "../login-limit.ts";
import { createSession, logout, SESSION_COOKIE, throttledCredentials, userForSession } from "../sessions.ts";
import { getSettings, ssoActive } from "../settings.ts";
import { finishSsoLogin, SSO_COOKIE, SSO_PENDING_SECONDS, ssoCookiePath, SsoError, startSsoLogin } from "../sso.ts";
import { passwordLoginRefused, safeNext as localPath } from "../sso-policy.ts";
import { ConsentError, consentRequest, connectorClient, connectorClientId, decideConsent, mcpResource } from "../oauth.ts";
import { CONNECTOR_PATH, CONSENT_PATH } from "../platform-auth.ts";
import {
  connectorPage,
  type ConnectorSetup,
  consentPage,
  loginPage,
  oauthMessagePage,
  refusedPage,
  type SsoOption,
} from "./pages.ts";
import { crossSiteRefusal, studioAccess } from "./policy.ts";
import { realtimeInspectorToken } from "./realtime-token.ts";


const secure = () => config.publicScheme === "https";
const fromStudioHost = (host: string | undefined) => (host ?? "").split(":")[0] === config.studio.host;

const safeNext = (next: string | undefined) => localPath(next, "/projects");

/** The SSO button of the login page, when company SSO is active (M6 part 2). */
async function ssoOption(): Promise<SsoOption | null> {
  const { sso } = await getSettings();
  return ssoActive(sso) ? { name: sso.name, passwordLogin: sso.passwordLogin } : null;
}

function openSession(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: secure(),
    path: "/",
    maxAge: config.sessionTtlSeconds,
  });
}

export function identityHeaders(user: User, apps: string[], now = Math.floor(Date.now() / 1000)) {
  const appsHeader = apps.join(",");
  const signature = createHmac("sha256", config.studio.headerSecret)
    .update(`${user.email}\n${user.role}\n${appsHeader}\n${now}`)
    .digest("hex");
  return {
    "X-Platform-User": user.email,
    "X-Platform-Role": user.role,
    "X-Platform-Apps": appsHeader,
    "X-Platform-Signature": `t=${now},s=${signature}`,
  };
}

/** Public routes, served under the Studio host (Caddy sends /_platform/* here without forward auth). */
export const studioPublicRoutes = new Hono();

studioPublicRoutes.use("/_platform/*", async (c, next) => {
  if (!fromStudioHost(c.req.header("host"))) return c.notFound();
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  // login CSRF and forced logout: the forms are posted by Studio's own pages
  const refusal = crossSiteRefusal({
    method: c.req.method,
    uri: c.req.path,
    origin: c.req.header("origin"),
    fetchSite: c.req.header("sec-fetch-site"),
    studioOrigin: studioUrl(),
  });
  if (refusal) {
    console.warn(`studio ${c.req.method} ${c.req.path} refused: ${refusal}`);
    return c.text(`${refusal}\n`, 403);
  }
  await next();
});

studioPublicRoutes.get("/_platform/login", async (c) =>
  c.html(loginPage({ next: safeNext(c.req.query("next")), sso: await ssoOption() })));

studioPublicRoutes.post("/_platform/login", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "");
  const next = safeNext(String(form.next ?? ""));
  const sso = await ssoOption();
  let user;
  try {
    user = await throttledCredentials(c, email, String(form.password ?? ""));
  } catch (error) {
    if (!(error instanceof TooManyAttempts)) throw error;
    c.header("Retry-After", String(error.retryAfterSeconds));
    return c.html(loginPage({ next, email, error: error.message, sso }), 429);
  }
  if (!user) {
    console.warn(`studio login failed for ${JSON.stringify(email)}`);
    return c.html(loginPage({ next, email, error: "Invalid email or password.", sso }), 401);
  }
  // M6 part 2: with sso_password_login=admins, builders sign in with SSO only (checked after the password, so that
  // the answer tells nothing about an account without its password)
  if (sso && passwordLoginRefused(user.role, sso, true)) {
    console.warn(`studio password login refused for ${user.email}: SSO only`);
    return c.html(loginPage({ next, email, error: `Password sign-in is reserved to admins: sign in with ${sso.name}.`, sso }), 403);
  }
  openSession(c, await createSession(user.id));
  return c.redirect(next, 303);
});

// Company SSO (M6 part 2, sso.ts): the button of the login page starts here, the IdP redirects back to the callback
studioPublicRoutes.get("/_platform/sso/start", async (c) => {
  const next = safeNext(c.req.query("next"));
  try {
    const { url, cookie } = await startSsoLogin("studio", next);
    setCookie(c, SSO_COOKIE, cookie, {
      httpOnly: true,
      sameSite: "Lax", // sent back on the IdP's top-level redirect to the callback
      secure: secure(),
      path: ssoCookiePath("studio"),
      maxAge: SSO_PENDING_SECONDS,
    });
    return c.redirect(url, 302);
  } catch (error) {
    if (!(error instanceof SsoError)) throw error;
    return c.html(loginPage({ next, error: error.message, sso: await ssoOption() }), 503);
  }
});

studioPublicRoutes.get("/_platform/sso/callback", async (c) => {
  const cookie = getCookie(c, SSO_COOKIE);
  deleteCookie(c, SSO_COOKIE, { path: ssoCookiePath("studio"), secure: secure() });
  try {
    const { user, next } = await finishSsoLogin("studio", c.req.query(), cookie);
    openSession(c, await createSession(user.id));
    return c.redirect(safeNext(next), 303);
  } catch (error) {
    if (!(error instanceof SsoError)) throw error;
    return c.html(loginPage({ next: "/projects", error: error.message, sso: await ssoOption() }), 403);
  }
});

studioPublicRoutes.post("/_platform/logout", async (c) => {
  await logout(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secure() });
  return c.redirect("/_platform/login", 303);
});

// Consent of a Claude Code sign-in (OAuth, oauth.ts): GoTrue's /oauth/authorize sends the browser here, behind the
// platform's own login (password or company SSO, throttled); the form is protected like the login form (Origin).
const consentLogin = (c: Context, authorizationId: string) =>
  c.redirect(`/_platform/login?next=${encodeURIComponent(`${CONSENT_PATH}?authorization_id=${encodeURIComponent(authorizationId)}`)}`, 302);

const consentFailure = (c: Context, error: unknown) => {
  if (!(error instanceof ConsentError)) throw error;
  return c.html(oauthMessagePage(error.title, error.message), 400);
};

studioPublicRoutes.get(CONSENT_PATH, async (c) => {
  const authorizationId = c.req.query("authorization_id") ?? "";
  if (!authorizationId) return c.html(oauthMessagePage("Invalid request", "Start again from Claude."), 400);
  const user = await userForSession(getCookie(c, SESSION_COOKIE));
  if (!user) return consentLogin(c, authorizationId);
  try {
    const request = await consentRequest(user, authorizationId);
    if ("redirect" in request) return c.redirect(request.redirect, 302);
    return c.html(consentPage({ authorizationId, clientName: request.clientName, redirectUri: request.redirectUri, email: user.email }));
  } catch (error) {
    return consentFailure(c, error);
  }
});

studioPublicRoutes.post(CONSENT_PATH, async (c) => {
  const form = await c.req.parseBody();
  const authorizationId = String(form.authorization_id ?? "");
  const user = await userForSession(getCookie(c, SESSION_COOKIE));
  if (!user) return consentLogin(c, authorizationId);
  try {
    const redirect = await decideConsent(user, authorizationId, form.decision === "approve");
    return c.redirect(redirect, 303);
  } catch (error) {
    return consentFailure(c, error);
  }
});

// The Connect Claude page (Claude Code on the web, INSTALL.md §7), behind the platform's login: the connector's setup,
// and a builder's own connector client (claude.ai Pro or Max), created or given a new secret by its form (protected
// like the login form)
const connectorLogin = (c: Context) => c.redirect(`/_platform/login?next=${encodeURIComponent(CONNECTOR_PATH)}`, 302);

async function connectorSetup(user: User, issued?: { client_id: string; client_secret?: string }): Promise<ConnectorSetup> {
  const { claudeWebEnvironment } = await getSettings();
  return {
    email: user.email,
    clientId: issued?.client_id ?? await connectorClientId(user.id),
    secret: issued?.client_secret,
    mcpUrl: mcpResource(),
    hosts: [config.apiHost, `*.${config.appsDomain}`],
    setupScript: `curl -fsSL ${apiUrl()}/plugin/cloud-setup.sh | bash`,
    // the name the platform's links open (claude_web_environment)
    environment: claudeWebEnvironment || "Platform",
  };
}

studioPublicRoutes.get(CONNECTOR_PATH, async (c) => {
  const user = await userForSession(getCookie(c, SESSION_COOKIE));
  if (!user) return connectorLogin(c);
  return c.html(connectorPage(await connectorSetup(user)));
});

studioPublicRoutes.post(CONNECTOR_PATH, async (c) => {
  const user = await userForSession(getCookie(c, SESSION_COOKIE));
  if (!user) return connectorLogin(c);
  const issued = await connectorClient(user, true);
  await audit(user.id, null, "claude_connector_secret", { client_id: issued.client_id, source: "connect_page" });
  return c.html(connectorPage(await connectorSetup(user, issued)));
});

/** Internal listener: Caddy forward auth and Studio's project configs. Never routed by the public Caddy server. */
export const studioInternalRoutes = new Hono();

studioInternalRoutes.get("/studio/verify", async (c) => {
  const method = c.req.header("x-forwarded-method") ?? "GET";
  const uri = c.req.header("x-forwarded-uri") ?? "/";
  const refusal = crossSiteRefusal({
    method,
    uri,
    origin: c.req.header("origin"),
    fetchSite: c.req.header("sec-fetch-site"),
    studioOrigin: studioUrl(),
  });
  if (refusal) {
    console.warn(`studio 403 ${method} ${uri}: ${refusal}`);
    return c.json({ error: { message: refusal } }, 403);
  }
  const user = await userForSession(getCookie(c, SESSION_COOKIE));
  const isPage = method === "GET" && (c.req.header("accept") ?? "").includes("text/html") && !uri.startsWith("/api/");
  if (!user) {
    if (isPage) return c.redirect(`/_platform/login?next=${encodeURIComponent(uri)}`, 302);
    return c.json({ error: { message: "Unauthorized: sign in at /_platform/login" } }, 401);
  }
  const apps = (await appsForUser(user)).map((app) => app.slug);
  const access = studioAccess(method, uri, { role: user.role, apps });
  if (!access.allow) {
    console.warn(`studio ${access.status} ${user.email} ${method} ${uri}: ${access.reason}`);
    if (isPage) return c.html(refusedPage(access.reason), access.status);
    return c.json({ error: { message: access.reason } }, access.status);
  }
  for (const [name, value] of Object.entries(identityHeaders(user, apps))) c.header(name, value);
  return c.body(null, 200);
});

/** Studio's server: bearer PLATFORM_STUDIO_CONFIG_TOKEN. */
function fromStudioServer(c: Context) {
  const expected = Buffer.from(`Bearer ${config.studio.configToken}`);
  const actual = Buffer.from(c.req.header("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

studioInternalRoutes.get("/internal/studio/projects", async (c) => {
  if (!fromStudioServer(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json(await studio.projects());
});

/** Realtime Inspector token for {user, ref}: Studio's server has checked the request's signed identity. */
studioInternalRoutes.post("/internal/studio/realtime-token", async (c) => {
  if (!fromStudioServer(c)) return c.json({ error: "unauthorized" }, 401);
  const { user, ref } = await c.req.json<{ user?: unknown; ref?: unknown }>().catch(() => ({ user: null, ref: null }));
  if (typeof user !== "string" || typeof ref !== "string") return c.json({ error: "user and ref are required" }, 400);
  try {
    return c.json(await realtimeInspectorToken(user, ref));
  } catch (error) {
    if (error instanceof UserError) return c.json({ error: error.message }, 403);
    throw error;
  }
});
