import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

// The delivery page template (/deliver/?m=<manifest URL>): a static page the
// Night Shift web server only hosts. Its own small build, so the page a
// customer opens carries none of the dashboard's code.
export default defineConfig({
  root: resolve(here, "delivery"),
  base: "/deliver/",
  build: {
    outDir: resolve(here, "dist", "deliver"),
    assetsDir: "static",
    emptyOutDir: true,
  },
});
