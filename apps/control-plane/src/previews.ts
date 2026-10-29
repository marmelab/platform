// Preview tunnel (ARCHITECTURE §3.10, journey B2): a Claude Code session on the web has no port forwarding, so the
// builder tries the app running in the session's sandbox at <scheme>://preview-<slug>.<apps domain>, through frp.
// frpc, in the sandbox, dials <api host>/~!frp over a websocket through the sandbox's HTTPS proxy (Caddy -> frps);
// Caddy sends the preview hosts to frps's vhost port (router.ts). frps asks this module, its server plugin on the
// internal listener, whether a client may log in (a preview token from create_preview_token) and open a proxy (http,
// subdomain preview-<the token's app>, nothing else). Preview tokens open nothing else: the MCP endpoint refuses them
// (auth.ts).
import { PREVIEW_PREFIX } from "@platform/shared";
import { Hono } from "hono";
import { type AppRow, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { appUrl } from "./config.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { one } from "./db.ts";
import { type FrpRequest, frpDecision, frpToken } from "./token-scopes.ts";

/** Long enough for frpc to reconnect through a working session (container restarts, network blips). */
export const PREVIEW_TOKEN_HOURS = 12;

export async function createPreviewToken(user: User, app: AppRow) {
  if (user.token?.kind === "deploy") throw new UserError("a deploy token cannot create a preview token");
  const value = randomToken("plat_prv");
  const row = await one<{ id: string; expires_at: Date }>(
    `insert into tokens (user_id, name, hash, kind, scopes, app_ids, parent_id, expires_at)
     values ($1, $2, $3, 'preview', '{preview}', array[$4::uuid], $5, now() + make_interval(hours => $6))
     returning id, expires_at`,
    [user.id, `preview ${app.slug}`, sha256(value), app.id, user.token?.id ?? null, PREVIEW_TOKEN_HOURS],
  );
  const expiresAt = row!.expires_at.toISOString();
  await audit(user.id, app.id, "create_preview_token", { token_id: row!.id, via: user.token?.kind ?? null, expires_at: expiresAt });
  return { token: value, app: app.slug, url: appUrl(`${PREVIEW_PREFIX}${app.slug}`), expires_at: expiresAt };
}

/** The app slug of a live preview token (same revocation rules as the other tokens, auth.ts), or null. */
async function previewTokenApp(value: string): Promise<string | null> {
  const row = await one<{ slug: string }>(
    `select a.slug from tokens t join users u on u.id = t.user_id join apps a on a.id = t.app_ids[1]
      where t.hash = $1 and t.kind = 'preview' and t.revoked_at is null and t.expires_at > now() and u.active
        and a.status <> 'deleted'
        and (t.parent_id is null or exists (select 1 from tokens p where p.id = t.parent_id and p.revoked_at is null))`,
    [sha256(value)],
  );
  return row?.slug ?? null;
}

/** frps server plugin (frps.toml [[httpPlugins]]): internal listener only, never routed publicly. */
export const frpRoutes = new Hono();

frpRoutes.post("/frp/plugin", async (c) => {
  const request = await c.req.json().catch(() => ({})) as FrpRequest;
  const token = frpToken(request);
  return c.json(frpDecision(request, token ? await previewTokenApp(token) : null));
});
