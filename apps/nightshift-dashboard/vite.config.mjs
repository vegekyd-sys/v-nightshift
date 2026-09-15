import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(here, "client"),
  plugins: [react()],
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 24881,
    proxy: {
      "/api": "http://127.0.0.1:24880",
    },
  },
});
