// admin.<domain>: the admin SPA (apps/admin, built into the control plane image) and its REST API under /api, same
// origin. Caddy proxies the whole host to the control plane (router.upsertAdmin); server.ts hands every request whose
// Host is the admin host to this app, so the MCP, CI and upload endpoints are not reachable there.
//
// Authentication: a platform session cookie (sessions.ts, the mechanism of Studio's /_platform/login), opened by
// POST /api/auth/login for admins only, or `Authorization: Bearer <admin PAT>` (scripts, tests). The cookie is
// host-only (admin.<domain>): a Domain cookie would also be sent to every <app>.<domain>, whose functions are written
// by builders. Every app host is same-site with the admin host, so SameSite does not stop them from sending requests:
// cookie requests must come from the admin origin itself (Sec-Fetch-Site, Origin) and mutations must carry the
// X-Platform-Admin header, which a cross-origin page cannot send without a CORS preflight that this API never grants.
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { authenticate, type User } from "../auth.ts";
import { adminUrl, config } from "../config.ts";
import { createSession, logout, SESSION_COOKIE, userForSession, verifyCredentials } from "../sessions.ts";
import { type AdminEnv, adminApi } from "./api.ts";
import { errorResponse, HttpError } from "./rest.ts";

export const CSRF_HEADER = "X-Platform-Admin";

export const isAdminHost = (host: string | undefined) => (host ?? "").split(":")[0] === config.adminHost;

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Cookie requests must come from the admin SPA itself; mutations also need the custom header. */
function checkBrowserRequest(c: Context, { mutation }: { mutation: boolean }) {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "cross-site request refused");
  if (!mutation) return;
  if (c.req.header("origin") !== adminUrl()) throw new HttpError(403, "missing or foreign Origin header");
  if (c.req.header(CSRF_HEADER) !== "1") throw new HttpError(403, `missing ${CSRF_HEADER} header`);
}

const secure = () => config.publicScheme === "https";

export const adminSite = new Hono<AdminEnv>();
adminSite.onError((error, c) => errorResponse(c, error));

adminSite.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

const identity = (user: User) => ({ id: user.id, email: user.email, fullName: user.name ?? user.email, role: user.role });

adminSite.post("/api/auth/login", async (c) => {
  checkBrowserRequest(c, { mutation: true });
  const input = z.object({ email: z.string().max(320), password: z.string().max(1024) })
    .parse(await c.req.json().catch(() => ({})));
  const user = await verifyCredentials(input.email, input.password);
  if (!user) {
    console.warn(`admin login failed for ${JSON.stringify(input.email)}`);
    return c.json({ message: "Invalid email or password." }, 401);
  }
  if (user.role !== "admin") {
    console.warn(`admin login refused for ${user.email}: not an admin`);
    return c.json({ message: "This console is reserved to platform admins." }, 403);
  }
  setCookie(c, SESSION_COOKIE, await createSession(user.id), {
    httpOnly: true,
    sameSite: "Strict",
    secure: secure(),
    path: "/",
    maxAge: config.sessionTtlSeconds,
  });
  return c.json(identity(user));
});

adminSite.post("/api/auth/logout", async (c) => {
  checkBrowserRequest(c, { mutation: true });
  await logout(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secure() });
  return c.json({ ok: true });
});

/** Every other /api route: an admin, by PAT or by session cookie. */
adminSite.use("/api/*", async (c, next) => {
  const authorization = c.req.header("authorization");
  let user: User | null;
  if (authorization) {
    user = await authenticate(authorization);
  } else {
    checkBrowserRequest(c, { mutation: UNSAFE.has(c.req.method) });
    user = await userForSession(getCookie(c, SESSION_COOKIE));
  }
  if (!user) return c.json({ message: "Not signed in." }, 401);
  if (user.role !== "admin") return c.json({ message: "Reserved to platform admins." }, 403);
  c.set("admin", user);
  await next();
});

adminSite.get("/api/auth/me", (c) => c.json(identity(c.get("admin"))));
adminSite.route("/api", adminApi);
adminSite.all("/api/*", (c) => c.json({ message: "not found" }, 404));

// --- static SPA ---

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

async function file(path: string) {
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? path : null;
}

adminSite.on(["GET", "HEAD"], "*", async (c) => {
  const root = resolve(config.adminStaticDir);
  let path: string;
  try {
    path = decodeURIComponent(c.req.path);
  } catch {
    return c.text("bad request\n", 400);
  }
  const requested = resolve(join(root, normalize(path)));
  if (requested !== root && !requested.startsWith(root + sep)) return c.text("not found\n", 404);
  // SPA fallback: unknown paths without an extension get index.html (react-admin routes)
  const target = await file(requested) ?? (extname(requested) ? null : await file(join(root, "index.html")));
  if (!target) {
    return (await file(join(root, "index.html")))
      ? c.text("not found\n", 404)
      : c.text("admin UI not built: run `pnpm --filter @platform/admin build` (the image build does it)\n", 503);
  }
  const immutable = target.startsWith(join(root, "assets") + sep);
  return c.body(await readFile(target), 200, {
    "Content-Type": TYPES[extname(target)] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
});

adminSite.all("*", (c) => c.text("not found\n", 404));
