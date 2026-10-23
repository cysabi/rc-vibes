// param(): a number a sketch declares, for vibes to change while it runs.
//
//   const speed = param("speed", 7, { min: 1, max: 20 });
//   export const update = sketch(osc(3, speed));
//
// A param is a field: wherever a number can depend on here, it's that light's
// value. vibes keeps a value per light for each instance of a sketch in the
// room, and one for everywhere, so a selection on the map can set a param for
// a section; a light nobody's set reads the everywhere value, and without one
// the default. A param that makes no sense per light (a tempo) says
// perLight: false, and vibes offers it as one knob.
//
// Values arrive as packets over arclamp's udp (vibes sends them, and sends
// them again every second, so a lost one or a restarted sandbox is behind for
// a second at most); the preview sends the same packets to its worker. Each
// packet is one param's whole state, as JSON text:
//
//   { "vibes": "params", "v": 1, "seq": 12, "name": "speed", "all": 7, "lights": { "12": 9 } }
//
// What's declared, and the values, live on globalThis (__vibesParams): the
// builder reads the declarations after loading the script, and an edit in the
// editor runs the module again without losing the values.

import { field, type Field } from "./field.ts";

export interface ParamOptions {
  /** The slider's range; the default's own size, if not given. */
  min?: number;
  max?: number;
  /** The slider's step; a hundredth of the range, if not given. */
  step?: number;
  /** What the knob's called in vibes; the name, if not given. */
  label?: string;
  /** Whether it can be set per light (true, unless it says). */
  perLight?: boolean;
}

/** A param as declared, as vibes learns it from a build. */
export interface ParamSpec {
  name: string;
  default: number;
  min: number;
  max: number;
  step: number;
  label: string;
  perLight: boolean;
}

/** A param's values as vibes keeps them: for everywhere, and per light (by id); either may be unset. */
export interface ParamValues {
  all?: number;
  lights?: Record<string, number>;
}

/** One param's whole state, as vibes sends it. */
export interface ParamPacket extends ParamValues {
  vibes: "params";
  v: 1;
  /** Counts up with each send, so an older packet arriving late is ignored. */
  seq: number;
  name: string;
}

interface Registry {
  /** In the order declared. */
  declared: Record<string, ParamSpec>;
  values: Record<string, ParamValues>;
  /** The last seq taken for each param. */
  seqs: Record<string, number>;
  /** The udp socket, once bound (null: tried, and there's no udp here). */
  socket: UdpSocket | null | undefined;
}

// What arclamp's prelude gives a sandbox (and the preview's worker fakes):
// a socket to receive on. Only what's used here.
interface UdpSocket {
  recv(): unknown;
  drain?(): unknown[];
}
interface Udp {
  bind(opts?: { port?: number }): UdpSocket;
}

const KEY = "__vibesParams";

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  let r = g[KEY] as Registry | undefined;
  if (!r || typeof r !== "object") g[KEY] = r = { declared: {}, values: {}, seqs: {}, socket: undefined };
  return r;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A number vibes can change while the sketch runs: by light, or for everywhere.
 * Returns a field giving each light's value (the default, until vibes sets one).
 */
export function param(name: string, defaultValue: number, options: ParamOptions = {}): Field<number> {
  if (typeof name !== "string" || !/^[A-Za-z][\w-]{0,39}$/.test(name)) throw new Error(`a param's name is a word (letters, digits, _ or -), not ${JSON.stringify(name)}`);
  if (!finite(defaultValue)) throw new Error(`param ${name}'s default should be a number, not ${String(defaultValue)}`);
  const span = Math.max(1, Math.abs(defaultValue));
  const min = finite(options.min) ? options.min : Math.min(0, defaultValue);
  const max = finite(options.max) ? options.max : Math.max(min + span, defaultValue);
  if (min >= max) throw new Error(`param ${name}'s min (${min}) should be below its max (${max})`);
  const step = finite(options.step) && options.step > 0 ? options.step : (max - min) / 100;
  const spec: ParamSpec = {
    name,
    default: Math.min(max, Math.max(min, defaultValue)),
    min,
    max,
    step,
    label: typeof options.label === "string" && options.label.trim() ? options.label.trim() : name,
    perLight: options.perLight !== false,
  };
  registry().declared[name] = spec;
  return field((here) => valueOf(name, here.light.id));
}

/** A param's value for a light: its own, else everywhere's, else the default, kept within the range. */
export function valueOf(name: string, lightId: number): number {
  const r = registry();
  const spec = r.declared[name];
  if (!spec) return 0;
  const v = r.values[name];
  const own = v?.lights?.[String(lightId)];
  const value = finite(own) ? own : finite(v?.all) ? v.all : spec.default;
  return Math.min(spec.max, Math.max(spec.min, value));
}

/** Everything declared so far, in order. */
export const declaredParams = (): ParamSpec[] => Object.values(registry().declared);

/** Values as the host set them (the preview may set them straight, without packets). */
export function setParamValues(name: string, values: ParamValues) {
  registry().values[name] = cleanValues(values);
}

function cleanValues(values: ParamValues): ParamValues {
  const out: ParamValues = {};
  if (finite(values.all)) out.all = values.all;
  if (values.lights && typeof values.lights === "object") {
    const lights: Record<string, number> = {};
    for (const [id, v] of Object.entries(values.lights)) if (finite(v)) lights[id] = v;
    out.lights = lights;
  }
  return out;
}

/** A packet's text: what udp gives may be text, bytes, or an object carrying either. */
function textOf(packet: unknown): string | null {
  if (typeof packet === "string") return packet;
  if (packet === null || packet === undefined) return null;
  if (packet instanceof ArrayBuffer) return decode(new Uint8Array(packet));
  if (ArrayBuffer.isView(packet)) return decode(new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength));
  if (typeof packet === "object") {
    const o = packet as Record<string, unknown>;
    for (const key of ["data", "payload", "body", "text", "bytes"]) if (key in o) return textOf(o[key]);
  }
  return null;
}

function decode(bytes: Uint8Array): string {
  const g = globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } };
  if (g.TextDecoder) return new g.TextDecoder().decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** A packet taken in, if it's one of vibes' and not older than what's here; whether it was. */
export function takePacket(packet: unknown): boolean {
  const text = textOf(packet);
  if (!text) return false;
  let p: Partial<ParamPacket>;
  try {
    p = JSON.parse(text) as Partial<ParamPacket>;
  } catch {
    return false;
  }
  if (!p || p.vibes !== "params" || p.v !== 1 || typeof p.name !== "string") return false;
  const r = registry();
  if (finite(p.seq)) {
    const last = r.seqs[p.name];
    if (last !== undefined && p.seq <= last) return false;
    r.seqs[p.name] = p.seq;
  }
  r.values[p.name] = cleanValues(p);
  return true;
}

/**
 * Whatever vibes has sent since last time, taken in: called each tick by
 * sketch(). Binds the socket the first time there's anything declared.
 */
export function receiveParams(): void {
  const r = registry();
  if (r.socket === null || Object.keys(r.declared).length === 0) return;
  if (r.socket === undefined) {
    const udp = (globalThis as { udp?: Udp }).udp;
    try {
      r.socket = udp && typeof udp.bind === "function" ? udp.bind({ port: 0 }) : null;
    } catch {
      r.socket = null;
    }
    if (!r.socket) return;
  }
  const s = r.socket;
  if (typeof s.drain === "function") {
    for (const packet of s.drain()) takePacket(packet);
    return;
  }
  for (let i = 0; i < 64; i++) {
    const packet = s.recv();
    if (packet === null || packet === undefined) return;
    takePacket(packet);
  }
}
