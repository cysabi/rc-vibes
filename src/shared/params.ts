// Params: what a sketch declares for vibes to change while it runs, light by
// light (a number, a color, or a toggle, for the lights its filter lets
// through), and each instance's values. The sketch says what it declares
// itself, as it runs in the room (src/server/params.ts has the stream); the
// rules for both ends are the library's (packages/vibes/src/wire.ts), so
// vibes and sketches agree on every one.

import type { LightInfo } from "./arclamp.ts";
import { isBinary } from "./fixtures.ts";
import { LUMENS_PER_BRIGHTNESS, type Lemtone } from "./lemtone.ts";
import { passes, valuesOf, type ColorValue, type Groups, type LightFacts, type LightKind, type ParamSpec, type ParamTable, type ParamValue } from "../../packages/vibes/src/wire.ts";

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

/** A shader's params, as the feed has them: what its sketch said it declares (null until it has), and its values. */
export interface ShaderParams {
  declared: ParamSpec[] | null;
  values: ParamTable;
}

/** What kind of light it is, as sketches see it (light.kind): old bulbs switch, the rest take colors. */
export const kindOf = (light: Pick<LightInfo, "type">): LightKind => (isBinary(light.type) ? "switch" : "color");

/** A light, as a param's filter sees it. */
export const factsOf = (light: Pick<LightInfo, "id" | "type" | "tags">): LightFacts => ({ id: light.id, kind: kindOf(light), tags: light.tags ?? [] });

/** Whether a param is for this light. */
export const appliesTo = (spec: ParamSpec, light: Pick<LightInfo, "id" | "type" | "tags">) => passes(spec.lights, factsOf(light));

/** Each light's value, by id: its own, or the default. */
export function valuesAt(spec: ParamSpec, groups: Groups | undefined, ids: readonly number[]): ParamValue[] {
  const set = valuesOf(spec, groups);
  return ids.map((id) => set.get(id) ?? spec.default);
}

/** A number as a knob shows it: as many decimals as its step has. */
export function paramText(v: number, step: number): string {
  const decimals = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step))));
  return v.toFixed(decimals);
}

/** A color param's value as room tone's color editor has it (brightness 1.0 = 1000 lm), and back. */
export const lemtoneOf = (c: ColorValue): Lemtone => ({ a: c.a, b: c.b, brightness: c.lm / LUMENS_PER_BRIGHTNESS, fidelity: c.fidelity });
export const colorOfLemtone = (t: Lemtone): ColorValue => ({ a: t.a, b: t.b, lm: t.brightness * LUMENS_PER_BRIGHTNESS, fidelity: t.fidelity });
