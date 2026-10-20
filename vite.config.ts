import { gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { makeCutoffs, pack } from "./src/web/cutoffs.ts";

const server = `http://127.0.0.1:${process.env.PORT ?? "8787"}`;

/**
 * The color editor's backdrop tables (src/web/cutoffs.ts), worked out from
 * the bulb's solve as vibes is built, so they're always the solve's, and
 * gzipped: `import url from "virtual:cutoffs"` is where they are. Built, a
 * hashed asset; served, worked out when first asked for. (The solve's files
 * are this config's, so changing one restarts the dev server.)
 */
function cutoffs(): Plugin {
  const id = "virtual:cutoffs";
  const served = "/cutoffs.bin";
  let serving = false;
  let bytes: Buffer | undefined;
  const packed = () => (bytes ??= gzipSync(pack(makeCutoffs()), { level: 9 }));
  return {
    name: "vibes:cutoffs",
    configResolved: (config) => void (serving = config.command === "serve"),
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return;
      if (serving) return `export default ${JSON.stringify(served)};`;
      const ref = this.emitFile({ type: "asset", name: "cutoffs.bin", source: packed() });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
    configureServer(dev) {
      dev.middlewares.use(served, (_req, res) => {
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(packed());
      });
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), cutoffs()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ["roses-macbook-pro"],
    // Trailing slashes matter: "/api" alone would also catch src/web/api.ts.
    proxy: {
      "/api/": { target: server, ws: true },
      "/auth/": server,
      // Sketches' boxes: their VS Code, through vibes.
      "/box/": { target: server, ws: true },
    },
  },
});
