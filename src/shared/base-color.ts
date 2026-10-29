// Tone: a color for each color light and on or off for each old bulb, as
// params, so changing it is a param change like any other: streamed to the
// shader, with no request to arclamp per change. Its code is vibes' own
// (src/default-sketches/tone.ts), built with vibes; one of vibes' default sketches (default-sketches.ts): a sketch in the library like any
// other, put in (and cloned, and taken out) like any other, except that
// there's no code of it to open, fork or delete, and its build is vibes' own.
//
// One Tone is the room's base, "Base Tone": at the bottom of every room,
// just above arclamp's room tone (the room's "normal", which only admin mode
// shows), on every light. vibes puts it in, keeps it at the bottom, and puts
// a new one in (at its defaults) whenever it's gone, however it went. The
// layers panel won't move or delete it; it can be muted, masked and changed
// like any shader.
//
// Its sketch, and the base's instance and pool, have fixed ids, the same in
// every vibes, so its stamp is the same wherever it runs and vibes finds it
// again by it.

import { color } from "../../packages/vibes/src/color.ts";
import { checkSpec, type ParamSpec } from "../../packages/vibes/src/wire.ts";

export const BASE_COLOR = {
  /** The sketch's name, and every Tone's. */
  name: "Tone",
  sketch: "b45e0c01-0000-4000-8000-000000000001",
  instance: "b45e0c01-0000-4000-8000-000000000002",
  pool: "b45e0c01-0000-4000-8000-000000000003",
} as const;

/** Its params, as its code declares them (src/default-sketches/tone.ts) and with those very options. */
export const BASE_COLOR_PARAMS = {
  /** Each color light's color: a warm white (2800K at 703 lm) until it's set. */
  color: { name: "color", default: color("2800K").at(703), options: { label: "Color" } },
  /** Each old bulb, on or off: off until it's set. */
  on: { name: "on", default: false, options: { label: "Old bulbs", lights: "switch" as const } },
};

const specOf = (raw: unknown): ParamSpec => {
  const spec = checkSpec(raw);
  if (typeof spec === "string") throw new Error(spec);
  return spec;
};

/** Its params as declared: what its code says once it runs, said ahead so its knobs are there from the start. */
export const BASE_COLOR_SPECS: ParamSpec[] = [
  specOf({ name: "color", label: "Color", lights: undefined, kind: "color", default: BASE_COLOR_PARAMS.color.default.toJSON() }),
  specOf({ name: "on", label: "Old bulbs", lights: "switch", kind: "toggle", default: BASE_COLOR_PARAMS.on.default }),
];

/** The base Tone's name, wherever it's shown. */
export const BASE_TONE_NAME = "Base Tone";

/** Whether an instance is the base Tone (by its id, or a layer's key). */
export const isBaseColor = (id: string | null | undefined) => id === BASE_COLOR.instance;

