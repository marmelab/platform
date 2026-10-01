import { config } from "./config.ts";

export interface AppRoute {
  slug: string;
  host: string;
  gotrue: string;
  postgrest: string;
}

export interface Router {
  upsertApp(route: AppRoute): Promise<void>;
  removeApp(slug: string): Promise<void>;
}

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

  async upsertApp(route: AppRoute): Promise<void> {
    const publicId = `app-${route.slug}`;
    const internalId = `app-${route.slug}-internal`;
    await this.delete(publicId);
    await this.delete(internalId);
    await this.call("POST", "/id/apps/handle/0/routes", {
      "@id": publicId,
      match: [{ host: [route.host] }],
      terminal: true,
      handle: [{ handler: "subroute", routes: [...this.apiRoutes(route), ...this.staticRoutes(route.slug)] }],
    });
    // Edge functions reach their own app through http://caddy:8180/<slug> (SUPABASE_URL)
    await this.call("POST", "/id/internal-apps/handle/0/routes", {
      "@id": internalId,
      match: [{ path: [`/${route.slug}/*`] }],
      terminal: true,
      handle: [
        { handler: "rewrite", strip_path_prefix: `/${route.slug}` },
        { handler: "subroute", routes: this.apiRoutes(route) },
      ],
    });
  }

  async removeApp(slug: string): Promise<void> {
    await this.delete(`app-${slug}`);
    await this.delete(`app-${slug}-internal`);
  }
}
