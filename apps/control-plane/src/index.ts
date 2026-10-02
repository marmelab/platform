import { serve } from "@hono/node-server";
import { orchestrator, syncAll } from "./apps.ts";
import { config } from "./config.ts";
import { initCluster } from "./init.ts";
import { startMetricsSampler } from "./metrics.ts";
import { app } from "./server.ts";
import { studioInternalRoutes } from "./studio/routes.ts";

await initCluster();
await syncAll();
// DEP-1: pull the per-app images in the background, so that the first create_app does not wait for them
for (const image of [config.docker.gotrueImage, config.docker.postgrestImage]) {
  orchestrator.ensureImage(image).catch((error) => console.error(`pulling ${image} failed`, error));
}
startMetricsSampler();
serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`control plane listening on :${info.port}`));
serve({ fetch: studioInternalRoutes.fetch, port: config.internalPort }, (info) =>
  console.log(`internal listener on :${info.port}`));
