/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Served by Caddy at /scan/ (see deploy/Caddyfile). Dev server proxies /v1.
export default defineConfig({
  base: "/scan/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: { "/v1": { target: "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    testTimeout: 20000,
  },
});
