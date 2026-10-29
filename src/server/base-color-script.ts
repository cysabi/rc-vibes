// A default sketch's script (shared/default-sketches.ts): built from
// src/default-sketches/<entry>.ts with vibes (vite.config.ts writes each
// beside the web app), or, in development, built as vibes starts, so it's
// always the code as it is.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DefaultSketch } from "../shared/default-sketches.ts";

/** Where a default sketch's code is. */
export const defaultSketchEntry = (s: Pick<DefaultSketch, "entry">) => path.resolve("src/default-sketches", `${s.entry}.ts`);
/** Where it's written, built with vibes. */
export const defaultSketchScript = (s: Pick<DefaultSketch, "entry">) => path.resolve("dist/default-sketches", `${s.entry}.js`);

/** A default sketch's script: as built with vibes (in production), or built now from its code. */
export async function loadDefaultSketchScript(s: DefaultSketch, production: boolean): Promise<string> {
  if (production) return readFile(defaultSketchScript(s), "utf8");
  const { buildSketchScript } = await import("./sketch-script.ts");
  return buildSketchScript(defaultSketchEntry(s));
}
