import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// PREVIEW_SUPABASE_API: set by the platform's preview on the web, whose tunnel reaches this dev server only, so it
// also relays the local Supabase API.
export default defineConfig(({ mode }) => {
  const api = loadEnv(mode, process.cwd(), "PREVIEW_").PREVIEW_SUPABASE_API;
  const proxy = Object.fromEntries(
    ["auth", "rest", "storage", "functions", "realtime"].map((service) => [`/${service}/v1`, { target: api, ws: true }]),
  );
  return { plugins: [react()], server: api ? { allowedHosts: true, proxy } : undefined };
});
