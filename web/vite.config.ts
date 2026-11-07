import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  // Optional, dev only: API_PROXY (e.g. the production site URL) forwards /api calls so the UI can run against live data.
  const apiProxy = process.env.API_PROXY ?? loadEnv(mode, "..", "").API_PROXY;
  return {
    // BASE_PATH is set by the Pages workflow to "/<repo-name>/"; locally it is "/".
    base: process.env.BASE_PATH ?? "/",
    plugins: [react()],
    envDir: "..",
    envPrefix: "VITE_",
    server: apiProxy ? { proxy: { "/api": { target: apiProxy, changeOrigin: true } } } : undefined,
    test: { environment: "node" },
  };
});
