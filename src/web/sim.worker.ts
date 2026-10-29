/// <reference lib="webworker" />
// One shader in the preview, in its own worker as arclamp gives each its own
// sandbox. The script runs as a global script, so `function update` and any
// top-level state are globals, as in arclamp. Each tick answers with
// update(prev, nowMs, initialMs), passed through JSON as arclamp does (so NaN
// and Infinity come back as null).
//
// Browsers have setTimeout, fetch, AbortController, console, crypto, atob and
// btoa already. arclamp's udp sockets can't exist here: binding one works, but
// nothing ever arrives and sends go nowhere.
//
// A shader's params come as they would from vibes' stream in the room: all of
// them, handed to the library with __vibes.apply (packages/vibes/src/param.ts).
// The page may send them before the script has loaded (the library isn't
// there yet to take them): the latest are kept, and handed over once it is.
// What it declares goes the other way, once it's loaded: for a sketch being
// added, that's how the page knows its params before it's in the room.

import type { VibesHost } from "../../packages/vibes/src/param.ts";
import type { ParamSpec, ParamTable } from "../shared/params.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;

let warnedUdp = false;
scope.udp = {
  bind(opts: { port?: number } = {}) {
    if (!warnedUdp) {
      console.warn("udp isn't available in the preview: nothing arrives, and sends go nowhere");
      warnedUdp = true;
    }
    return {
      key: 0,
      local: `0.0.0.0:${opts.port ?? 0}`,
      recv: () => null,
      drain: () => [],
      send() {},
      stats: () => ({ recv: 0, dropped: 0, queued: 0 }),
      close() {},
    };
  },
};

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export type ToWorker =
  | { type: "load"; script: string }
  | { type: "tick"; seq: number; prev: unknown; now: number; initial: number }
  /** Its params' values, all of them, as vibes' stream sends them. */
  | { type: "params"; values: ParamTable };
export type FromWorker =
  /** Loaded, with what it declares as params (as the library has them; none without one). */
  | { type: "loaded"; declared: ParamSpec[] }
  | { type: "out"; seq: number; out: unknown }
  | { type: "error"; seq?: number; message: string };

// The params' values last sent, to hand the library once the script's loaded, if they came first.
let params: ParamTable | null = null;
const handOver = () => {
  if (params) (scope.__vibes as VibesHost | undefined)?.apply("state", { v: 1, values: params });
};

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  const reply = (r: FromWorker) => scope.postMessage(r);
  if (m.type === "params") {
    params = m.values;
    handOver();
    return;
  }
  if (m.type === "load") {
    try {
      // Indirect eval: global scope, not strict, like a script tag.
      (0, eval)(m.script);
      if (typeof scope.update !== "function") throw new Error("the script doesn't define an update() function");
      handOver();
      reply({ type: "loaded", declared: (scope.__vibes as VibesHost | undefined)?.params() ?? [] });
    } catch (err) {
      reply({ type: "error", message: message(err) });
    }
    return;
  }
  try {
    const out = (scope.update as (prev: unknown, now: number, initial: number) => unknown)(m.prev, m.now, m.initial);
    if (out === undefined || out === null) throw new Error(`update() returned ${out}`);
    reply({ type: "out", seq: m.seq, out: JSON.parse(JSON.stringify(out)) });
  } catch (err) {
    reply({ type: "error", seq: m.seq, message: message(err) });
  }
};
