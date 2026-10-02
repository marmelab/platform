import { serve } from "@hono/node-server";
import { syncAll } from "./apps.ts";
import { config } from "./config.ts";
import { initCluster } from "./init.ts";
import { app } from "./server.ts";
import { studioInternalRoutes } from "./studio/routes.ts";

await initCluster();
await syncAll();
serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`control plane listening on :${info.port}`));
serve({ fetch: studioInternalRoutes.fetch, port: config.internalPort }, (info) =>
  console.log(`internal listener on :${info.port}`));
