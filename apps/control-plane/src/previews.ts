// Preview tunnel (ARCHITECTURE §3.10, journey B2): a Claude Code session on the web has no port forwarding, so the
// builder tries the app running in the session's sandbox at <scheme>://preview-<slug>.<apps domain>, through frp.
// frpc, in the sandbox, dials <api host>/~!frp over a websocket through the sandbox's HTTPS proxy (Caddy -> frps);
// Caddy sends the preview hosts to frps's vhost port (router.ts). frps asks this module, its server plugin on the
// internal listener, whether a client may log in (a preview token from create_preview_token), open a proxy (http,
// subdomain preview-<the token's app>, nothing else), and keep its tunnel at each heartbeat (frps.toml). Preview tokens
// open nothing else: the MCP endpoint refuses them (auth.ts).
// A preview host serves the session's dev server (the app's source included): only the app's members and the admins
// see it. The platform's session cookie stays on the Studio host, so Studio's PREVIEW_PATH checks the session and the
// membership, then sends the browser to the preview host's PREVIEW_PATH with a ticket (60 s), traded there for a pass
// cookie of that host (12 h). Caddy asks /preview/verify before every request to a preview host (forward auth), which
// checks the pass and the membership again. The pass also reaches the session's dev server: it opens this preview only.
import { PREVIEW_PREFIX, SLUG_RE } from "@platform/shared";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { type AppRow, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { appUrl, config, studioUrl } from "./config.ts";
import { derivedSecret, randomToken, sha256 } from "./crypto.ts";
import { one } from "./db.ts";
import { PREVIEW_PATH } from "./platform-auth.ts";
import { safeNext } from "./sso-policy.ts";
import { type FrpRequest, frpDecision, frpToken, signPreview, verifyPreview } from "./token-scopes.ts";

/** Long enough for frpc to reconnect through a working session (container restarts, network blips). */
export const PREVIEW_TOKEN_HOURS = 12;
export const PREVIEW_PASS_COOKIE = "platform_preview";
const TICKET_SECONDS = 60;
const PASS_SECONDS = PREVIEW_TOKEN_HOURS * 3600;
const secret = () => derivedSecret("preview-sign-in");
const now = () => Math.floor(Date.now() / 1000);

/** Who may preview an app (`a`), for an account (`u`): active, and a member of the app or an admin (as appForUser). */
const VIEWER = `u.active and a.status <> 'deleted'
  and (u.role = 'admin' or exists (select 1 from app_members m where m.app_id = a.id and m.user_id = u.id))`;

/** A new token voids the builder's former ones for the app: frps serves one tunnel per app anyway. */
export async function createPreviewToken(user: User, app: AppRow) {
  if (user.token?.kind === "deploy") throw new UserError("a deploy token cannot create a preview token");
  const value = randomToken("plat_prv");
  const row = await one<{ id: string; expires_at: Date }>(
    `with former as (
       update tokens set revoked_at = now()
        where user_id = $1 and kind = 'preview' and app_ids[1] = $4::uuid and revoked_at is null)
     insert into tokens (user_id, name, hash, kind, scopes, app_ids, parent_id, expires_at)
     values ($1, $2, $3, 'preview', '{preview}', array[$4::uuid], $5, now() + make_interval(hours => $6))
     returning id, expires_at`,
    [user.id, `preview ${app.slug}`, sha256(value), app.id, user.token?.id ?? null, PREVIEW_TOKEN_HOURS],
  );
  const expiresAt = row!.expires_at.toISOString();
  await audit(user.id, app.id, "create_preview_token", { token_id: row!.id, via: user.token?.kind ?? null, expires_at: expiresAt });
  return { token: value, app: app.slug, url: appUrl(`${PREVIEW_PREFIX}${app.slug}`), expires_at: expiresAt };
}

/** The app slug of a live preview token, or null: same revocation rules as the other tokens (auth.ts), and VIEWER. */
async function previewTokenApp(value: string): Promise<string | null> {
  const row = await one<{ slug: string }>(
    `select a.slug from tokens t join users u on u.id = t.user_id join apps a on a.id = t.app_ids[1]
      where t.hash = $1 and t.kind = 'preview' and t.revoked_at is null and t.expires_at > now() and ${VIEWER}
        and (t.parent_id is null or exists (select 1 from tokens p where p.id = t.parent_id and p.revoked_at is null))`,
    [sha256(value)],
  );
  return row?.slug ?? null;
}

export const previewViewer = async (userId: string, slug: string) =>
  Boolean(await one(`select 1 from users u join apps a on a.slug = $2 where u.id = $1 and ${VIEWER}`, [userId, slug]));

/** Where Studio sends a viewer: the preview host's PREVIEW_PATH, with a ticket. */
// ponytail: a ticket is short-lived, not single-use; record the used ones if a leaked sign-in URL ever matters
export const previewTicketUrl = (userId: string, slug: string, next: string) =>
  `${appUrl(`${PREVIEW_PREFIX}${slug}`)}${PREVIEW_PATH}?${new URLSearchParams({
    ticket: signPreview("ticket", slug, userId, now() + TICKET_SECONDS, secret()),
    next,
  })}`;

/** frps server plugin (frps.toml [[httpPlugins]]) and the preview hosts' forward auth: internal listener only. */
export const previewRoutes = new Hono();

previewRoutes.post("/frp/plugin", async (c) => {
  const request = await c.req.json().catch(() => ({})) as FrpRequest;
  const token = frpToken(request);
  return c.json(frpDecision(request, token ? await previewTokenApp(token) : null));
});

/** Caddy's forward auth (router.ts): a 2xx lets the request through to frps, any other answer goes to the browser. */
previewRoutes.get("/preview/verify", async (c) => {
  const host = (c.req.header("host") ?? "").split(":")[0]!;
  const label = host.endsWith(`.${config.appsDomain}`) ? host.slice(0, -config.appsDomain.length - 1) : "";
  const slug = label.startsWith(PREVIEW_PREFIX) ? label.slice(PREVIEW_PREFIX.length) : "";
  if (!SLUG_RE.test(slug)) return c.body(null, 404);
  const uri = c.req.header("x-forwarded-uri") ?? "/";
  const url = new URL(uri, "http://preview");
  if (url.pathname === PREVIEW_PATH) {
    const userId = verifyPreview("ticket", slug, url.searchParams.get("ticket") ?? undefined, now(), secret());
    if (!userId) return c.text("This preview link expired: open the preview again.\n", 403);
    setCookie(c, PREVIEW_PASS_COOKIE, signPreview("pass", slug, userId, now() + PASS_SECONDS, secret()), {
      httpOnly: true,
      sameSite: "Lax",
      secure: config.publicScheme === "https",
      path: "/",
      maxAge: PASS_SECONDS,
    });
    return c.redirect(safeNext(url.searchParams.get("next"), "/"), 303);
  }
  const userId = verifyPreview("pass", slug, getCookie(c, PREVIEW_PASS_COOKIE), now(), secret());
  if (userId && await previewViewer(userId, slug)) return c.body(null, 200);
  const page = c.req.header("x-forwarded-method") === "GET" && (c.req.header("accept") ?? "").includes("text/html");
  if (page) return c.redirect(studioUrl(`${PREVIEW_PATH}?${new URLSearchParams({ app: slug, next: uri })}`), 302);
  return c.text("Sign in to see this preview: open it in the browser.\n", 401);
});
