// Rainbow (shared/default-sketches.ts): each color light cycles through every
// hue, the room's lights a little apart from each other across the floor (a
// wave moving left to right), at a brightness and saturation of your
// choosing. Its params, each light's own:
//
//   Speed       times round the hues a minute
//   Brightness  lumens
//   Saturation  0, white; 1, as saturated as the lights make each hue
//
// Saturation is measured against what the bulbs can make of each hue (their
// edge, which is far out for blue and violet and close in for yellow), so
// every hue of the rainbow is about as vivid as the others. At high
// saturation the bulbs make only so much light of a color: past that they
// pale it (their solve keeps the lumens), so a bright, saturated rainbow
// shows some hues paler than others. Old bulbs are left as they are.
// Each light keeps where it is round the hues, so a change of speed carries
// on from there rather than jumping. Built with vibes as Tone is
// (vite.config.ts's defaultSketchScripts).
import { br30, lemtone, param, sketch, type Here } from "../../packages/vibes/src/index.ts";

const speed = param("speed", 4, { min: 0, max: 60, step: 0.5, label: "Speed", lights: "color" });
const brightness = param("brightness", 300, { min: 0, max: 1000, step: 5, label: "Brightness", lights: "color" });
const saturation = param("saturation", 0.6, { min: 0, max: 1, step: 0.01, label: "Saturation", lights: "color" });

// How far apart the lights are round the hues, across the room: once round from one side to the other.
const SPREAD = 1;
// Just inside the bulbs' edge, so a saturation of 1 is a color they make, not one past it.
const EDGE = 0.97;

/** Where this light is round the hues, in turns (0 to 1, and on). */
function turns(here: Here): number {
  const s = here.light.state as { turns?: number };
  s.turns = (s.turns ?? 0) + (here.dt * Math.max(0, speed(here))) / 60;
  return s.turns + here.u * SPREAD;
}

export const update = sketch((here) => {
  const hue = (((turns(here) % 1) + 1) % 1) * 360;
  const sat = Math.min(1, Math.max(0, saturation(here)));
  return lemtone(hue, br30.edgeOf(hue) * EDGE * sat, Math.max(0, brightness(here)));
});
