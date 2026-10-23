/// <reference lib="webworker" />
// One shader in the preview, in its own worker as arclamp gives each its own
// sandbox. The script runs as a global script, so `function update` and any
// top-level state are globals, as in arclamp. Each tick answers with
// update(prev, nowMs, initialMs), passed through JSON as arclamp does (so NaN
// and Infinity come back as null).
//
// Browsers have setTimeout, fetch, AbortController, console, crypto, atob and
// btoa already. arclamp's udp sockets can't exist here: binding one works, and
// what arrives is only what the page posts in (its params' packets, as vibes
// sends them in the room: sim.ts); sends go nowhere.

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;

// Packets the page has posted, for the socket the script binds (one script, so one queue).
const inbox: string[] = [];
let warnedSend = false;
scope.udp = {
  bind(opts: { port?: number } = {}) {
    return {
      key: 0,
      local: `0.0.0.0:${opts.port ?? 0}`,
      recv: () => inbox.shift() ?? null,
      drain: () => inbox.splice(0),
      send() {
        if (!warnedSend) {
          console.warn("udp sends go nowhere in the preview");
          warnedSend = true;
        }
      },
      stats: () => ({ recv: 0, dropped: 0, queued: inbox.length }),
      close() {},
    };
  },
};

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export type ToWorker =
  | { type: "load"; script: string }
  | { type: "tick"; seq: number; prev: unknown; now: number; initial: number }
  /** Packets for the script's udp socket, as vibes sends them in the room. */
  | { type: "udp"; packets: string[] };
export type FromWorker = { type: "loaded" } | { type: "out"; seq: number; out: unknown } | { type: "error"; seq?: number; message: string };

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  const reply = (r: FromWorker) => scope.postMessage(r);
  if (m.type === "udp") {
    inbox.push(...m.packets);
    return;
  }
  if (m.type === "load") {
    try {
      // Indirect eval: global scope, not strict, like a script tag.
      (0, eval)(m.script);
      if (typeof scope.update !== "function") throw new Error("the script doesn't define an update() function");
      reply({ type: "loaded" });
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
