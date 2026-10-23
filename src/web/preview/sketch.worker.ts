/// <reference lib="webworker" />
// A sketch's preview, in its own worker. Each tick answers with
// update(prev, nowMs, initialMs) through JSON, as arclamp does. It also passes
// on what the sketch logs, and why it failed, for the console beside the
// preview.
//
// The sketch is either a whole script, run as a global script (as arclamp
// runs it), or its modules, run by Vite's module runner from the box's Vite:
// then Vite's HMR updates them in place (only what changed runs again, and the
// rest keeps its state), and update() is taken from the entry each time it's
// updated (the box's Vite has the entry accept its updates, and hand them
// here as __vibesNext).
//
// Its params are the panel's: what the sketch declares is told after each
// load or update, and the knobs' values are handed to the library as vibes'
// stream hands them over in the room (__vibes.apply; packages/vibes/src/param.ts).

import { ESModulesEvaluator, ModuleRunner } from "vite/module-runner";
import type { VibesHost } from "../../../packages/vibes/src/param.ts";
import type { ParamSpec, ParamTable } from "../../shared/params.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;

const host = () => scope.__vibes as VibesHost | undefined;

/** What the sketch declares as params, as the library has them. */
const declared = (): ParamSpec[] => host()?.params() ?? [];

/** Longer than this, an update() stops the preview: arclamp would kill it too. */
const UPDATE_LIMIT_MS = 250;

type Update = (prev: unknown, now: number, initial: number) => unknown;
type Payload = { type: string; [key: string]: unknown };

export type ToSketch =
  | { type: "load"; script: string }
  | { type: "load-modules"; entry: string }
  | { type: "hmr"; payload: Payload }
  | { type: "tick"; seq: number; prev: unknown; now: number; initial: number }
  /** Its params' values, all of them, as vibes' stream sends them in the room. */
  | { type: "params"; values: ParamTable };
export type FromSketch =
  | { type: "loaded" }
  /** What the sketch declares as params, after each load or update. */
  | { type: "params"; specs: ParamSpec[] }
  | { type: "out"; seq: number; out: unknown }
  | { type: "log"; level: "log" | "warn" | "error"; text: string }
  | { type: "hmr"; payload: unknown }
  | { type: "error"; seq?: number; message: string };

const reply = (m: FromSketch) => scope.postMessage(m);
const tellParams = () => reply({ type: "params", specs: declared() });

const show = (v: unknown) => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

for (const name of ["log", "info", "debug", "warn", "error"] as const) {
  const level = name === "warn" || name === "error" ? name : "log";
  console[name] = (...args: unknown[]) => reply({ type: "log", level, text: args.map(show).join(" ") });
}

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

let update: Update | null = null;
let runner: ModuleRunner | null = null;
let entry = "";
let deliver: ((payload: Payload) => void) | null = null;

const updateOf = (module: { update?: unknown }): Update => {
  if (typeof module.update !== "function") throw new Error(`${entry} doesn't export an update() function`);
  return module.update as Update;
};

async function loadModules(from: string) {
  entry = from;
  // The entry, updated: its new update().
  scope.__vibesNext = (next: { update?: unknown }) => {
    try {
      update = updateOf(next);
      tellParams();
    } catch (err) {
      reply({ type: "log", level: "error", text: `Couldn't update: ${message(err)}` });
    }
  };
  runner = new ModuleRunner(
    {
      transport: {
        connect: ({ onMessage }) => {
          deliver = onMessage as (payload: Payload) => void;
        },
        send: (payload) => reply({ type: "hmr", payload }),
      },
      sourcemapInterceptor: false,
      // An update that fails keeps the last good one running. (Vite follows
      // each failure with a general "Failed to reload": the failure says it.)
      hmr: {
        logger: {
          debug() {},
          error: (err) => {
            const text = message(err);
            if (!text.startsWith("Failed to reload")) reply({ type: "log", level: "error", text: `Couldn't update: ${text}` });
          },
        },
      },
    },
    new ESModulesEvaluator(),
  );
  update = updateOf(await runner.import(entry));
  tellParams();
}

/** Everything run again from the entry (what Vite asks for when an update can't be applied in place). */
async function reloadModules() {
  if (!runner) return;
  runner.clearCache();
  try {
    update = updateOf(await runner.import(entry));
    tellParams();
  } catch (err) {
    reply({ type: "log", level: "error", text: `Couldn't reload: ${message(err)}` });
  }
}

scope.onmessage = (e: MessageEvent<ToSketch>) => {
  const m = e.data;
  if (m.type === "params") {
    host()?.apply("state", { v: 1, values: m.values });
    return;
  }
  if (m.type === "load") {
    try {
      // Indirect eval: global scope, not strict, like a script tag.
      (0, eval)(m.script);
      if (typeof scope.update !== "function") throw new Error("the script doesn't define an update() function");
      update = scope.update as Update;
      reply({ type: "loaded" });
      tellParams();
    } catch (err) {
      reply({ type: "error", message: message(err) });
    }
    return;
  }
  if (m.type === "load-modules") {
    loadModules(m.entry).then(
      () => reply({ type: "loaded" }),
      (err: unknown) => reply({ type: "error", message: message(err) }),
    );
    return;
  }
  if (m.type === "hmr") {
    // Errors are the extension's to show (in Problems, and the console).
    if (m.payload.type === "error") return;
    if (m.payload.type === "full-reload") void reloadModules();
    else deliver?.(m.payload);
    return;
  }
  // Still loading: nothing to show yet.
  if (!update) {
    reply({ type: "out", seq: m.seq, out: null });
    return;
  }
  try {
    // Timed here, where it runs: the page's own busyness isn't the sketch's.
    const started = performance.now();
    const out = update(m.prev, m.now, m.initial);
    const took = performance.now() - started;
    if (took > UPDATE_LIMIT_MS) throw new Error(`update() took ${Math.round(took)} ms, longer than ${UPDATE_LIMIT_MS} ms`);
    if (out === undefined || out === null) throw new Error(`update() returned ${out}`);
    reply({ type: "out", seq: m.seq, out: JSON.parse(JSON.stringify(out)) });
  } catch (err) {
    reply({ type: "error", seq: m.seq, message: message(err) });
  }
};
