import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { config } from "./config.ts";

export interface StudioRoute {
  host: string;
  upstream: string;
  forwardAuth: string;
  controlPlane: string;
}

export interface Router {
  /** Serves the app (static files, API, functions). Idempotent. */
  upsertApp(slug: string): Promise<void>;
  /** Replaces the app with a 503 maintenance response (stopped app: no static files, API or functions). */
  maintenanceApp(slug: string): Promise<void>;
  removeApp(slug: string): Promise<void>;
  upsertStudio(route: StudioRoute): Promise<void>;
}

/** Headers set from the forward auth response; any value sent by the client is dropped first. */
const IDENTITY_HEADERS = ["X-Platform-User", "X-Platform-Role", "X-Platform-Apps", "X-Platform-Signature"];

type CaddyRoute = Record<string, unknown>;
/** Routes to set (replaced in place, or appended) or remove (null), by `@id`, in the two dynamic subroutes. */
interface RouteChange {
  /** Public server, `apps` subroute (matched on the host). */
  public?: Record<string, CaddyRoute | null>;
  /** Internal server, `internal-apps` subroute (edge functions -> API, matched on /<slug>/*). */
  internal?: Record<string, CaddyRoute | null>;
}

/** The `routes` array of the subroute with this `@id` among a server's top-level routes. */
function subroutes(server: { routes?: CaddyRoute[] } | undefined, id: string): CaddyRoute[] {
  const route = server?.routes?.find((r) => r["@id"] === id) as { handle?: { routes?: CaddyRoute[] }[] } | undefined;
  const handler = route?.handle?.[0];
  if (!handler) throw new Error(`caddy: no "${id}" subroute in the loaded config`);
  return (handler.routes ??= []);
}

function applyChange(routes: CaddyRoute[], change: Record<string, CaddyRoute | null> = {}) {
  for (const [id, route] of Object.entries(change)) {
    const index = routes.findIndex((r) => r["@id"] === id);
    if (route === null) {
      if (index >= 0) routes.splice(index, 1);
    } else {
      // through JSON, as Caddy stores it, so that an unchanged route compares equal
      const value = JSON.parse(JSON.stringify({ "@id": id, ...route })) as CaddyRoute;
      if (index >= 0) routes[index] = value;
      else routes.push(value);
    }
  }
}

/** Per-app routes of the former router (one pair per app): replaced by the generic routes below. */
const LEGACY_APP_ROUTE = /^app-[a-z][a-z0-9-]*$/;

const SLUG_PATTERN = "[a-z][a-z0-9-]{1,30}[a-z0-9]";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The slug captured from the host (public server) or the first path segment (internal server). */
const SLUG = "{http.regexp.app.1}";

/** Marker files in the app's sites directory, read by Caddy (`file` matcher) on every request. */
const RUNNING = ".running";
const STOPPED = ".stopped";
/** Routing state, not app content: left out of backups. */
export const ROUTING_MARKERS = [RUNNING, STOPPED];

/**
 * Caddy routing. Bootstrap config: routes "apps" (public) and "internal-apps" (edge -> API).
 *
 * Every Caddy config change reloads its whole HTTP app: Caddy starts new servers and shuts the old ones down. The old
 * servers close their idle keep-alive connections, and a connection they accepted but on which no request had arrived
 * yet (a client's spare pooled connection) is closed when its first request arrives, without a response: that client
 * request fails with a socket error (TT-4). So the app lifecycle never changes the Caddy config. Two generic routes,
 * installed once, serve every app: the slug comes from the host (public) or the first path segment (internal), the
 * upstreams are `plat-<slug>-auth` and `plat-<slug>-rest`, the static root `<sites>/<slug>/current`. Whether an app is
 * served, and how, is decided per request by marker files in `<sites>/<slug>/`: `.stopped` (maintenance, checked
 * first), `.running` (served); neither means unknown app (the request falls through to the next routes, then to the
 * server's 404). Config changes (generic routes, Studio) are one atomic `PATCH` of both servers' routes, skipped when
 * unchanged, serialized in this process and guarded by Caddy's ETag (If-Match) against other writers.
 */
export class CaddyRouter implements Router {
  private queue: Promise<unknown> = Promise.resolve();
  private routesInstalled = false;

  private change(change: RouteChange, removeLegacy = false): Promise<void> {
    const next = this.queue.then(() => this.apply(change, removeLegacy));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async apply(change: RouteChange, removeLegacy: boolean, attempts = 5) {
    const url = `${config.caddyAdmin}/config/apps/http/servers`;
    // undici sends Sec-Fetch-Mode, which makes Caddy enforce the Origin check: send an allowed one.
    const origin = config.caddyAdmin;
    for (let attempt = 1; ; attempt++) {
      const current = await fetch(url, { headers: { origin } });
      if (!current.ok) throw new Error(`caddy GET servers: ${current.status} ${await current.text()}`);
      const etag = current.headers.get("etag");
      const servers = await current.json() as Record<string, { routes?: CaddyRoute[] }>;
      const publicRoutes = subroutes(servers.public, "apps");
      const internalRoutes = subroutes(servers.internal, "internal-apps");
      const before = structuredClone([publicRoutes, internalRoutes]);
      if (removeLegacy) {
        for (const routes of [publicRoutes, internalRoutes]) {
          for (let i = routes.length - 1; i >= 0; i--) {
            if (LEGACY_APP_ROUTE.test(String(routes[i]!["@id"]))) routes.splice(i, 1);
          }
        }
      }
      applyChange(publicRoutes, change.public);
      applyChange(internalRoutes, change.internal);
      if (isDeepStrictEqual(before, [publicRoutes, internalRoutes])) return;
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin, ...(etag ? { "if-match": etag } : {}) },
        body: JSON.stringify(servers),
      });
      if (response.ok) return;
      // 412: changed by another writer since the GET
      if (response.status !== 412 || attempt >= attempts) {
        throw new Error(`caddy PATCH servers: ${response.status} ${await response.text()}`);
      }
    }
  }

  private apiRoutes() {
    return [
      {
        // main worker endpoints (/_internal/warm, metrics...) are reachable from the internal network only
        match: [{ path: ["/functions/v1/_internal", "/functions/v1/_internal/*"] }],
        handle: [{ handler: "static_response", status_code: 404, body: "not found\n" }],
      },
      {
        match: [{ path: ["/auth/v1/*"] }],
        handle: [
          { handler: "rewrite", strip_path_prefix: "/auth/v1" },
          { handler: "reverse_proxy", upstreams: [{ dial: `${config.docker.prefix}-${SLUG}-auth:9999` }] },
        ],
      },
      {
        match: [{ path: ["/rest/v1/*"] }],
        handle: [
          { handler: "rewrite", strip_path_prefix: "/rest/v1" },
          { handler: "reverse_proxy", upstreams: [{ dial: `${config.docker.prefix}-${SLUG}-rest:3000` }] },
        ],
      },
      {
        match: [{ path: ["/functions/v1/*"] }],
        handle: [
          { handler: "rewrite", strip_path_prefix: "/functions/v1" },
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: config.edgeUpstream }],
            headers: {
              request: {
                set: {
                  "X-Platform-App": [SLUG],
                  "X-Platform-Gateway-Token": ["{env.PLATFORM_GATEWAY_TOKEN}"],
                },
              },
            },
          },
        ],
      },
    ];
  }

  private staticRoutes() {
    const root = `${config.caddySitesRoot}/${SLUG}/current`;
    return [
      {
        match: [{ path: ["/assets/*"] }],
        handle: [{
          handler: "headers",
          response: { set: { "Cache-Control": ["public, max-age=31536000, immutable"] } },
        }],
      },
      {
        match: [{ file: { root, try_files: ["{http.request.uri.path}", "/index.html"] } }],
        handle: [
          { handler: "rewrite", uri: "{http.matchers.file.relative}" },
          {
            handler: "subroute",
            routes: [{
              match: [{ path: ["*.html", "/"] }],
              handle: [{ handler: "headers", response: { set: { "Cache-Control": ["no-cache"] } } }],
            }],
          },
          { handler: "file_server", root },
        ],
      },
    ];
  }

  private maintenance() {
    const unavailable = (contentType: string, body: string) => ({
      handler: "static_response",
      status_code: 503,
      headers: { "Content-Type": [contentType], "Cache-Control": ["no-store"], "Retry-After": ["3600"] },
      body,
    });
    // the slug only contains [a-z0-9-] (SLUG_PATTERN): safe in HTML
    const page = `<!doctype html><meta charset="utf-8"><title>${SLUG}: maintenance</title>` +
      `<h1>${SLUG} is under maintenance</h1><p>This app is currently stopped. Please come back later.</p>\n`;
    const api = unavailable("application/json", '{"code":"APP_STOPPED","message":"This app is stopped"}\n');
    return { page: unavailable("text/html; charset=utf-8", page), api };
  }

  /** Serves `handle` when the app has `marker` in its sites directory. */
  private whenMarker(marker: string, handle: unknown[]) {
    return {
      match: [{ file: { root: config.caddySitesRoot, try_files: [`/${SLUG}/${marker}`] } }],
      handle,
      terminal: true,
    };
  }

  /**
   * The two generic routes (not terminal: an unknown slug falls through to the next routes, e.g. Studio, then to the
   * server's 404). Installed once; the former per-app routes are removed in the same change.
   */
  private async ensureRoutes() {
    if (this.routesInstalled) return;
    const { page, api } = this.maintenance();
    const host = `^(${SLUG_PATTERN})\\.${escapeRegExp(config.appsDomain)}(?::[0-9]+)?$`;
    await this.change({
      public: {
        "apps-by-host": {
          match: [{ header_regexp: { Host: { name: "app", pattern: host } } }],
          handle: [{
            handler: "subroute",
            routes: [
              this.whenMarker(STOPPED, [{
                handler: "subroute",
                routes: [
                  { match: [{ path: ["/auth/v1/*", "/rest/v1/*", "/functions/v1/*"] }], handle: [api], terminal: true },
                  { handle: [page] },
                ],
              }]),
              this.whenMarker(RUNNING, [{
                handler: "subroute",
                routes: [...this.apiRoutes(), ...this.staticRoutes()],
              }]),
            ],
          }],
        },
      },
      // Edge functions reach their own app through http://caddy:8180/<slug> (SUPABASE_URL)
      internal: {
        "apps-by-path": {
          match: [{ path_regexp: { name: "app", pattern: `^/(${SLUG_PATTERN})/` } }],
          handle: [{
            handler: "subroute",
            routes: [
              this.whenMarker(STOPPED, [api]),
              this.whenMarker(RUNNING, [
                { handler: "rewrite", strip_path_prefix: `/${SLUG}` },
                { handler: "subroute", routes: this.apiRoutes() },
              ]),
            ],
          }],
        },
      },
    }, true);
    this.routesInstalled = true;
  }

  /** Sets the app's marker (`.running` or `.stopped`) and removes the other one; null removes both. */
  private async setMarker(slug: string, marker: string | null) {
    const dir = join(config.dataDir.sites, slug);
    if (marker) {
      await mkdir(dir, { recursive: true });
      // written before the other one is removed: a stopping app goes straight from served to maintenance
      await writeFile(join(dir, marker), "");
    }
    for (const other of [STOPPED, RUNNING]) {
      if (other !== marker) await rm(join(dir, other), { force: true });
    }
  }

  async upsertApp(slug: string): Promise<void> {
    await this.ensureRoutes();
    await this.setMarker(slug, RUNNING);
  }

  async maintenanceApp(slug: string): Promise<void> {
    await this.ensureRoutes();
    await this.setMarker(slug, STOPPED);
  }

  async removeApp(slug: string): Promise<void> {
    await this.setMarker(slug, null);
  }

  /** Studio behind the control plane's forward auth (equivalent of `forward_auth ... copy_headers`). */
  async upsertStudio(route: StudioRoute): Promise<void> {
    const copyIdentity = IDENTITY_HEADERS.map((name) => ({
      match: [{ not: [{ vars: { [`{http.reverse_proxy.header.${name}}`]: [""] } }] }],
      handle: [{ handler: "headers", request: { set: { [name]: [`{http.reverse_proxy.header.${name}}`] } } }],
    }));
    await this.change({
      public: {
        studio: {
          match: [{ host: [route.host] }],
          terminal: true,
          handle: [{
            handler: "subroute",
            routes: [
              { handle: [{ handler: "headers", request: { delete: IDENTITY_HEADERS } }] },
              {
                match: [{ path: ["/_platform/*"] }],
                handle: [{ handler: "reverse_proxy", upstreams: [{ dial: route.controlPlane }] }],
                terminal: true,
              },
              {
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: route.forwardAuth }],
                    rewrite: { method: "GET", uri: "/studio/verify" },
                    headers: {
                      request: {
                        set: {
                          "X-Forwarded-Method": ["{http.request.method}"],
                          "X-Forwarded-Uri": ["{http.request.uri}"],
                        },
                      },
                    },
                    handle_response: [{
                      match: { status_code: [2] },
                      routes: [{ handle: [{ handler: "vars" }] }, ...copyIdentity],
                    }],
                  },
                  { handler: "reverse_proxy", upstreams: [{ dial: route.upstream }] },
                ],
              },
            ],
          }],
        },
      },
    });
  }
}
