import { config } from "./config.ts";

export interface AppRoute {
  slug: string;
  host: string;
  gotrue: string;
  postgrest: string;
}

export interface StudioRoute {
  host: string;
  upstream: string;
  forwardAuth: string;
  controlPlane: string;
}

export interface Router {
  upsertApp(route: AppRoute): Promise<void>;
  /** Replaces the app's routes with a 503 maintenance response (stopped app: no static files, API or functions). */
  maintenanceApp(slug: string, host: string): Promise<void>;
  removeApp(slug: string): Promise<void>;
  upsertStudio(route: StudioRoute): Promise<void>;
}

/** Headers set from the forward auth response; any value sent by the client is dropped first. */
const IDENTITY_HEADERS = ["X-Platform-User", "X-Platform-Role", "X-Platform-Apps", "X-Platform-Signature"];

// undici sends Sec-Fetch-Mode, which makes Caddy enforce the Origin check: send an allowed one.
/** Caddy admin JSON API. Bootstrap config: routes "apps" (public) and "internal-apps" (edge -> API). */
export class CaddyRouter implements Router {
  private async call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${config.caddyAdmin}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: config.caddyAdmin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`caddy ${method} ${path}: ${response.status} ${await response.text()}`);
  }

  private async delete(id: string) {
    const response = await fetch(`${config.caddyAdmin}/id/${id}`, {
      method: "DELETE",
      headers: { origin: config.caddyAdmin },
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      if (!text.includes("unknown object ID")) throw new Error(`caddy DELETE ${id}: ${response.status} ${text}`);
    }
  }

  private apiRoutes(route: AppRoute) {
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
          { handler: "reverse_proxy", upstreams: [{ dial: route.gotrue }] },
        ],
      },
      {
        match: [{ path: ["/rest/v1/*"] }],
        handle: [
          { handler: "rewrite", strip_path_prefix: "/rest/v1" },
          { handler: "reverse_proxy", upstreams: [{ dial: route.postgrest }] },
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
                  "X-Platform-App": [route.slug],
                  "X-Platform-Gateway-Token": ["{env.PLATFORM_GATEWAY_TOKEN}"],
                },
              },
            },
          },
        ],
      },
    ];
  }

  private staticRoutes(slug: string) {
    const root = `${config.caddySitesRoot}/${slug}/current`;
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

  /** Replaces the public route (matched on the host) and the internal one (matched on /<slug>/*). */
  private async replaceRoutes(slug: string, host: string, publicHandle: unknown[], internalHandle: unknown[]) {
    const publicId = `app-${slug}`;
    const internalId = `app-${slug}-internal`;
    await this.delete(publicId);
    await this.delete(internalId);
    await this.call("POST", "/id/apps/handle/0/routes", {
      "@id": publicId,
      match: [{ host: [host] }],
      terminal: true,
      handle: publicHandle,
    });
    // Edge functions reach their own app through http://caddy:8180/<slug> (SUPABASE_URL)
    await this.call("POST", "/id/internal-apps/handle/0/routes", {
      "@id": internalId,
      match: [{ path: [`/${slug}/*`] }],
      terminal: true,
      handle: internalHandle,
    });
  }

  async upsertApp(route: AppRoute): Promise<void> {
    await this.replaceRoutes(
      route.slug,
      route.host,
      [{ handler: "subroute", routes: [...this.apiRoutes(route), ...this.staticRoutes(route.slug)] }],
      [
        { handler: "rewrite", strip_path_prefix: `/${route.slug}` },
        { handler: "subroute", routes: this.apiRoutes(route) },
      ],
    );
  }

  async maintenanceApp(slug: string, host: string): Promise<void> {
    const unavailable = (contentType: string, body: string) => ({
      handler: "static_response",
      status_code: 503,
      headers: { "Content-Type": [contentType], "Cache-Control": ["no-store"], "Retry-After": ["3600"] },
      body,
    });
    const page = `<!doctype html><meta charset="utf-8"><title>${slug}: maintenance</title>` +
      `<h1>${slug} is under maintenance</h1><p>This app is currently stopped. Please come back later.</p>\n`;
    const api = unavailable("application/json", '{"code":"APP_STOPPED","message":"This app is stopped"}\n');
    await this.replaceRoutes(slug, host, [{
      handler: "subroute",
      routes: [
        { match: [{ path: ["/auth/v1/*", "/rest/v1/*", "/functions/v1/*"] }], handle: [api], terminal: true },
        { handle: [unavailable("text/html; charset=utf-8", page)] },
      ],
    }], [api]);
  }

  /** Studio behind the control plane's forward auth (equivalent of `forward_auth ... copy_headers`). */
  async upsertStudio(route: StudioRoute): Promise<void> {
    const copyIdentity = IDENTITY_HEADERS.map((name) => ({
      match: [{ not: [{ vars: { [`{http.reverse_proxy.header.${name}}`]: [""] } }] }],
      handle: [{ handler: "headers", request: { set: { [name]: [`{http.reverse_proxy.header.${name}}`] } } }],
    }));
    await this.delete("studio");
    await this.call("POST", "/id/apps/handle/0/routes", {
      "@id": "studio",
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
                    set: { "X-Forwarded-Method": ["{http.request.method}"], "X-Forwarded-Uri": ["{http.request.uri}"] },
                  },
                },
                handle_response: [{ match: { status_code: [2] }, routes: [{ handle: [{ handler: "vars" }] }, ...copyIdentity] }],
              },
              { handler: "reverse_proxy", upstreams: [{ dial: route.upstream }] },
            ],
          },
        ],
      }],
    });
  }

  async removeApp(slug: string): Promise<void> {
    await this.delete(`app-${slug}`);
    await this.delete(`app-${slug}-internal`);
  }
}
