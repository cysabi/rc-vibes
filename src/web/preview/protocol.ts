// What the preview panel (main.tsx) and the extension in the sketch's box
// (box/extension) say to each other, through the webview.
//
// The sketch reaches the preview one of two ways (src/shared/sketch-plan.ts
// says which): as its modules, from the box's Vite, updated in place by
// Vite's HMR (its messages relayed both ways as "hmr"); or as a whole script,
// each new build swapped in for the last. Either way the clock carries on.

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
  | { type: "play" | "pause" | "restart" | "toggle" };

export type FromPreview =
  | { type: "ready" }
  | { type: "log"; line: LogLine }
  | { type: "hmr"; payload: unknown }
  | { type: "state"; playing: boolean; stopped: string | null; ms: number };
