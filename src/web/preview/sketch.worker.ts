/// <reference lib="webworker" />
// A sketch's preview, in its own worker. As sim.worker.ts: the script runs as
// a global script, and each tick answers with update(prev, nowMs, initialMs)
// through JSON, as arclamp does. It also passes on what the sketch logs, and
// why it failed, for the console beside the preview.

const scope = self as unknown as DedicatedWorkerGlobalScope & Record<string, unknown>;

export type ToSketch = { type: "load"; script: string } | { type: "tick"; seq: number; prev: unknown; now: number; initial: number };
export type FromSketch =
  | { type: "loaded" }
  | { type: "out"; seq: number; out: unknown }
  | { type: "log"; level: "log" | "warn" | "error"; text: string }
  | { type: "error"; seq?: number; message: string };

const reply = (m: FromSketch) => scope.postMessage(m);

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

scope.onmessage = (e: MessageEvent<ToSketch>) => {
  const m = e.data;
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
