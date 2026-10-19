// The sketch, live in the preview as you type, the way src/shared/sketch-plan.ts
// plans it:
//
// - By Vite (a sketch with just an entry, or its own vite.config): a Vite dev
//   server here, whose "sketch" environment the preview's worker runs with
//   Vite's module runner. Their messages (module requests, and HMR updates)
//   go through the webview, both ways. The entry accepts its updates, so an
//   edit runs only what changed again; the rest keeps its state.
// - By a command (sketch.json's dev, or else its build): run it, left running
//   if it watches by itself, or again after each change, and swap each script
//   it writes into the preview.
//
// Packages are installed first, again whenever package.json or the lockfile
// changes; a change to sketch.json, package.json, a lockfile or vite.config
// starts it all over. Build errors go to Problems and the console; the preview
// keeps running what last worked.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DevEnvironment, HotChannel, HotPayload } from "vite";
import * as vscode from "vscode";
import { planSketch, type DevPlan } from "../../../src/shared/sketch-plan.ts";
import type { SketchSource } from "../../../src/web/preview/protocol.ts";

/** Where the dev loop's results go. */
export interface DevOut {
  source(source: SketchSource): void;
  /** One of Vite's messages, for the preview's module runner. */
  hmr(payload: unknown): void;
  line(kind: "build" | "error", text: string): void;
  problems: vscode.DiagnosticCollection;
}

/** An error as Vite passes it on: where it is, when it knows. */
type ViteError = { message: string; id?: string; loc?: { file?: string; line: number; column: number } };

interface Running {
  /** One of the module runner's messages, for Vite. */
  deliver(payload: unknown): void;
  stop(): Promise<void>;
}

/** What starts it all over when it changes. */
const PLANNING = ["sketch.json", "package.json", "package-lock.json", "pnpm-lock.yaml", "vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"];
const INSTALLED = "node_modules/.vibes-installed";

export class DevLoop {
  private readonly root: string;
  private readonly out: DevOut;
  private running: Running | null = null;
  private starting: Promise<void> = Promise.resolve();
  /** How many Vite servers it's started: the preview loads afresh from each. */
  private servers = 0;

  constructor(root: string, out: DevOut) {
    this.root = root;
    this.out = out;
  }

  /** Starts it (again, if it was going). */
  restart() {
    this.starting = this.starting.then(async () => {
      await this.running?.stop();
      this.running = null;
      try {
        this.running = await this.begin();
      } catch (err) {
        this.out.line("error", `Couldn't start the preview: ${(err as Error).message}`);
      }
    });
  }

  /** The module runner's messages, from the preview. */
  deliver(payload: unknown) {
    this.running?.deliver(payload);
  }

  watch(context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, `{${PLANNING.join(",")}}`));
    let timer: NodeJS.Timeout | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.restart(), 200);
    };
    context.subscriptions.push(watcher, watcher.onDidCreate(later), watcher.onDidChange(later), watcher.onDidDelete(later), { dispose: () => void this.running?.stop() });
  }

  private async begin(): Promise<Running | null> {
    const at = (f: string) => path.join(this.root, f);
    const plan = planSketch({ exists: (f) => fs.existsSync(at(f)), read: (f) => (fs.existsSync(at(f)) ? fs.readFileSync(at(f), "utf8") : null) });
    if ("error" in plan) {
      this.out.line("error", `Can't build this sketch: ${plan.error}`);
      return null;
    }
    if (plan.install && !(await this.installed(plan.install))) return null;
    return plan.dev.kind === "vite" ? this.vite(plan.dev.entry) : this.command(plan.dev);
  }

  /** Installs its packages, unless they're installed already for this package.json and lockfile. */
  private async installed(install: string): Promise<boolean> {
    const hash = createHash("sha256");
    for (const f of ["package.json", "package-lock.json", "pnpm-lock.yaml"]) {
      const p = path.join(this.root, f);
      if (fs.existsSync(p)) hash.update(f).update(fs.readFileSync(p));
    }
    const want = hash.digest("hex");
    const marker = path.join(this.root, INSTALLED);
    if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === want) return true;
    this.out.line("build", `Installing packages: ${install}`);
    const code = await run(install, this.root, (text) => this.out.line("build", text));
    if (code !== 0) {
      this.out.line("error", `Installing packages failed (exit ${code}).`);
      return false;
    }
    fs.writeFileSync(marker, want);
    return true;
  }

  private async vite(entry: string): Promise<Running> {
    const vite = await import("vite");
    // Vite knows files by their real paths.
    const root = fs.realpathSync(this.root);
    const entryFile = path.join(root, entry);
    type Listener = (data: unknown, client: { send(payload: HotPayload): void }) => void;
    const listeners = new Map<string, Set<Listener>>();
    // Answers to the module runner's requests: a module that won't transform
    // (a syntax error) comes back as one.
    const client = {
      send: (payload: HotPayload) => {
        const failed = payload.type === "custom" && payload.event === "vite:invoke" ? (payload.data as { data?: { error?: ViteError } }).data?.error : undefined;
        if (failed) this.problem(failed, root);
        this.out.hmr(payload);
      },
    };
    let changed: string | null = null;
    const channel = {
      on: (event: string, fn: Listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      off: (event: string, fn: Listener) => void listeners.get(event)?.delete(fn),
      send: (payload: HotPayload) => {
        this.report(payload, root, changed);
        this.out.hmr(payload);
      },
    } as HotChannel;
    const config = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"].find((f) => fs.existsSync(path.join(root, f)));
    const server = await vite.createServer({
      configFile: config ? path.join(root, config) : false,
      root,
      // Its cache in the home, not the sketch's repo.
      cacheDir: path.join(os.homedir(), ".cache", "vibes-vite", createHash("sha256").update(root).digest("hex").slice(0, 12)),
      appType: "custom",
      clearScreen: false,
      customLogger: logger(vite, (kind, text) => this.out.line(kind, text)),
      server: { middlewareMode: true, ws: false },
      plugins: [
        {
          name: "vibes:entry-accepts",
          // The entry takes its own updates, and hands the preview's worker
          // its new update().
          transform(code, id) {
            if (id === entryFile) return { code: `${code}\nif (import.meta.hot) import.meta.hot.accept((next) => { if (next) globalThis.__vibesNext?.(next); });\n`, map: null };
          },
        },
      ],
      environments: {
        sketch: {
          // Run by a module runner (in the preview's worker), resolving as a browser does.
          consumer: "server",
          resolve: { noExternal: true, conditions: ["browser", "module", "import", "default"] },
          dev: { createEnvironment: (name, cfg) => new vite.DevEnvironment(name, cfg, { hot: true, transport: channel }) as DevEnvironment },
        },
      },
    });
    server.watcher.on("change", (file: string) => (changed = path.relative(root, file)));
    this.out.problems.clear();
    this.out.source({ kind: "modules", entry: `/${entry}`, server: ++this.servers });
    return {
      deliver: (payload) => {
        const p = payload as HotPayload;
        if (p.type === "custom") for (const fn of listeners.get(p.event) ?? []) fn(p.data, client);
      },
      stop: () => server.close(),
    };
  }

  /** How an update's going: in the console, and Problems cleared for it (the preview's worker says if it fails). */
  private report(payload: HotPayload, root: string, changed: string | null) {
    if (payload.type === "update" || payload.type === "full-reload") {
      this.out.problems.clear();
      this.out.line("build", `${changed ?? "The sketch"} changed`);
    } else if (payload.type === "error") {
      this.out.line("error", `Couldn't update: ${payload.err.message}`);
      this.problem(payload.err, root);
    }
  }

  /** An error in a file, in Problems, where it is. */
  private problem(err: ViteError, root: string) {
    this.out.problems.clear();
    const text = err.message.replace(/\x1b\[[0-9;]*m/g, "");
    // Where, as Vite says, or else as its message does (file:line:column).
    let file = err.loc?.file ?? err.id;
    let line = err.loc?.line;
    let column = err.loc?.column;
    const said = /([\w@./-]+\.[cm]?[jt]sx?):(\d+):(\d+)/.exec(text);
    if (line === undefined && said) {
      file ??= said[1];
      line = Number(said[2]);
      column = Number(said[3]) - 1;
    }
    if (!file || line === undefined) return;
    // A path relative to the sketch, or to the folder it's in.
    const full = [file, path.join(root, file), path.join(path.dirname(root), file)].find((f) => path.isAbsolute(f) && fs.existsSync(f));
    if (!full) return;
    const at = new vscode.Position(Math.max(0, line - 1), Math.max(0, column ?? 0));
    // Its first line: the rest is a picture of the code, for a terminal.
    const message = text.split("\n").find((l) => l.trim()) ?? text;
    this.out.problems.set(vscode.Uri.file(full), [new vscode.Diagnostic(new vscode.Range(at, at.translate(0, 1)), message, vscode.DiagnosticSeverity.Error)]);
  }

  private async command(dev: Extract<DevPlan, { kind: "command" }>): Promise<Running> {
    const output = path.join(this.root, dev.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    let last: string | null = null;
    const load = () => {
      let script: string;
      try {
        // The output, or sketch.js in it if it's a folder (a Nix build's result may be).
        script = fs.readFileSync(fs.statSync(output).isDirectory() ? path.join(output, "sketch.js") : output, "utf8");
      } catch {
        return;
      }
      if (!script || script === last) return;
      last = script;
      this.out.problems.clear();
      this.out.line("build", `Built ${dev.output}`);
      this.out.source({ kind: "script", script });
    };
    const say = (text: string) => this.out.line("build", text);
    load();

    if (dev.watch) {
      // Whenever it writes a new script, it's swapped in. (Looked at a few
      // times a second, not watched: a file rewritten in place, or a Nix
      // result's link moved, doesn't reliably say so.)
      const looking = setInterval(load, 300);
      say(`Running ${dev.command}`);
      const child = start(dev.command, this.root, say);
      child.on("exit", (code) => code !== null && this.out.line(code === 0 ? "build" : "error", `${dev.command} ended (exit ${code}).`));
      return {
        deliver() {},
        stop: async () => {
          clearInterval(looking);
          child.kill();
        },
      };
    }

    // Run again after each change (but not to what it writes, or its packages).
    let running: Promise<unknown> = Promise.resolve();
    let queued = false;
    const build = () => {
      if (queued) return;
      queued = true;
      running = running.then(async () => {
        queued = false;
        const code = await run(dev.command, this.root, say);
        if (code === 0) load();
        else this.out.line("error", `${dev.command} failed (exit ${code}). The preview keeps running what last built.`);
      });
    };
    const skip = [output, path.join(this.root, "node_modules"), path.join(this.root, ".git")];
    if (path.dirname(output) !== this.root) skip.push(path.dirname(output));
    const sources = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, "**/*"));
    let timer: NodeJS.Timeout | undefined;
    const later = (uri: vscode.Uri) => {
      if (skip.some((p) => uri.fsPath === p || uri.fsPath.startsWith(p + path.sep))) return;
      clearTimeout(timer);
      timer = setTimeout(build, 150);
    };
    const subscriptions = [sources, sources.onDidCreate(later), sources.onDidChange(later), sources.onDidDelete(later)];
    build();
    return {
      deliver() {},
      stop: async () => {
        for (const s of subscriptions) s.dispose();
      },
    };
  }
}

/** A shell command in `cwd`, each line of its output to `line`. */
function start(command: string, cwd: string, line: (text: string) => void): ChildProcess {
  const child = spawn("sh", ["-c", command], { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream?.on("data", (chunk: Buffer) => {
      const lines = (rest + chunk.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) line(l);
    });
    stream?.on("end", () => rest.trim() && line(rest));
  }
  return child;
}

/** Runs a shell command to the end, and says how it ended. */
function run(command: string, cwd: string, line: (text: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = start(command, cwd, line);
    child.on("error", (err) => {
      line(err.message);
      resolve(-1);
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/** Vite's warnings and errors, into the console (its routine chatter left out). */
function logger(vite: typeof import("vite"), line: (kind: "build" | "error", text: string) => void) {
  const base = vite.createLogger("warn", { allowClearScreen: false });
  return {
    ...base,
    warn: (msg: string) => line("build", msg),
    warnOnce: (msg: string) => line("build", msg),
    error: (msg: string) => line("error", msg),
  };
}
