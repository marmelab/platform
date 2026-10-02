import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { appsForUser, studio } from "../apps.ts";
import type { User } from "../auth.ts";
import { config, studioUrl } from "../config.ts";
import { TooManyAttempts } from "../login-limit.ts";
import { createSession, logout, SESSION_COOKIE, throttledCredentials, userForSession } from "../sessions.ts";
import { loginPage, refusedPage } from "./pages.ts";
import { crossSiteRefusal, studioAccess } from "./policy.ts";


const secure = () => config.publicScheme === "https";
const fromStudioHost = (host: string | undefined) => (host ?? "").split(":")[0] === config.studio.host;

/** Only local paths: no scheme, no protocol-relative URL, no backslash tricks. */
const safeNext = (next: string | undefined) =>
  next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/projects";

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

studioPublicRoutes.get("/_platform/login", (c) => c.html(loginPage({ next: safeNext(c.req.query("next")) })));

studioPublicRoutes.post("/_platform/login", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "");
  const next = safeNext(String(form.next ?? ""));
  let user;
  try {
    user = await throttledCredentials(c, email, String(form.password ?? ""));
  } catch (error) {
    if (!(error instanceof TooManyAttempts)) throw error;
    c.header("Retry-After", String(error.retryAfterSeconds));
    return c.html(loginPage({ next, email, error: error.message }), 429);
  }
  if (!user) {
    console.warn(`studio login failed for ${JSON.stringify(email)}`);
    return c.html(loginPage({ next, email, error: "Invalid email or password." }), 401);
  }
  setCookie(c, SESSION_COOKIE, await createSession(user.id), {
    httpOnly: true,
    sameSite: "Lax",
    secure: secure(),
    path: "/",
    maxAge: config.sessionTtlSeconds,
  });
  return c.redirect(next, 303);
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
