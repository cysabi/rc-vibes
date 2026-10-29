// Default sketches: vibes' own, in the library for anyone to add, under a
// section of their own. Each is a sketch like any other in the room (added,
// switched, masked, cloned, its params set, taken out), but its code is
// vibes' (src/default-sketches/<entry>.ts), built with vibes: there's none to
// open, fork, publish, update or delete, and vibes makes its one build
// itself (server/default-sketches.ts). Their ids are fixed, the same in
// every vibes.
//
//   Tone        a color for each color light, on or off for each old bulb
//               (the room's Base Tone is one: shared/base-color.ts)
//   Transition  from the light below to an end tone, eased, at a speed,
//               back and forth or over again
//   Rainbow     every hue in turn, across the room, at a speed, brightness
//               and saturation

import { BASE_COLOR } from "./base-color.ts";

export interface DefaultSketch {
  id: string;
  name: string;
  /** What it does, in a few words, for its card. */
  about: string;
  /** Its code: src/default-sketches/<entry>.ts, built to dist/default-sketches/<entry>.js. */
  entry: string;
}

export const DEFAULT_SKETCHES: readonly DefaultSketch[] = [
  { id: BASE_COLOR.sketch, name: BASE_COLOR.name, about: "A color for each light", entry: "tone" },
  { id: "b45e0c01-0000-4000-8000-000000000004", name: "Transition", about: "From the light below to an end tone, and back or again", entry: "transition" },
  { id: "b45e0c01-0000-4000-8000-000000000005", name: "Rainbow", about: "Every hue in turn, across the room", entry: "rainbow" },
];

/** A default sketch, by its id. */
export const defaultSketch = (id: string | null | undefined): DefaultSketch | undefined => DEFAULT_SKETCHES.find((s) => s.id === id);

/** Whether a sketch is one of vibes' own (nothing to open, fork, publish, update or delete). */
export const isDefaultSketch = (id: string | null | undefined): boolean => defaultSketch(id) !== undefined;
