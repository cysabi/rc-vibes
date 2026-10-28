// @roobscoob/vibes: color, light and time for sketches on the lights at the
// Recurse Center. See README.md.

export type { Coords, Out, Prev, PrevLight, Update } from "./arclamp.ts";
export {
  br30,
  Color,
  color,
  hex,
  hsl,
  isPalette,
  lemtone,
  off,
  oklab,
  oklch,
  palette,
  palettes,
  rgb,
  toPalette,
  white,
  xy,
  type Bulb,
  type ColorChanges,
  type ColorInput,
  type ColorLike,
  type Palette,
  type Stop,
} from "./color.ts";
export { Here, Light, Room, type Rail, type RailSpot } from "./here.ts";
export {
  delay,
  field,
  gradient,
  isField,
  kaleid,
  move,
  noise,
  osc,
  rings,
  rotate,
  scale,
  solid,
  speed,
  voronoi,
  warp,
  type ColorParam,
  type Field,
  type Param,
} from "./field.ts";
export { clock, type Clock, type Every } from "./signal.ts";
export { param, type ParamOptions, type VibesHost } from "./param.ts";
export { show, type Show } from "./show.ts";
export type { ColorValue, LightFilter, ParamSpec, ParamValue, ShowClock } from "./wire.ts";
export { RESTING_BPM } from "./wire.ts";
export { chance, clamp, decay, ease, fract, hash, lerp, noiseAt, remap, saw, smoothstep, square, tri, wave } from "./shape.ts";
export { sketch, type Look, type LookResult, type Looks, type SketchOptions, type SwitchLook, type SwitchResult } from "./sketch.ts";
