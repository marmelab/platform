// On-demand TLS (ARCHITECTURE §3.5, A1): with TLS_MODE=acme (or internal), Caddy obtains a certificate the first time a
// client asks for a host (SNI), after asking the control plane whether that host is one of the platform's. Approved:
// the platform hosts (API, admin console, Studio) and <slug>.<apps domain> of an existing app (stopped ones included:
// they serve a maintenance page). Anything else is refused, so that a client sending random names through the
// wildcard DNS record cannot make Caddy request certificates for them (ACME rate limits, disk). Internal listener only
// (never routed publicly): GET /caddy/ask?domain=<host>, 200 or 404.
import { SLUG_RE } from "@platform/shared";
import { Hono } from "hono";
import { config } from "./config.ts";
import { one } from "./db.ts";

export async function tlsHostAllowed(domain: string): Promise<boolean> {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  if ([config.apiHost, config.adminHost, config.studio.host].includes(host)) return true;
  const suffix = `.${config.appsDomain}`;
  if (!host.endsWith(suffix)) return false;
  const slug = host.slice(0, -suffix.length);
  if (!SLUG_RE.test(slug)) return false;
  return Boolean(await one("select 1 from apps where slug = $1 and status <> 'deleted'", [slug]));
}

export const tlsRoutes = new Hono();

tlsRoutes.get("/caddy/ask", async (c) => {
  const domain = c.req.query("domain") ?? "";
  if (domain && (await tlsHostAllowed(domain))) return c.text("ok\n", 200);
  console.warn(`tls: certificate refused for ${JSON.stringify(domain.slice(0, 255))}`);
  return c.text("unknown host\n", 404);
});
