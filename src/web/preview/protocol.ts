// What the preview panel (main.tsx) and the extension in the sketch's box
// (box/extension) say to each other, through the webview.
//
// The sketch reaches the preview one of two ways (src/shared/sketch-plan.ts
// says which): as its modules, from the box's Vite, updated in place by
// Vite's HMR (its messages relayed both ways as "hmr"); or as a whole script,
// each new build swapped in for the last. Either way the clock carries on.
//
// Its params are a pool of its own on vibes (one each time the extension
// starts), which the extension follows as the room's shaders follow theirs
// (src/server/params.ts): the preview says what the sketch declares, and each
// knob turned here ("declared", "set"); the extension hands it the pool's
// values as they are on vibes ("pool": all of them, then each change).

import type { Changes, ParamSpec, ParamTable, ParamValue } from "../../shared/params.ts";
import type { Lights } from "../../shared/vibes.ts";

export interface LogLine {
  /** How far into the preview, in ms. */
  at: number;
  level: "log" | "warn" | "error";
  text: string;
  /** The same line, this many times in a row. */
  count: number;
}

/**
 * What the preview runs. Modules come from one Vite server, which only sends
 * updates for the modules it served: `server` says which, and the preview
 * loads them afresh from a new one.
 */
export type SketchSource = { kind: "script"; script: string } | { kind: "modules"; entry: string; server: number };

export type ToPreview =
  | { type: "layout"; layout: Lights }
  | { type: "source"; source: SketchSource }
  | { type: "hmr"; payload: unknown }
  | { type: "play" | "pause" | "restart" | "toggle" }
  /** Its pool's values on vibes: all of them (as it's followed again), or a change. */
  | { type: "pool"; event: "state"; values: ParamTable }
  | { type: "pool"; event: "change"; name: string; set: Changes };

export type FromPreview =
  | { type: "ready" }
  | { type: "log"; line: LogLine }
  | { type: "hmr"; payload: unknown }
  | { type: "state"; playing: boolean; stopped: string | null; ms: number }
  /** What the sketch declares, as of its last load or update. */
  | { type: "declared"; specs: ParamSpec[] }
  /** A knob turned here: some lights' values (null back to the default). */
  | { type: "set"; name: string; changes: [number, ParamValue | null][] };
