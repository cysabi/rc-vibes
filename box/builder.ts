// One build, of one commit of a sketch, in a pod (or container) of its own
// that vibes starts with the box image (src/server/builds.ts). It fetches the
// commit from vibes, builds it as src/shared/sketch-plan.ts says (installing
// its packages first; a Vite sketch with the Vite beside it here), and sends
// vibes the script and the log, or why it failed. vibes checks and stamps the
// script; nothing here is trusted. Started as root, it starts Nix's daemon
// and then builds as uid 1000, with the internet and vibes and nothing else.
//
//   VIBES_BUILD_URL, VIBES_BUILD_TOKEN: where vibes is, and this build's token.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import vm from "node:vm";
import { planSketch, UPDATE_FOOTER, type BuildPlan } from "../src/shared/sketch-plan.ts";

const url = process.env.VIBES_BUILD_URL;
const token = process.env.VIBES_BUILD_TOKEN;
const WORK = "/tmp/build";
const MAX_LOG = 200_000;

let log = "";
const say = (text: string) => {
  console.log(text);
  if (log.length < MAX_LOG) log += `${text}\n`;
};

/** A shell command in the build's folder, its output into the log. */
function run(command: string): Promise<number> {
  say(`$ ${command}`);
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd: WORK, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => say(chunk.toString().trimEnd()));
    child.on("error", (err) => {
      say(err.message);
      resolve(-1);
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/** The commit's files, from vibes (a tar of them), into WORK. */
async function fetchSource() {
  const res = await fetch(`${url}/build-api/source`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw new Error(`vibes didn't hand over the source (${res.status})`);
  mkdirSync(WORK, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-x", "-C", WORK], { stdio: ["pipe", "inherit", "inherit"] });
    Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(tar.stdin);
    tar.on("error", reject);
    tar.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`unpacking it failed (tar exit ${code})`))));
  });
}

/** Where the script is: the output itself, or sketch.js in it if it's a folder (a Nix build's result may be). */
function scriptAt(output: string): string {
  return existsSync(output) && statSync(output).isDirectory() ? path.join(output, "sketch.js") : output;
}

/** The sketch built by Vite: one global script whose update() is its entry's. */
async function viteBuild(entry: string): Promise<string> {
  const vite = await import("vite");
  const config = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"].find((f) => existsSync(path.join(WORK, f)));
  const out = await vite.build({
    configFile: config ? path.join(WORK, config) : false,
    root: WORK,
    cacheDir: "/tmp/vite-cache",
    logLevel: "warn",
    customLogger: { ...vite.createLogger("warn"), info: say, warn: say, warnOnce: say, error: say },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: path.join(WORK, entry), formats: ["iife"], name: "__sketch", fileName: () => "sketch.js" },
      rolldownOptions: { output: { footer: UPDATE_FOOTER } },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]) as { output: { type: string; code?: string }[] }[];
  const chunk = outputs.flatMap((o) => o.output).find((o) => o.type === "chunk");
  if (!chunk?.code) throw new Error("Vite made no script");
  return chunk.code;
}

async function build(plan: BuildPlan): Promise<string> {
  if (plan.kind === "vite") {
    say(`Building ${plan.entry} with Vite`);
    return viteBuild(plan.entry);
  }
  say(`Building with ${plan.from}'s command`);
  const code = await run(plan.command);
  if (code !== 0) throw new Error(`${plan.command} failed (exit ${code})`);
  const output = scriptAt(path.join(WORK, plan.output));
  if (!existsSync(output)) throw new Error(`${plan.command} didn't write ${plan.output}`);
  return readFileSync(output, "utf8");
}

/**
 * The params the script declares (param() in @roobscoob/vibes, which keeps
 * them on globalThis as it loads): read by loading it here, as arclamp would,
 * in a context of its own with the little a sandbox has. Nothing it does here
 * matters; one that can't load declares nothing, and the room says what's wrong.
 */
function declaredParams(script: string): unknown[] {
  const quiet = () => {};
  const never = () => 0;
  const context = vm.createContext({
    console: { log: quiet, info: quiet, debug: quiet, warn: quiet, error: quiet },
    udp: { bind: () => ({ key: 0, local: "0.0.0.0:0", recv: () => null, drain: () => [], send: quiet, stats: () => ({ recv: 0, dropped: 0, queued: 0 }), close: quiet }) },
    // The rest of what arclamp's prelude gives a sandbox, as the preview's
    // worker counts on it too (src/web/sim.worker.ts), so a sketch that
    // reaches for any of it as it loads still loads here: timers that never
    // fire, a fetch that never answers.
    setTimeout: never,
    clearTimeout: quiet,
    setInterval: never,
    clearInterval: quiet,
    fetch: () => new Promise(() => {}),
    AbortController,
    crypto,
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
  });
  try {
    vm.runInContext(script, context, { filename: "sketch.js", timeout: 5000 });
  } catch (err) {
    say(`Couldn't load the script to read its params: ${(err as Error).message}`);
    return [];
  }
  const registry = (context as Record<string, unknown>).__vibesParams as { declared?: unknown } | undefined;
  const declared = registry?.declared;
  return declared && typeof declared === "object" ? Object.values(declared) : [];
}

async function report(result: { ok: true; script: string; plan: string; params: unknown[] } | { ok: false; error: string; plan: string | null }) {
  const res = await fetch(`${url}/build-api/result`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...result, log }),
  });
  if (!res.ok) console.error(`vibes didn't take the result (${res.status}): ${await res.text()}`);
}

async function main() {
  let described: string | null = null;
  try {
    if (!url || !token) throw new Error("this build doesn't know where vibes is (VIBES_BUILD_URL, VIBES_BUILD_TOKEN)");
    await fetchSource();
    const at = (f: string) => path.join(WORK, f);
    const plan = planSketch({ exists: (f) => existsSync(at(f)), read: (f) => (existsSync(at(f)) ? readFileSync(at(f), "utf8") : null) });
    if ("error" in plan) throw new Error(plan.error);
    described = plan.build.kind === "vite" ? `vite ${plan.build.entry}` : `${plan.build.from}: ${plan.build.command}`;
    if (plan.install) {
      const code = await run(plan.install);
      if (code !== 0) throw new Error(`installing its packages failed (exit ${code})`);
    }
    const script = await build(plan.build);
    say(`Built: ${script.length} bytes`);
    const params = declaredParams(script);
    if (params.length > 0) say(`Params: ${params.map((p) => (p as { name?: unknown }).name).join(", ")}`);
    await report({ ok: true, script, plan: described, params });
  } catch (err) {
    say(`Failed: ${(err as Error).message}`);
    await report({ ok: false, error: (err as Error).message, plan: described }).catch((e: Error) => console.error(e.message));
    process.exit(1);
  }
}

const NIX_SOCKET = "/nix/var/nix/daemon-socket/socket";

if (process.getuid?.() === 0) {
  // Started as root: Nix's daemon first (the build may be a Nix one), then
  // this again, as uid 1000, for the build itself.
  const { NIX_REMOTE: _, ...env } = process.env;
  const daemon = spawn("nix-daemon", [], { stdio: ["ignore", "inherit", "inherit"], env });
  daemon.on("error", (err) => console.error("couldn't start nix-daemon:", err.message));
  for (let i = 0; i < 50 && !existsSync(NIX_SOCKET); i++) await new Promise((r) => setTimeout(r, 100));
  const build = spawn(process.execPath, process.argv.slice(1), { uid: 1000, gid: 1000, cwd: "/", stdio: "inherit", env: process.env });
  build.on("exit", (code) => {
    daemon.kill();
    process.exit(code ?? 1);
  });
} else {
  await main();
}
