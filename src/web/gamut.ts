// The screen's gamut: Display P3 where the screen shows it (most Macs and
// iPhones, and many recent phones), so saturated lemtones aren't cut down to
// sRGB; sRGB elsewhere, exactly as before. It follows the window from screen
// to screen.

import type { Gamut } from "../shared/lemtone.ts";

const p3 = typeof matchMedia === "function" ? matchMedia("(color-gamut: p3)") : null;
let gamut: Gamut = p3?.matches ? "display-p3" : "srgb";
p3?.addEventListener("change", (e) => (gamut = e.matches ? "display-p3" : "srgb"));

export const screenGamut = (): Gamut => gamut;
