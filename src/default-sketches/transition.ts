// Transition (shared/default-sketches.ts): each color light goes from the
// light below it (whatever the layers under it make) to an end tone, and
// then either back again (reverse) or from the start again (loop). Its params,
// each light's own:
//
//   End tone  where it goes to
//   Easing    0, at a steady pace; 1, slow at each end and quick between
//   Speed     transitions a second (0.1: one every ten seconds)
//   Reverse   on, back and forth; off, over and over from the start
//
// Each light keeps how far along it is, so a change of speed carries on from
// where it is rather than jumping. Old bulbs are left as they are. Built with
// vibes as Tone is (vite.config.ts's defaultSketchScripts).
import { color, ease, fract, lerp, param, sketch, type Here } from "../../packages/vibes/src/index.ts";

const end = param("end", color("2000K").at(250), { label: "End tone" });
const easing = param("easing", 0.5, { min: 0, max: 1, step: 0.05, label: "Easing", lights: "color" });
const speed = param("speed", 0.1, { min: 0.01, max: 1, step: 0.01, label: "Speed", lights: "color" });
const reverse = param("reverse", true, { label: "Reverse", lights: "color" });

/** How far along this light is, from its start to the end tone: 0 to 1. */
function along(here: Here): number {
  const s = here.light.state as { phase?: number };
  // Transitions done so far: a back-and-forth is two.
  s.phase = (s.phase ?? 0) + here.dt * Math.max(0, speed(here));
  const p = s.phase;
  return reverse(here) ? 1 - Math.abs(1 - (p % 2)) : fract(p);
}

export const update = sketch((here) => {
  const t = along(here);
  const k = lerp(t, ease.inOut(t), Math.min(1, Math.max(0, easing(here))));
  return here.light.below.mix(end(here), k);
});
