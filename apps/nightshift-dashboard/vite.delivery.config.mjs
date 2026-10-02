import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

// The public delivery page (/d/<token>): its own small build, so the page a
// customer opens carries none of the dashboard's code.
export default defineConfig({
  root: resolve(here, "delivery"),
  base: "/d/",
  build: {
    outDir: resolve(here, "dist", "delivery"),
    assetsDir: "static",
    emptyOutDir: true,
  },
});
