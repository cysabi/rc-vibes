// Params: what a sketch declares for vibes to change while it runs, light by
// light (a number, a color, or a toggle, for the lights its filter lets
// through), and each instance's values. The sketch says what it declares
// itself, as it runs in the room (src/server/params.ts has the stream); the
// rules for both ends are the library's (packages/vibes/src/wire.ts), so
// vibes and sketches agree on every one.

import type { LightInfo } from "./arclamp.ts";
import { isBinary } from "./fixtures.ts";
import { LUMENS_PER_BRIGHTNESS, type Lemtone } from "./lemtone.ts";
import { cleanValue, groupsOf, passes, valuesOf, type ColorValue, type Groups, type LightFacts, type LightKind, type ParamSpec, type ParamTable, type ParamValue } from "../../packages/vibes/src/wire.ts";

export {
  checkSpec,
  cleanValue,
  colorValue,
  filterOf,
  groupsOf,
  LIGHT_KINDS,
  MAX_PARAMS,
  PARAM_NAME,
  passes,
  PROTOCOL,
  sameValue,
  valuesOf,
  withChanges,
  type ChangeEvent,
  type Changes,
  type ColorSpec,
  type ColorValue,
  type EndEvent,
  type Groups,
  type Hello,
  type LightFacts,
  type LightFilter,
  type LightKind,
  type NumberSpec,
  type ParamKind,
  type ParamSpec,
  type ParamTable,
  type ParamValue,
  type StateEvent,
  type ToggleSpec,
} from "../../packages/vibes/src/wire.ts";

/** A shader's params, as a page shows them: what its sketch says it declares (null until something running it has), and its values. */
export interface ShaderParams {
  declared: ParamSpec[] | null;
  values: ParamTable;
}

type Facts = Pick<LightInfo, "id" | "type" | "tags"> & Partial<Pick<LightInfo, "channels">>;

/**
 * What kind of light it is, as sketches see it (light.kind): one with an `on`
 * channel switches (old bulbs), the rest take colors. By its type, where its
 * channels aren't known.
 */
export const kindOf = (light: Pick<Facts, "type" | "channels">): LightKind =>
  light.channels?.length ? (light.channels.includes("on") ? "switch" : "color") : isBinary(light.type) ? "switch" : "color";

/** A light, as a param's filter sees it. */
export const factsOf = (light: Facts): LightFacts => ({ id: light.id, kind: kindOf(light), tags: light.tags ?? [] });

/** Whether a param is for this light. */
export const appliesTo = (spec: ParamSpec, light: Facts) => passes(spec.lights, factsOf(light));

/** For each param, whether it's for a light (by id) of these: lights not among them aren't. */
export function lightsFor(lights: readonly Facts[]): (spec: ParamSpec) => (id: number) => boolean {
  const facts = new Map(lights.map((l) => [l.id, factsOf(l)]));
  return (spec) => (id) => {
    const f = facts.get(id);
    return f !== undefined && passes(spec.lights, f);
  };
}

/** A pool's values (by param, by light: shared/live.ts) as groups, for the params declared: values that aren't their param's left out. */
export function tableOf(declared: readonly ParamSpec[], values: Record<string, Record<string, unknown>> | undefined): ParamTable {
  const out: ParamTable = {};
  for (const spec of declared) {
    const byLight = values?.[spec.name];
    if (!byLight) continue;
    const m = new Map<number, ParamValue>();
    for (const [id, v] of Object.entries(byLight)) {
      const clean = cleanValue(spec, v);
      if (clean !== null) m.set(Number(id), clean);
    }
    out[spec.name] = groupsOf(spec, m);
  }
  return out;
}

/** Each light's value, by id: its own, or the default. */
export function valuesAt(spec: ParamSpec, groups: Groups | undefined, ids: readonly number[]): ParamValue[] {
  const set = valuesOf(spec, groups);
  return ids.map((id) => set.get(id) ?? spec.default);
}

/** A number as a knob shows it: as many decimals as its step has (2.5, one; 0.25, two), up to four. */
export function paramText(v: number, step: number): string {
  let decimals = 0;
  while (decimals < 4 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-9) decimals++;
  return v.toFixed(decimals);
}

/** A color param's value as room tone's color editor has it (brightness 1.0 = 1000 lm), and back. */
export const lemtoneOf = (c: ColorValue): Lemtone => ({ a: c.a, b: c.b, brightness: c.lm / LUMENS_PER_BRIGHTNESS, fidelity: c.fidelity });
export const colorOfLemtone = (t: Lemtone): ColorValue => ({ a: t.a, b: t.b, lm: t.brightness * LUMENS_PER_BRIGHTNESS, fidelity: t.fidelity });

/**
 * A color's numbers: each a path of its own under its light's in the live
 * tree (shared/live.ts), so changing some of them (a brightness dragged over
 * lights of different colors) changes just those.
 */
export const COLOR_PARTS = ["a", "b", "lm", "fidelity"] as const;
export type ColorPart = (typeof COLOR_PARTS)[number];

/** Whether a value is a color with every one of its numbers. */
const wholeColor = (v: unknown): v is ColorValue =>
  typeof v === "object" && v !== null && COLOR_PARTS.every((k) => typeof (v as Record<string, unknown>)[k] === "number");

/** The numbers that differ from one color to the next; null where they aren't both whole colors (it changes whole). */
export function changedParts(was: unknown, next: ParamValue): ColorPart[] | null {
  if (!wholeColor(was) || !wholeColor(next)) return null;
  return COLOR_PARTS.filter((k) => was[k] !== next[k]);
}
