import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// `npm test`: the screens and pure logic in src/ (jsdom), and the data tests in supabase/tests/, which need the local
// Supabase (`supabase start`). Deployments run both.
export default defineConfig({
  plugins: [react()],
  test: {
    // a new app has no tests yet, and the data setup only runs when there are data tests
    passWithNoTests: true,
    mockReset: true,
    projects: [
      {
        test: {
          name: "app",
          include: ["src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          // Testing Library unmounts what a test rendered through the global afterEach
          globals: true,
          // src/supabase.ts refuses to load without them; component tests mock the calls
          env: { VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_ANON_KEY: "test" },
        },
      },
      {
        test: {
          name: "data",
          include: ["supabase/tests/**/*.test.ts"],
          environment: "node",
          globalSetup: ["supabase/tests/global-setup.ts"],
        },
      },
    ],
  },
});
