// A sketch to work on the preview with (http://localhost:5173/preview/,
// see src/web/preview/dev.tsx): bands rolling across the room, with knobs of
// each kind. Edit and save it, and the page swaps the new build in. The
// library is the workspace's own, not npm's.
import { osc, palettes, param, sketch } from "../../packages/vibes/src/index.ts";

const speed = param("speed", 0.05, { min: 0, max: 0.5, step: 0.01, label: "Speed" });
const bands = param("bands", 3, { min: 1, max: 8, step: 1, label: "Bands" });
const tint = param("tint", "2700K", { label: "Tint" });
const lm = param("lm", 300, { min: 0, max: 800, step: 10, label: "Brightness", lights: "color" });
const blink = param("blink", true, { label: "Old bulbs blink", lights: "switch" });

const pattern = osc(bands, speed);

export const update = sketch({
  color: (here) => (here.light.rail ? palettes.dusk(pattern(here)).at(lm(here)) : tint(here).at(lm(here) * pattern(here))),
  switch: (here) => (blink(here) ? pattern(here) > 0.5 : true),
});
