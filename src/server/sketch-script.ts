// A sketch's one script, built as the builder builds a sketch (sketch-plan.ts):
// Vite's iife of its entry, its update() made global. For the scripts vibes
// builds itself: the base Tone's (base-color.ts), and the preview page's
// (vite.config.ts). Vite is only there to build with, so it's loaded only
// when one's built.

import path from "node:path";
import { UPDATE_FOOTER } from "../shared/sketch-plan.ts";

export async function buildSketchScript(entry: string): Promise<string> {
  const { build } = await import("vite");
  const out = await build({
    configFile: false,
    root: path.dirname(entry),
    logLevel: "warn",
    build: { write: false, minify: false, target: "es2022", lib: { entry, formats: ["iife"], name: "__sketch", fileName: () => "sketch.js" }, rolldownOptions: { output: { footer: UPDATE_FOOTER } } },
  });
  const chunk = (Array.isArray(out) ? out : [out]).flatMap((o) => (o as { output: { type: string; code?: string }[] }).output).find((o) => o.type === "chunk");
  if (!chunk?.code) throw new Error("Vite made no script");
  return chunk.code;
}
