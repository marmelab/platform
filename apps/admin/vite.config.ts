import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` proxies /api to the running stack (admin.localhost:8100), so the session cookie stays same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8100",
        // the API checks the Origin of cookie mutations: present the dev server as the admin host
        headers: { host: "admin.localhost:8100", origin: "http://admin.localhost:8100" },
      },
    },
  },
});
