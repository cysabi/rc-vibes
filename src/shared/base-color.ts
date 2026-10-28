// Base Color: the shader at the bottom of every room, just above arclamp's
// room tone (the room's "normal", which only admin mode shows). It's a color
// for each color light and on or off for each old bulb, as params, so
// changing it is a param change like any other: streamed to the shader, with
// no request to arclamp per change. Its code is vibes' own (src/base-color/),
// built with vibes; vibes puts it in, and puts it back whenever it's gone,
// however it went. Nobody can remove it, edit its code, move it or change its
// home; it can be muted, masked and changed like any shader.
//
// Its sketch, instance and pool have fixed ids, the same in every vibes, so
// its stamp is the same wherever it runs and vibes finds it again by it.

import { color } from "../../packages/vibes/src/color.ts";
import { checkSpec, type ParamSpec } from "../../packages/vibes/src/wire.ts";

export const BASE_COLOR = {
  name: "Base Color",
  sketch: "b45e0c01-0000-4000-8000-000000000001",
  instance: "b45e0c01-0000-4000-8000-000000000002",
  pool: "b45e0c01-0000-4000-8000-000000000003",
} as const;

/** Its params, as its code declares them (src/base-color/main.ts) and with those very options. */
export const BASE_COLOR_PARAMS = {
  /** Each color light's color: a warm white until it's set. */
  color: { name: "color", default: color("2700K").at(400), options: { label: "Color" } },
  /** Each old bulb, on or off. */
  on: { name: "on", default: true, options: { label: "Old bulbs", lights: "switch" as const } },
};

const specOf = (raw: unknown): ParamSpec => {
  const spec = checkSpec(raw);
  if (typeof spec === "string") throw new Error(spec);
  return spec;
};

/** Its params as declared: what its code says once it runs, said ahead so its knobs are there from the start. */
export const BASE_COLOR_SPECS: ParamSpec[] = [
  specOf({ name: "color", label: "Color", lights: undefined, kind: "color", default: BASE_COLOR_PARAMS.color.default.toJSON() }),
  specOf({ name: "on", label: "Old bulbs", lights: "switch", kind: "toggle", default: true }),
];

/** Whether an instance (or its sketch) is Base Color. */
export const isBaseColor = (id: string | null | undefined) => id === BASE_COLOR.instance || id === BASE_COLOR.sketch;
