// The preview: what the room would do with your pending edits, run in the
// browser. Room tone from the draft's template, then each shader in stack
// order, bottom first, each in its own worker (sim.worker.ts), merged as
// arclamp merges: a shader's channels override the layer below, anything it
// leaves out stays as it was, values that aren't finite numbers are dropped,
// and on the lights it's masked from its output is its input (a muted
// shader is masked from every light). It also notes which lights each shader
// is trying to change, before its mask or mute, as arclamp does for the live
// room (useLayerEffects; the selection panel lists them).
//
// It differs from arclamp in running ~30 times a second rather than 100, on
// the browser's JS engine, with browser rules for fetch (CORS), and without
// udp. A shader's params, pending edits and all, are handed to it as vibes'
// stream hands them over in the room. What a sketch being added declares, its
// preview here says (drafts.declared), so its knobs are there before it's in.

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Channels, LightInfo } from "../shared/arclamp.ts";
import type { ParamSpec, ShaderParams } from "../shared/params.ts";
import { drafts, type Layer, type LayerKey } from "./draft.ts";
import { pushSimFrame, setSimulated } from "./live.ts";
import type { FromWorker, ToWorker } from "./sim.worker.ts";

const TICK_MS = 33;
// A shader that hasn't answered by then is stuck; arclamp would kill it too.
const UPDATE_DEADLINE_MS = 250;

export type RoomState = Map<number, Channels>;

/** Room tone's state: every light, every channel, from the template (0 where it says nothing). */
export function baseState(lights: LightInfo[], template: Record<string, Channels>): RoomState {
  const state: RoomState = new Map();
  for (const l of lights) {
    const t = template[String(l.id)] ?? {};
    state.set(l.id, Object.fromEntries(l.channels.map((name) => [name, t[name] ?? 0])));
  }
  return state;
}

/** What a shader sees: the state below it, with each light's static metadata. */
export function prevOf(state: RoomState, lights: LightInfo[], initial: number) {
  return {
    initial_time: initial,
    lights: lights.map((l) => ({ id: l.id, channels: { ...state.get(l.id) }, tags: l.tags ?? [], coords: l.coords, rail: l.rail })),
  };
}

/** A shader's output over the state below it, channel by channel, except on the lights it's masked from. */
export function mergeOutput(state: RoomState, lights: LightInfo[], out: unknown, mask?: ReadonlySet<number>): RoomState {
  const list = (out as { lights?: unknown } | null)?.lights;
  if (!Array.isArray(list)) return state;
  const known = new Map(lights.map((l) => [l.id, l.channels]));
  const next = new Map(state);
  for (const item of list as { id?: unknown; channels?: unknown }[]) {
    const names = typeof item?.id === "number" ? known.get(item.id) : undefined;
    if (!names || !item.channels || typeof item.channels !== "object" || mask?.has(item.id as number)) continue;
    const given = item.channels as Record<string, unknown>;
    const ch = { ...next.get(item.id as number) };
    for (const name of names) {
      const v = given[name];
      if (typeof v === "number" && Number.isFinite(v)) ch[name] = v;
    }
    next.set(item.id as number, ch);
  }
  return next;
}

/**
 * One shader's step: the state it passes on (its output over `state`, except
 * where it's masked; all of `state`, if it's muted), and the lights it's
 * trying to change (where its unmasked output differs from `state`).
 */
export function applyLayer(
  state: RoomState,
  lights: LightInfo[],
  out: unknown,
  layer: { muted: boolean; mask: readonly number[] },
): { state: RoomState; trying: number[] } {
  const unmasked = mergeOutput(state, lights, out);
  const trying = [...unmasked].filter(([id, ch]) => changed(state.get(id), ch)).map(([id]) => id);
  if (layer.muted) return { state, trying };
  return { state: layer.mask.length > 0 ? mergeOutput(state, lights, out, new Set(layer.mask)) : unmasked, trying };
}

// ---- workers ----------------------------------------------------------------

class ShaderWorker {
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, (out: unknown) => void>();
  /** The script couldn't load, or got stuck: nothing more to ask it. */
  stopped = false;
  /** The params' values last sent it, as JSON. */
  private sentParams: string | null = null;

  readonly script: string;

  constructor(script: string, onDeclared: (specs: ParamSpec[]) => void) {
    this.script = script;
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === "loaded") {
        onDeclared(m.declared);
        return;
      }
      // The script itself failed to load.
      if (m.type === "error" && m.seq === undefined) {
        this.stop();
        return;
      }
      // A tick: one that failed just passes its layer's input on.
      const done = this.waiting.get(m.seq!);
      this.waiting.delete(m.seq!);
      done?.(m.type === "out" ? m.out : null);
    };
    this.worker.onerror = () => this.stop();
    this.worker.postMessage({ type: "load", script });
  }

  /** update()'s output, or null if it failed or took too long. */
  call(prev: unknown, now: number, initial: number): Promise<unknown> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        if (!this.waiting.delete(seq)) return;
        this.stop();
        resolve(null);
      }, UPDATE_DEADLINE_MS);
      this.waiting.set(seq, (out) => {
        window.clearTimeout(timer);
        resolve(out);
      });
      this.worker.postMessage({ type: "tick", seq, prev, now, initial });
    });
  }

  /** Its params' values, all of them, when they've changed since last sent. */
  sendParams(params: ShaderParams | null) {
    const json = params ? JSON.stringify(params.values) : null;
    if (json === this.sentParams) return;
    this.sentParams = json;
    if (params) this.worker.postMessage({ type: "params", values: params.values } satisfies ToWorker);
  }

  stop() {
    this.stopped = true;
    this.worker.terminate();
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }
}

// ---- which lights each shader is trying to change ---------------------------------

// A light counts as one a shader is trying to change if it tried this
// recently, so a shader that touches a light only now and then doesn't
// flicker in and out.
const EFFECT_WINDOW_MS = 1500;
// How often the answer is handed to React, at most.
const EFFECT_PUBLISH_MS = 250;

type Effects = ReadonlyMap<LayerKey, ReadonlySet<number>>;

let effects: Effects = new Map();
const effectListeners = new Set<() => void>();

function setEffects(next: Effects) {
  if (sameEffects(effects, next)) return;
  effects = next;
  for (const l of effectListeners) l();
}

function sameEffects(a: Effects, b: Effects): boolean {
  if (a.size !== b.size) return false;
  for (const [key, ids] of a) {
    const other = b.get(key);
    if (!other || other.size !== ids.size) return false;
    for (const id of ids) if (!other.has(id)) return false;
  }
  return true;
}

/** Whether a light's channels came out of a shader different from how they went in. */
function changed(before: Channels | undefined, after: Channels | undefined): boolean {
  if (before === after || !after) return false;
  for (const name of Object.keys(after)) if ((before?.[name] ?? 0) !== after[name]) return true;
  return false;
}

/**
 * The lights each shader has been trying to change lately in the preview, by
 * layer: before its mask or mute, like arclamp's `changing`. Empty unless
 * previewing.
 */
export function useLayerEffects(): Effects {
  return useSyncExternalStore(
    (l) => {
      effectListeners.add(l);
      return () => effectListeners.delete(l);
    },
    () => effects,
  );
}

// ---- the engine ---------------------------------------------------------------

interface Inputs {
  lights: LightInfo[];
  layers: Layer[];
  template: Record<string, Channels>;
}

class Simulation {
  private inputs: Inputs = { lights: [], layers: [], template: {} };
  private workers = new Map<LayerKey, ShaderWorker>();
  private timer: number | undefined;
  private running = false;
  /** When each layer last tried to change each light, by layer. */
  private seen = new Map<LayerKey, Map<number, number>>();
  private published = 0;

  set(inputs: Inputs) {
    this.inputs = inputs;
    // Workers follow the layers: a new script gets a fresh worker; a layer
    // that's gone gets none. Muted ones run too, as on arclamp, so what
    // they're trying to change is known; nothing passes on from them.
    const wanted = new Map(inputs.layers.map((l) => [l.key, l]));
    for (const [key, w] of this.workers) {
      const layer = wanted.get(key);
      if (!layer || layer.script !== w.script) {
        w.stop();
        this.workers.delete(key);
      }
    }
    for (const [key, layer] of wanted) {
      let w = this.workers.get(key);
      if (!w) {
        // A sketch being added: what it declares, as its pool's, till it's in the room to say so itself.
        const declared = (specs: ParamSpec[]) => {
          if (this.inputs.layers.find((l) => l.key === key)?.stage === "adding") drafts.declared(key, specs);
        };
        this.workers.set(key, (w = new ShaderWorker(layer.script, declared)));
      }
      w.sendParams(layer.params);
    }
    for (const key of this.seen.keys()) if (!wanted.has(key)) this.seen.delete(key);
  }

  start() {
    if (this.running) return;
    this.running = true;
    setSimulated(true);
    void this.tick();
  }

  stop() {
    this.running = false;
    window.clearTimeout(this.timer);
    for (const w of this.workers.values()) w.stop();
    this.workers.clear();
    this.seen.clear();
    setEffects(new Map());
    setSimulated(false);
  }

  /** Hand React the lights each layer tried to change within the window, every so often. */
  private publish(now: number) {
    if (now - this.published < EFFECT_PUBLISH_MS) return;
    this.published = now;
    const next = new Map<LayerKey, Set<number>>();
    for (const [key, marks] of this.seen) {
      const ids = new Set<number>();
      for (const [id, at] of marks) {
        if (now - at <= EFFECT_WINDOW_MS) ids.add(id);
        else marks.delete(id);
      }
      if (ids.size > 0) next.set(key, ids);
    }
    setEffects(next);
  }

  private async tick() {
    if (!this.running) return;
    const started = performance.now();
    const now = Date.now();
    const { lights, layers, template } = this.inputs;
    let state = baseState(lights, template);
    // The stack lists the top first; the room is built from the bottom up.
    for (const layer of [...layers].reverse()) {
      const w = this.workers.get(layer.key);
      if (!w || w.stopped) continue;
      const out = await w.call(prevOf(state, lights, now), now, now);
      if (!this.running) return;
      if (!out) continue;
      const step = applyLayer(state, lights, out, layer);
      let marks = this.seen.get(layer.key);
      if (!marks) this.seen.set(layer.key, (marks = new Map()));
      for (const id of step.trying) marks.set(id, now);
      state = step.state;
    }
    pushSimFrame({ initialTime: now, lights: state });
    this.publish(now);
    this.timer = window.setTimeout(() => void this.tick(), Math.max(0, TICK_MS - (performance.now() - started)));
  }
}

/** Run the preview while `active`, from these inputs. */
export function useSimulation(active: boolean, inputs: Inputs) {
  const sim = useRef<Simulation | null>(null);
  sim.current ??= new Simulation();
  useEffect(() => {
    if (active) sim.current!.set(inputs);
  }, [active, inputs]);
  useEffect(() => {
    if (!active) return;
    sim.current!.start();
    return () => sim.current!.stop();
  }, [active]);
}
