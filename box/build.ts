// Builds the vibes extension for sketch boxes into box/dist/vibes-sketch: the
// extension (CommonJS, as VS Code loads it), the preview panel's bundle
// (src/web/preview: one script and one stylesheet, fonts and the worker
// inlined, for a webview), its manifest and icon, and esbuild-wasm, which it
// builds sketches with.
//   pnpm build:box

import react from "@vitejs/plugin-react";
import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const at = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const out = at("box/dist/vibes-sketch");

await rm(out, { recursive: true, force: true });

await build({
  configFile: false,
  root: at("src/web"),
  plugins: [react()],
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: `${out}/media/preview`,
    emptyOutDir: true,
    lib: { entry: at("src/web/preview/main.tsx"), formats: ["es"], fileName: () => "preview.js", cssFileName: "preview" },
  },
});

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: out,
    emptyOutDir: false,
    target: "node22",
    minify: false,
    lib: { entry: at("box/extension/src/extension.ts"), formats: ["cjs"], fileName: () => "extension.js" },
    rollupOptions: { external: ["vscode", "esbuild-wasm", /^node:/] },
  },
});

await cp(at("box/extension/package.json"), `${out}/package.json`);
await mkdir(`${out}/media`, { recursive: true });
await cp(at("box/extension/media/icon.svg"), `${out}/media/icon.svg`);
await cp(await realpath(at("node_modules/esbuild-wasm")), `${out}/node_modules/esbuild-wasm`, { recursive: true, dereference: true });

console.log(`built ${out}`);
