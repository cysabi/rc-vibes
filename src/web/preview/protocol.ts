// What the preview panel (main.tsx) and the extension in the sketch's box
// (box/extension) say to each other, through the webview.

import type { Lights } from "../../shared/vibes.ts";

export interface LogLine {
  /** How far into the preview, in ms. */
  at: number;
  level: "log" | "warn" | "error";
  text: string;
  /** The same line, this many times in a row. */
  count: number;
}

export type ToPreview =
  | { type: "layout"; layout: Lights }
  | { type: "script"; script: string }
  | { type: "play" | "pause" | "restart" | "toggle" };

export type FromPreview =
  | { type: "ready" }
  | { type: "log"; line: LogLine }
  | { type: "state"; playing: boolean; stopped: string | null; ms: number };
