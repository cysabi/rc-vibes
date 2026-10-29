// Tone's code (src/shared/base-color.ts, one of vibes' default sketches:
// shared/default-sketches.ts): each color light its color, each old bulb on or
// off, both params. Built with vibes (vite.config.ts's defaultSketchScripts)
// as the builder builds a sketch: one script, its update() made global. The
// library is the workspace's own.
import { param, sketch } from "../../packages/vibes/src/index.ts";
import { BASE_COLOR_PARAMS } from "../shared/base-color.ts";

const { color: c, on: o } = BASE_COLOR_PARAMS;
const color = param(c.name, c.default, c.options);
const on = param(o.name, o.default, o.options);

export const update = sketch({ color, switch: on });
