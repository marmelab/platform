import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { adminSite, isAdminHost } from "./admin/site.ts";
import { authenticate } from "./auth.ts";
import { ciRoutes } from "./ci.ts";
import { apiUrl } from "./config.ts";
import { receiveUpload } from "./deployments.ts";
import { buildMcpServer } from "./mcp.ts";
import { mcpChallenge, oauthRoutes } from "./oauth.ts";
import { buildPlugin } from "./plugin.ts";
import { studioPublicRoutes } from "./studio/routes.ts";

export const app = new Hono();

// admin.<domain> only serves the admin SPA and its API (admin/site.ts)
app.use("*", async (c, next) => {
  if (isAdminHost(c.req.header("host"))) return adminSite.fetch(c.req.raw);
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

// The plugin, built once at the first request (plugin.ts)
let plugin: ReturnType<typeof buildPlugin> | undefined;
const served = () => (plugin ??= buildPlugin(apiUrl()));
app.get("/plugin/marketplace.json", (c) => c.json(served().marketplace));
app.get("/plugin/platform.zip", (c) => c.body(served().zip, 200, { "content-type": "application/zip" }));
app.get("/plugin/cloud-setup.sh", (c) => c.text(served().setup, 200, { "content-type": "text/x-shellscript; charset=utf-8" }));
app.route("/", studioPublicRoutes);
app.route("/ci", ciRoutes);
app.route("/", oauthRoutes);

app.all("/mcp", async (c) => {
  // the plugin sends a PAT in X-Platform-Token (empty without PLATFORM_TOKEN): a static Authorization header would
  // keep Claude Code from falling back to the browser sign-in (OAuth), whose tokens come in Authorization
  const pat = c.req.header("x-platform-token");
  const authorization = c.req.header("authorization") ?? (pat ? `Bearer ${pat}` : undefined);
  const user = await authenticate(authorization);
  if (!user) {
    return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "invalid or missing token" }, id: null }, 401, {
      // OAuth discovery (RFC 9728): Claude Code signs the user in through the browser from here (oauth.ts)
      "WWW-Authenticate": mcpChallenge(authorization !== undefined),
    });
  }
  // Stateless: one MCP server per request, bound to the authenticated user.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildMcpServer(user);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

app.put("/uploads/:token", async (c) => {
  const result = await receiveUpload(c.req.param("token"), c.req.raw.body as WebReadableStream<Uint8Array> | null);
  if (result.status !== 200) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, size: result.size });
});
