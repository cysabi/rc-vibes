// Base Color's script (shared/base-color.ts): built from src/base-color/ with
// vibes (vite.config.ts writes it beside the web app), or, in development,
// built as vibes starts, so it's always the code as it is.

import { readFile } from "node:fs/promises";
import path from "node:path";

export const BASE_COLOR_ENTRY = path.resolve("src/base-color/main.ts");
export const BASE_COLOR_SCRIPT = path.resolve("dist/base-color.js");

/** Base Color's script: as built with vibes (in production), or built now from its code. */
export async function loadBaseColorScript(production: boolean): Promise<string> {
  if (production) return readFile(BASE_COLOR_SCRIPT, "utf8");
  const { buildSketchScript } = await import("./sketch-script.ts");
  return buildSketchScript(BASE_COLOR_ENTRY);
}
