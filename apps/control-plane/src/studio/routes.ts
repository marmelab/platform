import { createHmac, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { appsForUser, studio } from "../apps.ts";
import type { User } from "../auth.ts";
import { config, studioUrl } from "../config.ts";
import { TooManyAttempts } from "../login-limit.ts";
import { createSession, logout, SESSION_COOKIE, throttledCredentials, userForSession } from "../sessions.ts";
import { getSettings, ssoActive } from "../settings.ts";
import { finishSsoLogin, SSO_COOKIE, SSO_PENDING_SECONDS, ssoCookiePath, SsoError, startSsoLogin } from "../sso.ts";
import { passwordLoginRefused, safeNext as localPath } from "../sso-policy.ts";
import { loginPage, refusedPage, type SsoOption } from "./pages.ts";
import { crossSiteRefusal, studioAccess } from "./policy.ts";


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

studioInternalRoutes.get("/internal/studio/projects", async (c) => {
  const expected = Buffer.from(`Bearer ${config.studio.configToken}`);
  const actual = Buffer.from(c.req.header("authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(await studio.projects());
});
