import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { adminSite, isAdminHost } from "./admin/site.ts";
import { authenticate } from "./auth.ts";
import { ciRoutes } from "./ci.ts";
import { receiveUpload } from "./deployments.ts";
import { buildMcpServer } from "./mcp.ts";
import { studioPublicRoutes } from "./studio/routes.ts";

export const app = new Hono();

// admin.<domain> only serves the admin SPA and its API (admin/site.ts)
app.use("*", async (c, next) => {
  if (isAdminHost(c.req.header("host"))) return adminSite.fetch(c.req.raw);
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", studioPublicRoutes);
app.route("/ci", ciRoutes);

app.all("/mcp", async (c) => {
  const user = await authenticate(c.req.header("authorization"));
  if (!user) {
    return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "invalid or missing token" }, id: null }, 401, {
      "WWW-Authenticate": 'Bearer realm="platform"',
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
