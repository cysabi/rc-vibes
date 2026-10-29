import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { defaultSketchEntry, defaultSketchScript } from "./src/server/base-color-script.ts";
import { DEFAULT_SKETCHES } from "./src/shared/default-sketches.ts";
import { buildSketchScript } from "./src/server/sketch-script.ts";
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

/**
 * The preview panel outside VS Code (src/web/preview/index.html), served what
 * the extension would send it: a room at /dev/layout (dev/room.ts: the real
 * one from dev/lights.json, else a made-up one), and dev/sketch/main.ts at
 * /dev/sketch.js, built as the builder builds it (one script, its update()
 * made global), again when it has changed. Served only.
 */
function previewPage(): Plugin {
  const sketch = path.resolve("dev/sketch/main.ts");
  let built: { at: number; script: string } | null = null;
  async function script(): Promise<string> {
    const at = statSync(sketch).mtimeMs;
    if (built?.at === at) return built.script;
    built = { at, script: await buildSketchScript(sketch) };
    return built.script;
  }
  return {
    name: "vibes:preview-page",
    async configureServer(dev) {
      // Only when serving, and by a path the bundler can't follow: dev/ isn't
      // among the image's sources (flake.nix), so a build must never look for it.
      const { loadRoom } = (await import(/* @vite-ignore */ new URL("./dev/room.ts", import.meta.url).href)) as typeof import("./dev/room.ts");
      dev.middlewares.use("/dev/layout", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ...loadRoom(), changed: 0 }));
      });
      dev.middlewares.use("/dev/sketch.js", (_req, res) => {
        script().then(
          (code) => {
            res.setHeader("Content-Type", "text/javascript");
            res.end(code);
          },
          (err: Error) => {
            res.statusCode = 500;
            res.end(err.message);
          },
        );
      });
    },
  };
}

/**
 * vibes' own sketches' scripts (src/shared/default-sketches.ts: Tone, the
 * Base Tone's, and the rest), each built with vibes as the builder builds a
 * sketch, beside the web app (not in it: they're for arclamp, not browsers).
 * The server puts them in from there (base-color-script.ts).
 */
function defaultSketchScripts(): Plugin {
  return {
    name: "vibes:default-sketches",
    apply: "build",
    async closeBundle() {
      for (const s of DEFAULT_SKETCHES) {
        const out = defaultSketchScript(s);
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, await buildSketchScript(defaultSketchEntry(s)));
      }
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [react(), cutoffs(), previewPage(), defaultSketchScripts()],
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
