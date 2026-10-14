import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { orchestrator, router, syncAll } from "./apps.ts";
import { config } from "./config.ts";
import { initCluster } from "./init.ts";
import { ensurePlatformAuth } from "./platform-auth.ts";
import { startBackupScheduler } from "./backups.ts";
import { startMetricsSampler } from "./metrics.ts";
import { startLintSweeper } from "./lint.ts";
import { startSchemaRelayReconciler } from "./pgrst-relay.ts";
import { recordVersion } from "./version.ts";
import { app } from "./server.ts";
import { studioInternalRoutes } from "./studio/routes.ts";
import { tlsRoutes } from "./tls.ts";

await initCluster();
// TLS and the platform hosts of Caddy's public server (TLS_MODE, PLATFORM_DOMAIN): before the app routes
await router.ensureEdge().catch((error) => console.error("caddy edge setup failed", error));
await syncAll();
// the platform's GoTrue (browser sign-in for Claude Code, oauth.ts); PATs keep working without it
await ensurePlatformAuth().catch((error) => console.error("platform auth (OAuth) setup failed", error));
await recordVersion(orchestrator).catch((error) => console.error("recording the platform version failed", error));
// DEP-1: pull the per-app images in the background, so that the first create_app does not wait for them
for (const image of [config.docker.gotrueImage, config.docker.postgrestImage]) {
  orchestrator.ensureImage(image).catch((error) => console.error(`pulling ${image} failed`, error));
}
startMetricsSampler();
startBackupScheduler();
startLintSweeper(config.lintSweepIntervalHours);
startSchemaRelayReconciler();
serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`control plane listening on :${info.port}`));
// internal listener (never routed publicly): Studio's forward auth and project configs, Caddy's TLS `ask` endpoint
const internal = new Hono();
internal.route("/", studioInternalRoutes);
internal.route("/", tlsRoutes);
serve({ fetch: internal.fetch, port: config.internalPort }, (info) =>
  console.log(`internal listener on :${info.port}`));
