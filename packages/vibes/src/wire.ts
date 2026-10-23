// The wire between a sketch and vibes: what a sketch says of its params, and
// the values vibes sends it, as JSON. Nothing here touches globals, so vibes
// uses it too (src/shared/params.ts), for the same rules on both ends.
//
// A param has a kind (a number, a color, or a toggle), a default, and the
// lights it's for: a filter of kinds ("color", "switch", as light.kind),
// tags and ids. A light passes if it passes every part given, and any one
// value in a part will do; a part left out lets every light through. A color
// is only ever for color lights.
//
// Values are by light, grouped by value: [[value, [ids]], …], listing only the
// lights that aren't at the default. A change is the same, with null putting
// lights back to the default.
//
// The stream (vibes' side: src/server/params.ts):
//
//   POST <url>  Authorization: Bearer <token>
//   { "v": 1, "params": [ParamSpec, …] }
//
//   event: state    data: { "v": 1, "values": { name: Groups } }   first, on every connect
//   event: change   data: { "name": …, "set": Changes }            each edit, in order
//   event: end      data: { "reason": "replaced" | "revoked" | "gone" }
//   : keep-alive                                                    every 15 s

export const PROTOCOL = 1;

/** A param's name: a word. */
export const PARAM_NAME = /^[A-Za-z][\w-]{0,39}$/;

/** The most params a sketch may have. */
export const MAX_PARAMS = 64;

/** The kinds of light, as light.kind has them. */
export const LIGHT_KINDS = ["color", "switch"] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

/** The lights a param is for: each part left out lets every light through. */
export interface LightFilter {
  kinds?: LightKind[];
  tags?: string[];
  ids?: number[];
}

/** A color as the wire has it: Color.toJSON()'s. */
export type ColorValue = {
  a: number;
  b: number;
  lm: number;
  fidelity: number;
};

interface Declared {
  name: string;
  /** What vibes calls it. */
  label: string;
  lights: LightFilter;
}
export interface NumberSpec extends Declared {
  kind: "number";
  default: number;
  min: number;
  max: number;
  step: number;
}
export interface ColorSpec extends Declared {
  kind: "color";
  default: ColorValue;
}
export interface ToggleSpec extends Declared {
  kind: "toggle";
  default: boolean;
}
/** A param, as a sketch declares it. */
export type ParamSpec = NumberSpec | ColorSpec | ToggleSpec;
export type ParamKind = ParamSpec["kind"];
export type ParamValue = number | ColorValue | boolean;

/** A param's values: each value with its lights, listing only lights not at the default. */
export type Groups = [ParamValue, number[]][];
/** A change to a param's values: these lights to this value, or (null) back to the default. */
export type Changes = [ParamValue | null, number[]][];
/** An instance's values, by param name. */
export type ParamTable = Record<string, Groups>;

/** What a shader posts as it connects. */
export interface Hello {
  v: 1;
  params: ParamSpec[];
}
export interface StateEvent {
  v: 1;
  values: ParamTable;
}
export interface ChangeEvent {
  name: string;
  set: Changes;
}
export interface EndEvent {
  reason: "replaced" | "revoked" | "gone";
}

/** What a filter looks at, of a light. */
export interface LightFacts {
  id: number;
  kind: LightKind;
  tags: readonly string[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Whether a param is for this light. */
export function passes(filter: LightFilter, light: LightFacts): boolean {
  if (filter.kinds && !filter.kinds.includes(light.kind)) return false;
  if (filter.tags && !filter.tags.some((t) => light.tags.includes(t))) return false;
  if (filter.ids && !filter.ids.includes(light.id)) return false;
  return true;
}

/** A color, if this is one as the wire has it (fidelity 1 if left out). */
export function colorValue(v: unknown): ColorValue | null {
  if (!v || typeof v !== "object") return null;
  const { a, b, lm, fidelity = 1 } = v as Record<string, unknown>;
  if (!finite(a) || !finite(b) || !finite(lm) || lm < 0 || !finite(fidelity) || fidelity < 0 || fidelity > 1) return null;
  return { a, b, lm, fidelity };
}

/** A value as this param takes it (a number kept within its range), or null if it isn't one. */
export function cleanValue(spec: ParamSpec, v: unknown): ParamValue | null {
  switch (spec.kind) {
    case "number":
      return finite(v) ? clamp(v, spec.min, spec.max) : null;
    case "toggle":
      return typeof v === "boolean" ? v : null;
    case "color":
      return colorValue(v);
  }
}

/** The same value. */
export function sameValue(x: ParamValue, y: ParamValue): boolean {
  if (typeof x !== "object" || typeof y !== "object") return x === y;
  return x.a === y.a && x.b === y.b && x.lm === y.lm && x.fidelity === y.fidelity;
}

const keyOf = (v: ParamValue) => (typeof v === "object" ? `${v.a},${v.b},${v.lm},${v.fidelity}` : String(v));

/** Each light's value, from groups: anything that isn't one of this param's values is left out. */
export function valuesOf(spec: ParamSpec, groups: unknown): Map<number, ParamValue> {
  const out = new Map<number, ParamValue>();
  if (!Array.isArray(groups)) return out;
  for (const g of groups) {
    if (!Array.isArray(g) || !Array.isArray(g[1])) continue;
    const v = cleanValue(spec, g[0]);
    if (v === null) continue;
    for (const id of g[1]) if (isId(id)) out.set(id, v);
  }
  return out;
}

/** Groups from each light's value, in the order the lights come; lights at the default left out. */
export function groupsOf(spec: ParamSpec, values: Map<number, ParamValue>): Groups {
  const groups = new Map<string, [ParamValue, number[]]>();
  for (const [id, v] of values) {
    if (sameValue(v, spec.default)) continue;
    const k = keyOf(v);
    const g = groups.get(k);
    if (g) g[1].push(id);
    else groups.set(k, [v, [id]]);
  }
  return [...groups.values()];
}

/**
 * Groups with a change made: each light given to its value, or (null) back to
 * the default. Lights `allowed` turns down, and values that aren't this
 * param's, are passed over.
 */
export function withChanges(spec: ParamSpec, groups: unknown, set: Changes, allowed: (id: number) => boolean = () => true): Groups {
  const values = valuesOf(spec, groups);
  for (const [raw, ids] of Array.isArray(set) ? set : []) {
    if (!Array.isArray(ids)) continue;
    const v = raw === null ? null : cleanValue(spec, raw);
    if (raw !== null && v === null) continue;
    for (const id of ids) {
      if (!isId(id) || !allowed(id)) continue;
      if (v === null) values.delete(id);
      else values.set(id, v);
    }
  }
  return groupsOf(spec, values);
}

/** A list of strings, from one or many; null if anything in it isn't one. */
function strings(v: unknown): string[] | null {
  const list = typeof v === "string" ? [v] : v;
  return Array.isArray(list) && list.every((s) => typeof s === "string") ? [...new Set(list)] : null;
}

/**
 * A filter from what was given: { kinds, tags, ids }, each one or a list; a
 * kind (or kinds) alone stands for { kinds }. Empty parts let every light
 * through, as if left out. A string if it can't be read, saying why.
 */
export function filterOf(v: unknown): LightFilter | string {
  if (v === undefined || v === null) return {};
  if (typeof v === "string" || Array.isArray(v)) return filterOf({ kinds: v });
  if (typeof v !== "object") return `lights is { kinds, tags, ids }, not ${JSON.stringify(v)}`;
  const o = v as Record<string, unknown>;
  const out: LightFilter = {};
  if (o.kinds !== undefined) {
    const kinds = strings(o.kinds);
    if (!kinds) return "lights' kinds are names";
    const bad = kinds.find((k) => !(LIGHT_KINDS as readonly string[]).includes(k));
    if (bad !== undefined) return `lights' kinds are "color" or "switch", not ${JSON.stringify(bad)}`;
    if (kinds.length > 0) out.kinds = kinds as LightKind[];
  }
  if (o.tags !== undefined) {
    const tags = strings(o.tags);
    if (!tags) return "lights' tags are names";
    if (tags.length > 0) out.tags = tags;
  }
  if (o.ids !== undefined) {
    const list = typeof o.ids === "number" ? [o.ids] : o.ids;
    if (!Array.isArray(list) || !list.every(isId)) return "lights' ids are light ids";
    if (list.length > 0) out.ids = [...new Set(list as number[])];
  }
  return out;
}

/**
 * A param as declared, checked: the shape here, every rule kept. A string if
 * it isn't one, saying why. A color is made for color lights only, as it
 * can't be for any other.
 */
export function checkSpec(raw: unknown): ParamSpec | string {
  if (!raw || typeof raw !== "object") return "a param is an object";
  const o = raw as Record<string, unknown>;
  const name = o.name;
  if (typeof name !== "string" || !PARAM_NAME.test(name)) return `a param's name is a word (letters, digits, _ or -), not ${JSON.stringify(name)}`;
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 60) : name;
  const lights = filterOf(o.lights);
  if (typeof lights === "string") return `param ${name}: ${lights}`;
  switch (o.kind) {
    case "number": {
      const { min, max, step } = o;
      if (!finite(min) || !finite(max) || !(min < max)) return `param ${name}: its min should be a number below its max`;
      if (!finite(step) || step <= 0) return `param ${name}: its step should be above 0`;
      if (!finite(o.default) || o.default < min || o.default > max) return `param ${name}: its default should be a number from its min to its max`;
      return { kind: "number", name, label, lights, default: o.default, min, max, step };
    }
    case "toggle":
      if (typeof o.default !== "boolean") return `param ${name}: a toggle's default is true or false`;
      return { kind: "toggle", name, label, lights, default: o.default };
    case "color": {
      const d = colorValue(o.default);
      if (!d) return `param ${name}: its default should be a color ({ a, b, lm, fidelity })`;
      if (lights.kinds?.includes("switch")) return `param ${name}: a color is for color lights; old bulbs only switch (a toggle can be for them)`;
      return { kind: "color", name, label, lights: { ...lights, kinds: ["color"] }, default: d };
    }
    default:
      return `param ${name}: its kind is "number", "color" or "toggle", not ${JSON.stringify(o.kind)}`;
  }
}
