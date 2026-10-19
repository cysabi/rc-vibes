// What update() is given, and gives back: arclamp's shader contract
// (rclamp backend/internal/state ToJSObject). update(prev, nowMs, initialMs)
// runs about a hundred times a second, with every light as the layers below
// left it, and says what each should be making now.
//
// initialMs is the frame's time: when the room tone made it (the tick's
// wall-clock time), the same for every layer, so layers stay in step. It's
// the one to animate by. nowMs is this layer's own clock as it runs, a few
// tens of milliseconds later; it is not when the shader started.

/** Where a light is: millimeters on its floor's plan, from the building's top-left wall corner. */
export interface Coords {
  mm_x: number;
  mm_y: number;
  floor: number;
}

/** A light as update() is given it. */
export interface PrevLight {
  id: number;
  /** A color bulb's or panel's a, b, brightness (1.0 = 1000 lm) and fidelity, or an old bulb's on. */
  channels: Record<string, number>;
  tags?: string[] | null;
  /** Null until the light has been placed. */
  coords?: Coords | null;
  /** The rail it hangs on, and how far along it from the rail's start. */
  rail?: { id: string; mm_along: number } | null;
}

export interface Prev {
  initial_time: number;
  lights: PrevLight[];
}

/** The lights to change, and their channels; anything left out keeps its value from below. */
export interface Out {
  lights: { id: number; channels: Record<string, number> }[];
}

/** arclamp's shader entry point: initialMs is the frame's time (animate by it), nowMs this layer's own clock. */
export type Update = (prev: Prev, nowMs: number, initialMs: number) => Out;
