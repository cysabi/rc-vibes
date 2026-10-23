// A sketch's own preview: the sketch in its own worker, on its own clock,
// making its own frames for the map it's drawn on (it's a FrameSource), and
// keeping what it logs for the console. It runs in the preview panel of the
// sketch's VS Code (main.tsx), and touches nothing else: not the room, and
// not any other preview.
//
// Its clock runs from when it was (re)started, less any pauses, and each
// frame's time is what update() gets, as both nowMs and initialMs: arclamp
// gives every layer of a frame that frame's time as initialMs (the room tone
// stamps each tick), so a sketch counting from initialMs to nowMs sees
// almost nothing go by, here as in the room. Time since it started is the
// sketch's own to keep, from the first initialMs it sees.
//
// Pausing stops calling update(), and the clock with it, so playing again
// picks up where it was. Restarting loads the sketch afresh, top-level state
// and all, on a new clock. Swapping in a new build of it does too, but keeps
// the clock: the preview carries on from where it was, running the new code. A sketch run as its
// modules is updated in place instead, by Vite's HMR (hmr() hands the
// worker what the box's Vite sends; onHmr, what the worker sends back).
// Each tick, update() gets every light at rest (every channel 0: nothing under
// it, as if it were all that's running), and its output is merged over that
// as arclamp merges. An update() that throws, or takes too long, stops the
// preview, with why in the console.

import type { Frame, LightInfo } from "../../shared/arclamp.ts";
import { packetOf, type ParamSpec, type ParamTable, type ParamValues } from "../../shared/params.ts";
import type { FrameSource } from "../live.ts";
import { baseState, mergeOutput, prevOf, type RoomState } from "../sim.ts";
// Inline, so it also starts where a page can't load a worker from a URL (a
// VS Code webview's resources are on another origin).
import SketchWorker from "./sketch.worker.ts?worker&inline";
import type { FromSketch, ToSketch } from "./sketch.worker.ts";
import type { LogLine, SketchSource } from "./protocol.ts";

const TICK_MS = 33;
// A sketch that hasn't answered by then is stuck (an endless loop). How long
// update() itself may take, the worker times, where it runs; this is only
// for one that never answers, generous so a busy page isn't taken for it.
const DEADLINE_MS = 2000;
const MAX_LINES = 200;

export class SketchRunner implements FrameSource {
  source: SketchSource;
  /** Told of each new line logged (not its repeats). */
  onLine: ((line: LogLine) => void) | null = null;
  /** Told what the worker's module runner sends the box's Vite. */
  onHmr: ((payload: unknown) => void) | null = null;
  readonly lights: LightInfo[];
  private readonly base: RoomState;
  private worker: Worker | null = null;
  private frame: Frame | null = null;
  private frameListeners = new Set<(f: Frame) => void>();
  private watchers = new Set<() => void>();
  /** When its clock started (less pauses, elapsed says how far it's gone). */
  private origin = 0;
  private elapsed = 0;
  private resumedAt = 0;
  private timer: number | undefined;
  private seq = 0;
  private waiting = new Map<number, (out: unknown) => void>();
  private scheduled = false;

  playing = false;
  /** Why it stopped by itself, if it did. */
  stopped: string | null = null;
  log: LogLine[] = [];
  /** What the sketch declares as params, as of its last load or update. */
  params: ParamSpec[] = [];
  /** The knobs' values here: the preview's own, kept across restarts and new builds, sent to the sketch as vibes would in the room. */
  values: ParamTable = {};
  private packets = 0;
  /** Bumped whenever any of the above changes, for React. */
  version = 0;

  constructor(source: SketchSource, lights: LightInfo[]) {
    this.source = source;
    this.lights = lights;
    this.base = baseState(lights, {});
    this.restart();
  }

  latest = () => this.frame;

  subscribe = (listener: (f: Frame) => void) => {
    this.frameListeners.add(listener);
    return () => void this.frameListeners.delete(listener);
  };

  /** For React: called when it plays, pauses or stops, or logs. */
  watch = (listener: () => void) => {
    this.watchers.add(listener);
    return () => void this.watchers.delete(listener);
  };

  /** How long it's run, in ms, not counting pauses. */
  elapsedMs(): number {
    return this.elapsed + (this.playing ? performance.now() - this.resumedAt : 0);
  }

  play() {
    if (this.playing || this.stopped || !this.worker) return;
    this.playing = true;
    this.resumedAt = performance.now();
    this.changed();
    void this.tick();
  }

  pause() {
    if (!this.playing) return;
    this.elapsed = this.elapsedMs();
    this.playing = false;
    window.clearTimeout(this.timer);
    this.changed();
  }

  restart() {
    this.halt();
    this.load();
    this.origin = Date.now();
    this.elapsed = 0;
    this.stopped = null;
    this.log = [];
    this.show(this.base);
    this.play();
  }

  /** A new build (or another way of running it) in place of the old, on the same clock; it plays unless it was paused. */
  swap(source: SketchSource) {
    const elapsed = this.elapsedMs();
    const paused = !this.playing && this.stopped === null;
    this.source = source;
    this.halt();
    this.load();
    this.elapsed = elapsed;
    this.stopped = null;
    if (paused) this.changed();
    else this.play();
  }

  /**
   * What the box's Vite sends the sketch's modules: their updates. Stopped
   * (by an error), an update loads it all again, on the same clock: the edit
   * that fixes it starts it.
   */
  hmr(payload: unknown) {
    if (this.source.kind !== "modules") return;
    const p = payload as { type: string };
    if (this.stopped !== null && (p.type === "update" || p.type === "full-reload")) this.swap(this.source);
    else this.post({ type: "hmr", payload: p });
  }

  private post(m: ToSketch) {
    this.worker?.postMessage(m);
  }

  private load() {
    const worker = new SketchWorker();
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<FromSketch>) => {
      if (worker !== this.worker) return;
      const m = e.data;
      if (m.type === "log") this.write(m.level, m.text);
      else if (m.type === "params") {
        this.params = m.specs;
        // A fresh sandbox (or an update) starts from the defaults: the knobs' values, again.
        this.resendParams();
        this.changed();
      } else if (m.type === "out") this.answer(m.seq, m.out);
      else if (m.type === "hmr") this.onHmr?.(m.payload);
      else if (m.type === "error") {
        if (m.seq !== undefined) this.answer(m.seq, null);
        this.fail(m.message);
      }
    };
    const s = this.source;
    this.post(s.kind === "script" ? { type: "load", script: s.script } : { type: "load-modules", entry: s.entry });
  }

  /** A param's values from a knob here. */
  setParam(name: string, values: ParamValues) {
    this.values = { ...this.values, [name]: values };
    this.post({ type: "udp", packets: [packetOf(++this.packets, name, values)] });
    this.changed();
  }

  private resendParams() {
    const packets = this.params.flatMap((spec) => (this.values[spec.name] ? [packetOf(++this.packets, spec.name, this.values[spec.name]!)] : []));
    if (packets.length > 0) this.post({ type: "udp", packets });
  }

  dispose() {
    this.halt();
    this.frameListeners.clear();
    this.watchers.clear();
  }

  private halt() {
    this.playing = false;
    window.clearTimeout(this.timer);
    this.worker?.terminate();
    this.worker = null;
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  private async tick() {
    if (!this.playing || !this.worker) return;
    const started = performance.now();
    const at = this.origin + this.elapsedMs();
    const out = await this.call(prevOf(this.base, this.lights, at), at);
    if (out) this.show(mergeOutput(this.base, this.lights, out));
    if (!this.playing) return;
    this.timer = window.setTimeout(() => void this.tick(), Math.max(0, TICK_MS - (performance.now() - started)));
  }

  private call(prev: unknown, now: number): Promise<unknown> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        if (!this.waiting.delete(seq)) return;
        resolve(null);
        this.fail(`update() didn't answer within ${DEADLINE_MS / 1000} s`);
      }, DEADLINE_MS);
      this.waiting.set(seq, (out) => {
        window.clearTimeout(timer);
        resolve(out);
      });
      // The frame's time as initialMs, as arclamp gives it.
      this.post({ type: "tick", seq, prev, now, initial: now });
    });
  }

  private answer(seq: number, out: unknown) {
    const done = this.waiting.get(seq);
    this.waiting.delete(seq);
    done?.(out);
  }

  private show(state: RoomState) {
    this.frame = { initialTime: this.origin + this.elapsedMs(), lights: state };
    for (const l of this.frameListeners) l(this.frame);
  }

  private fail(message: string) {
    this.write("error", message);
    this.stopped = message;
    this.halt();
    this.changed();
  }

  private write(level: LogLine["level"], text: string) {
    const last = this.log[this.log.length - 1];
    if (last && last.level === level && last.text === text) {
      this.log = [...this.log.slice(0, -1), { ...last, count: last.count + 1 }];
    } else {
      const line = { at: this.elapsedMs(), level, text, count: 1 };
      this.log = [...this.log.slice(-(MAX_LINES - 1)), line];
      this.onLine?.(line);
    }
    this.changed();
  }

  /** Tells React, at most once a frame: a sketch can log on every tick. */
  private changed() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.version++;
      for (const l of this.watchers) l();
    });
  }
}
