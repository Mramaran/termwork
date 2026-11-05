import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // BASE_PATH is set by the Pages workflow to "/<repo-name>/"; locally it is "/".
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  envDir: "..",
  envPrefix: "VITE_",
  test: { environment: "node" },
});
