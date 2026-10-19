// How a sketch is built: for the room, by vibes' builder from a commit, and
// in the editor, live, as you type. Both decide the same way, from what's in
// the sketch:
//
//   1. sketch.json, if it has one: its own commands.
//        { "build": { "command": "make", "output": "out/sketch.js" },
//          "dev": { "command": "cargo watch -s ./build.sh", "output": "dist/sketch.js", "watch": true } }
//   2. Otherwise, with a flake.nix: `nix build .#sketch`, whose output is the
//      script (or a folder with sketch.js in it).
//   3. Otherwise a "build" script in package.json, which writes dist/sketch.js.
//   4. Otherwise its entry file (main.ts, …), built by vibes with Vite: the
//      sketch's own vite.config, if it has one.
//
// A sketch with a flake.nix brings its own tools with it: its own commands
// (sketch.json's, and installing its packages) run in its dev shell
// (`nix develop`), so cargo and the rest are there. Nix sees what git does,
// so a new file needs `git add` before a Nix build sees it.
//
// In the editor, a Vite sketch updates by Vite's own HMR (only what changed
// runs again; the rest keeps its state); a command's sketch, by running its
// dev command (or, without one, its build) and swapping in each new script.
// Either way the preview keeps its clock.

/** The version of the rules above (and of the builder): it's in each script's stamp. */
export const BUILDER_VERSION = "1";

/** What a sketch's entry may be, in this order. */
export const ENTRIES = ["main.ts", "main.js", "src/main.ts", "src/index.ts", "index.ts", "index.js"];

/** Where a package.json build script is expected to write the script. */
export const PACKAGE_OUTPUT = "dist/sketch.js";

/** A flake sketch's build, and where it leaves the script. */
export const FLAKE_BUILD = "nix build .#sketch --print-build-logs";
export const FLAKE_OUTPUT = "result";

/** How the room's script is made. */
export type BuildPlan =
  | { kind: "vite"; entry: string }
  | { kind: "command"; command: string; output: string; from: "sketch.json" | "flake.nix" | "package.json" };

/** How the editor keeps the preview up to date. */
export type DevPlan =
  | { kind: "vite"; entry: string }
  /** Run once and left running (watch), or run again after each change. */
  | { kind: "command"; command: string; output: string; watch: boolean };

export interface SketchPlan {
  build: BuildPlan;
  dev: DevPlan;
  /** What installs its packages first, if it has a package.json. */
  install: string | null;
}

/** What's in a sketch, as far as planning goes. */
export interface SketchFiles {
  exists(file: string): boolean;
  /** A file's text, or null if it isn't there. */
  read(file: string): string | null;
}

interface Command {
  command: string;
  output: string;
}

const isCommand = (v: unknown): v is Command =>
  typeof v === "object" && v !== null && typeof (v as Command).command === "string" && typeof (v as Command).output === "string" && (v as Command).command.trim() !== "";

/** How a sketch is built, or why it can't be. */
export function planSketch(files: SketchFiles): SketchPlan | { error: string } {
  let json: { build?: unknown; dev?: unknown } = {};
  const raw = files.read("sketch.json");
  if (raw !== null) {
    try {
      json = JSON.parse(raw) as typeof json;
    } catch (err) {
      return { error: `sketch.json isn't JSON: ${(err as Error).message}` };
    }
    if (typeof json !== "object" || json === null) return { error: "sketch.json should be an object" };
    if (json.build !== undefined && !isCommand(json.build)) return { error: 'sketch.json\'s "build" needs a "command" and an "output"' };
    if (json.dev !== undefined && !isCommand(json.dev)) return { error: 'sketch.json\'s "dev" needs a "command" and an "output"' };
  }

  let install: string | null = null;
  let buildScript = false;
  const pkg = files.read("package.json");
  if (pkg !== null) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = ((JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {}) as Record<string, unknown>;
    } catch (err) {
      return { error: `package.json isn't JSON: ${(err as Error).message}` };
    }
    buildScript = typeof scripts.build === "string";
    if (files.exists("yarn.lock") || files.exists("bun.lock") || files.exists("bun.lockb")) {
      return { error: "only pnpm and npm can install a sketch's packages so far (it has a yarn or bun lockfile)" };
    }
    install = files.exists("package-lock.json") ? "npm ci" : files.exists("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install";
  }
  const run = install?.startsWith("npm") ? "npm run" : "pnpm run";
  const flake = files.exists("flake.nix");
  // A flake sketch's own commands, in its dev shell.
  const own = (command: string) => (flake ? `nix develop --command sh -c ${quote(command)}` : command);
  if (install) install = own(install);

  let build: BuildPlan;
  if (json.build !== undefined) {
    const b = json.build as Command;
    build = { kind: "command", command: own(b.command), output: b.output, from: "sketch.json" };
  } else if (flake) {
    build = { kind: "command", command: FLAKE_BUILD, output: FLAKE_OUTPUT, from: "flake.nix" };
  } else if (buildScript) {
    build = { kind: "command", command: `${run} build`, output: PACKAGE_OUTPUT, from: "package.json" };
  } else {
    const entry = ENTRIES.find((e) => files.exists(e));
    if (!entry) return { error: `nothing to build: no sketch.json, no build script in package.json, and none of ${ENTRIES.join(", ")}` };
    build = { kind: "vite", entry };
  }

  let dev: DevPlan;
  if (json.dev !== undefined) {
    const d = json.dev as Command & { watch?: unknown };
    dev = { kind: "command", command: own(d.command), output: d.output, watch: d.watch === true };
  } else if (build.kind === "vite") {
    dev = { kind: "vite", entry: build.entry };
  } else {
    dev = { kind: "command", command: build.command, output: build.output, watch: false };
  }
  return { build, dev, install };
}

/** One argument for sh, whatever's in it. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The script a Vite build makes is an IIFE (globalName __sketch); this makes its update() arclamp's global one. */
export const UPDATE_FOOTER = "function update(prev, nowMs, initialMs) { return __sketch.update(prev, nowMs, initialMs); }";
