// A sketch to work on the preview with (http://localhost:5173/preview/,
// see src/web/preview/dev.tsx): bands rolling across the room, with knobs.
// Edit and save it, and the page swaps the new build in. The library is the
// workspace's own, not npm's.
import { osc, palettes, param, sketch, white } from "../../packages/vibes/src/index.ts";

const speed = param("speed", 0.05, { min: 0, max: 0.5, step: 0.01, label: "Speed" });
const bands = param("bands", 3, { min: 1, max: 8, step: 1, label: "Bands", perLight: false });
const lm = param("lm", 300, { min: 0, max: 800, step: 10, label: "Brightness" });
const blink = param("blink", 0.5, { min: 0, max: 1, step: 0.05, label: "Old bulbs on above" });

const pattern = osc(bands, speed);

export const update = sketch({
  color: (here) => (here.light.rail ? palettes.dusk(pattern(here)).at(lm(here)) : white(2700, lm(here) * pattern(here))),
  switch: (here) => pattern(here) > blink(here),
});
