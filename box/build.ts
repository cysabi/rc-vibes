// Builds the vibes extension for sketch boxes into box/dist/vibes-sketch: the
// extension (CommonJS, as VS Code loads it), the preview panel's bundle
// (src/web/preview: one script and one stylesheet, fonts and the worker
// inlined, for a webview), the builder (box/builder.ts, which builds sketches
// for the room in a box of its own), its manifest and icon, and Vite, with
// what it needs, which the extension runs sketches with and the builder
// builds them with.
//   pnpm build:box

import react from "@vitejs/plugin-react";
import { cp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
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
    rollupOptions: { external: ["vscode", "vite", /^node:/] },
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
    lib: { entry: at("box/builder.ts"), formats: ["es"], fileName: () => "builder.mjs" },
    rollupOptions: { external: ["vite", /^node:/] },
  },
});

await cp(at("box/extension/package.json"), `${out}/package.json`);
await mkdir(`${out}/media`, { recursive: true });
await cp(at("box/extension/media/icon.svg"), `${out}/media/icon.svg`);

// Vite and everything it depends on, as plain folders (not pnpm's links), for
// this platform (its native parts are).
const copied = new Map<string, string>();
const exists = (p: string) => stat(p).then(() => true, () => false);

/** Where `name` is, as seen from the package in `dir`: its own node_modules, then those above. */
async function find(name: string, dir: string): Promise<string | null> {
  for (let d = dir; ; d = path.dirname(d)) {
    const candidate = path.join(d, "node_modules", name);
    if (await exists(path.join(candidate, "package.json"))) return realpath(candidate);
    if (path.dirname(d) === d) return null;
  }
}

async function copy(name: string, from: string, optional: boolean) {
  if (copied.has(name)) return;
  const dir = await find(name, from);
  if (!dir) {
    if (optional) return;
    throw new Error(`couldn't find ${name} (for ${from})`);
  }
  copied.set(name, dir);
  await cp(dir, `${out}/node_modules/${name}`, { recursive: true, dereference: true });
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const dep of Object.keys(pkg.dependencies ?? {})) await copy(dep, dir, false);
  // Native parts for other platforms aren't installed: just this one's.
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) await copy(dep, dir, true);
}
await copy("vite", at("."), false);

console.log(`built ${out} (with ${[...copied.keys()].sort().join(", ")})`);
