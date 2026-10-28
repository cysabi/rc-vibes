// param(): something vibes can change while the sketch runs, light by light:
// a number, a color, or a toggle.
//
//   const speed = param("speed", 0.05, { min: 0, max: 0.5 });
//   const tint = param("tint", "#f80");
//   const on = param("on", false, { lights: "switch" });
//
//   const wave = osc(3, speed);
//   export const update = sketch({ color: (here) => tint(here).at(600 * wave(here)), switch: on });
//
// A param is a field: each light reads its own value, or the default until
// vibes sets one. Its kind is its default's: a number, true or false, or
// anything that says a color. `lights` says which lights it's for (a kind or
// kinds, or { kinds, tags, ids }; wire.ts): vibes only offers it for those,
// and any other light reads the default. A color is for color lights only.
//
// vibes learns what a sketch declares from the sketch itself, as it runs in
// the room: vibes links each shader once (an eval in arclamp calling
// __vibes.connect), and the library opens a stream to vibes, saying what's
// declared, and takes each change as it comes (wire.ts has the protocol). The
// link and the values are kept on globalThis, so a new script in the same
// sandbox carries on from them; the declarations are the script's own.
//
// The preview and the map's simulation have no stream: they hand values in
// with __vibes.apply(), the same events the stream carries, and ask what's
// declared with __vibes.params(). A preview updated in place (HMR, only the
// modules edited run again) says which are about to run again (retire), and
// that they have (settle): what they no longer declare goes then.

import { color, type Color, type ColorInput, type ColorLike } from "./color.ts";
import { field, type Field } from "./field.ts";
import type { Here } from "./here.ts";
import {
  checkSpec,
  passes,
  PROTOCOL,
  showClock,
  valuesOf,
  withChanges,
  type ChangeEvent,
  type Changes,
  type ClockEvent,
  type ColorValue,
  type ParamSpec,
  type ParamTable,
  type ShowClock,
  type StateEvent,
} from "./wire.ts";

export interface ParamOptions {
  /** A number's range; the default's own size, if not given. */
  min?: number;
  max?: number;
  /** A number's step; a hundredth of the range, if not given. */
  step?: number;
  /** What vibes calls it; its name, if not given. */
  label?: string;
  /** The lights it's for: a kind ("color", "switch") or kinds, or { kinds, tags, ids }, each one or a list. Every light, if not given (a color: every color light). */
  lights?: string | readonly string[] | { kinds?: string | readonly string[]; tags?: string | readonly string[]; ids?: number | readonly number[] };
}

// What the host gives the library (arclamp's sandbox, a browser): only what's used, and any may be missing.
interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}
interface Host {
  fetch?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: unknown },
  ) => Promise<{ ok: boolean; status: number; body: { getReader(): Reader } | null }>;
  AbortController?: new () => { signal: unknown; abort(): void };
  TextDecoder?: new () => { decode(bytes?: Uint8Array, options?: { stream: boolean }): string };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}
const host = globalThis as unknown as Host;

/** Where to reach vibes, as vibes' link gave it. */
interface Link {
  url: string;
  token: string;
}

// The stream to vibes: one at a time, opened again after a break (1 s, doubling
// to 30 s; back to 1 s after one that lasted), and given up when vibes says
// the link is no good (it links the shader again when it wants it).
const FIRST_WAIT_MS = 1000;
const MOST_WAIT_MS = 30_000;
const LASTED_MS = 30_000;
// vibes sends something every 15 s: nothing for this long, and the stream's dead.
const QUIET_MS = 45_000;

/**
 * What outlives a script in its sandbox: the values, the link, and the
 * stream: the one open now, which start of one that was (each counts up),
 * the next try at one (and whose), how long that waits, and whether another
 * stream took over. The stream's kept here, not in a script's own module, so
 * a new script's stream and anything an old one left behind can't both carry
 * on: only the newest script's library (owner) opens one.
 */
interface Kept {
  values: ParamTable;
  /** The show clock, as vibes last said it (show.ts); null till it has. */
  clock: ShowClock | null;
  link: Link | null;
  owner: unknown;
  stream: { abort(): void } | null;
  started: number;
  retry: unknown;
  retryBy: unknown;
  wait: number;
  halted: boolean;
}

const KEPT = "__vibesParams";

function kept(): Kept {
  const g = globalThis as Record<string, unknown>;
  let k = g[KEPT] as Kept | undefined;
  if (!k || typeof k !== "object" || typeof k.values !== "object" || k.values === null) {
    g[KEPT] = k = { values: {}, clock: null, link: null, owner: null, stream: null, started: 0, retry: null, retryBy: null, wait: FIRST_WAIT_MS, halted: false };
  }
  // Kept by an older library: what it didn't keep.
  k.clock ??= null;
  k.started ??= 0;
  k.retry ??= null;
  k.wait ??= FIRST_WAIT_MS;
  k.halted ??= false;
  return k;
}

/** This script's params, in the order declared. */
const declared = new Map<string, ParamSpec>();

/**
 * Which module declared each param, where that can be told (a preview's
 * sketch runs as its modules, each its own; a built script is all one); and
 * those whose module is being run again (retire), till it's said what it
 * declares now (settle): a param a module no longer declares goes, as it
 * would on reloading.
 */
const origins = new Map<string, string | null>();
const suspect = new Set<string>();

/** The module that called param(), by the address its frames have in the stack; null if that can't be told. */
function callerModule(): string | null {
  const urls = (new Error().stack ?? "").split("\n").map((line) => /((?:[a-z][\w+.-]*:\/\/|\/)[^\s()]+?)(?::\d+){1,2}\)?\s*$/.exec(line.trim())?.[1] ?? null);
  const own = urls.find((u) => u !== null);
  return urls.find((u) => u !== null && u !== own) ?? null;
}

/** Each param's values by light, read from its groups once each time they change (colors as Colors). */
const cache = new Map<string, { groups: unknown; spec: ParamSpec; byLight: Map<number, unknown> }>();

function byLight(spec: ParamSpec): Map<number, unknown> {
  const groups = kept().values[spec.name];
  const c = cache.get(spec.name);
  if (c && c.groups === groups && c.spec === spec) return c.byLight;
  const out = new Map<number, unknown>();
  for (const [id, v] of valuesOf(spec, groups)) out.set(id, spec.kind === "color" ? color(v as ColorValue) : v);
  cache.set(spec.name, { groups, spec, byLight: out });
  return out;
}

/** A param as declared, from what param() was given. */
function specOf(name: string, given: unknown, o: ParamOptions): ParamSpec {
  const base = { name, label: o.label, lights: o.lights };
  let raw: unknown;
  if (typeof given === "number") {
    const span = Math.max(1, Math.abs(given));
    const min = Number.isFinite(o.min) ? o.min! : Math.min(0, given);
    const max = Number.isFinite(o.max) ? o.max! : Math.max(min + span, given);
    const step = Number.isFinite(o.step) && o.step! > 0 ? o.step! : (max - min) / 100;
    raw = { ...base, kind: "number", default: Number.isFinite(given) ? Math.min(max, Math.max(min, given)) : given, min, max, step };
  } else if (typeof given === "boolean") {
    raw = { ...base, kind: "toggle", default: given };
  } else {
    let c: Color;
    try {
      c = color(given as ColorInput);
    } catch (err) {
      throw new Error(`param ${name}'s default should be a number, true or false, or a color: ${(err as Error).message}`);
    }
    raw = { ...base, kind: "color", default: c.toJSON() };
  }
  const spec = checkSpec(raw);
  if (typeof spec === "string") throw new Error(spec);
  return spec;
}

/**
 * Something vibes can change while the sketch runs, light by light: a number,
 * a color, or a toggle (its default says which). A field: each light reads its
 * own value, or the default until vibes sets one.
 */
export function param(name: string, defaultValue: number, options?: ParamOptions): Field<number>;
export function param(name: string, defaultValue: boolean, options?: ParamOptions): Field<boolean>;
export function param(name: string, defaultValue: ColorLike, options?: ParamOptions): Field<Color>;
export function param(name: string, defaultValue: unknown, options: ParamOptions = {}): Field<unknown> {
  const spec = specOf(name, defaultValue, options);
  declared.set(name, spec);
  origins.set(name, callerModule());
  suspect.delete(name);
  // Linked already (a new script in a linked sandbox): the stream, once the script's in.
  if (kept().link && !soon) {
    soon = true;
    host.setTimeout?.(() => {
      soon = false;
      tickParams();
    }, 0);
  }
  const fallback = spec.kind === "color" ? color(spec.default) : spec.default;
  return field((here: Here) => {
    const light = here.light;
    if (!passes(spec.lights, light)) return fallback;
    const v = byLight(spec).get(light.id);
    return v === undefined ? fallback : v;
  });
}

/** One of the stream's events (or the same from a preview's host): taken in; whether it was. */
function apply(event: string, data: unknown): boolean {
  const k = kept();
  if (event === "state") {
    const values = (data as Partial<StateEvent> | null)?.values;
    if (!values || typeof values !== "object") return false;
    k.values = { ...values };
    return true;
  }
  if (event === "change") {
    const d = data as Partial<ChangeEvent> | null;
    const spec = typeof d?.name === "string" ? declared.get(d.name) : undefined;
    if (!spec || !Array.isArray(d!.set)) return false;
    k.values = { ...k.values, [spec.name]: withChanges(spec, k.values[spec.name], d!.set as Changes) };
    return true;
  }
  if (event === "clock") {
    const clock = showClock((data as Partial<ClockEvent> | null)?.clock);
    if (!clock) return false;
    k.clock = clock;
    return true;
  }
  return false;
}

/** The show clock as vibes last said it, kept with the sandbox (show.ts); null till it has. */
export const heardClock = (): ShowClock | null => kept().clock;

// This script: whether its stream is open, and whether it's to open soon.
const me = {};
let soon = false;
let open = false;

type Ending = "again" | "stop" | "forget";

/** The stream started (again, if one's open): now, whatever's waiting, this script's or an older one's. */
function start() {
  const k = kept();
  const link = k.link;
  if (k.owner !== me || !link || !host.fetch || !host.AbortController || !host.setTimeout) return;
  if (k.retry !== null) host.clearTimeout?.(k.retry);
  k.retry = null;
  try {
    k.stream?.abort();
  } catch {
    // Gone already.
  }
  const ctl = new host.AbortController();
  k.stream = ctl;
  open = true;
  const mine = ++k.started;
  const began = Date.now();
  void follow(link, ctl).then((ending) => {
    // Another's begun since (this script's, or a newer script's): it's that one's to carry on.
    if (k.started !== mine) return;
    open = false;
    k.stream = null;
    if (ending === "forget" && k.link === link) k.link = null;
    if (ending === "stop") k.halted = true;
    if (ending !== "again") return;
    if (Date.now() - began >= LASTED_MS) k.wait = FIRST_WAIT_MS;
    k.retryBy = me;
    k.retry = host.setTimeout!(() => {
      k.retry = null;
      start();
    }, k.wait);
    k.wait = Math.min(MOST_WAIT_MS, k.wait * 2);
  });
}

/** Bytes as text, a character each (without a TextDecoder, which arclamp has; vibes only ever sends ASCII). */
function latin1(bytes: Uint8Array | undefined): string {
  let s = "";
  if (bytes) for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return s;
}

async function follow(link: Link, ctl: { signal: unknown; abort(): void }): Promise<Ending> {
  let quiet: unknown = null;
  const heard = () => {
    if (quiet !== null) host.clearTimeout?.(quiet);
    quiet = host.setTimeout!(() => ctl.abort(), QUIET_MS);
  };
  try {
    heard();
    const res = await host.fetch!(link.url, {
      method: "POST",
      headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ v: PROTOCOL, params: [...declared.values()] }),
      signal: ctl.signal,
    });
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) return "forget";
    if (!res.ok || !res.body) return "again";
    const reader = res.body.getReader();
    const decoder = host.TextDecoder ? new host.TextDecoder() : null;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "again";
      heard();
      text += decoder ? decoder.decode(value, { stream: true }) : latin1(value);
      for (let at = text.indexOf("\n\n"); at >= 0; at = text.indexOf("\n\n")) {
        const ending = take(text.slice(0, at));
        text = text.slice(at + 2);
        if (ending) {
          ctl.abort();
          return ending;
        }
      }
    }
  } catch {
    return "again";
  } finally {
    if (quiet !== null) host.clearTimeout?.(quiet);
  }
}

/** One event from the stream, taken in; how the stream ends, if it's an end. */
function take(block: string): Ending | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
    if (name === "event") event = value;
    else if (name === "data") data.push(value);
  }
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  if (event === "end") {
    const reason = (parsed as { reason?: unknown } | null)?.reason;
    return reason === "revoked" || reason === "gone" ? "forget" : "stop";
  }
  apply(event, parsed);
  return null;
}

/**
 * Called each tick (sketch() does): a linked sandbox gets this script's
 * stream, unless it has it, is waiting to try again, or was told another
 * stream took over (until vibes links it again).
 */
export function tickParams(): void {
  const k = kept();
  if (k.owner !== me || open || !k.link || k.halted) return;
  // An older script's wait is this one's to cut short: its stream says what this script declares.
  if (k.retry !== null && k.retryBy === me) return;
  start();
}

/** vibes linking this sandbox (an eval in arclamp): where to reach it, and the stream opened at once. */
function connect(opts: unknown): { v: number; params?: number; error?: string } {
  const o = opts as Partial<Link & { v: number }> | null;
  if (!o || o.v !== PROTOCOL || typeof o.url !== "string" || typeof o.token !== "string") return { v: PROTOCOL, error: `connect takes { v: ${PROTOCOL}, url, token }` };
  const k = kept();
  k.link = { url: o.url, token: o.token };
  k.halted = false;
  k.wait = FIRST_WAIT_MS;
  start();
  return { v: PROTOCOL, params: declared.size };
}

/**
 * Modules about to run again (a preview's, as its code's edited: by the ends
 * of their addresses, or "*" for all of them): what they declared stays till
 * settle(), and goes then unless they've declared it again.
 */
function retire(paths: readonly string[] | "*") {
  for (const [name, module] of origins) {
    if (paths === "*" || (module !== null && paths.some((p) => p !== "" && module.endsWith(p)))) suspect.add(name);
  }
}

/** The modules run again have run: what they no longer declare, gone. */
function settle() {
  for (const name of suspect) {
    declared.delete(name);
    origins.delete(name);
    cache.delete(name);
  }
  suspect.clear();
}

/** What vibes (in the room, by eval) and previews (in their workers) use: the script's own, so its params. */
export interface VibesHost {
  v: number;
  connect(opts: unknown): { v: number; params?: number; error?: string };
  apply(event: string, data: unknown): boolean;
  params(): ParamSpec[];
  /** Since 0.3.1 (a preview's hot reloads); an older library has neither. */
  retire?(paths: readonly string[] | "*"): void;
  settle?(): void;
}

// This script is the sandbox's newest: its library's the one to keep the stream.
kept().owner = me;

(globalThis as Record<string, unknown>).__vibes = {
  v: PROTOCOL,
  connect,
  apply,
  params: () => [...declared.values()],
  retire,
  settle,
} satisfies VibesHost;
