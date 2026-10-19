// sketch(): your look as arclamp's update().
//
// A look is a function of here (your own, or a field), or one color for
// every light (a palette is laid across the room, left to right). Each tick
// sketch() asks it what every light should make now, and turns that into
// channels: lemtone channels for color lights, and on or off for old bulbs
// (on at `switchOn` lumens or more, off below `switchOff`, and left as they
// were between, so a pattern hovering near the line doesn't chatter).
//
// Anything a look gives that says a color will do: a Color, "#f80",
// "2700K", { r, g, b }, … Null, undefined or false leaves the light as it is
// below. Something that isn't a color, or a color that isn't all numbers,
// leaves it as it is too, with a warning (once for each kind of mistake), so
// one slip doesn't stop the sketch.

import { Color, color, isPalette, type ColorInput, type Palette } from "./color.ts";
import type { Out, Prev, Update } from "./arclamp.ts";
import { colorOf, Here, roomOf, sameLayout, type Room } from "./here.ts";

// Plain V8 (arclamp's sandbox) has only what arclamp's prelude gives it.
declare const console: { warn(...data: unknown[]): void };

/** What a light should make, here and now; null, undefined or false leaves it as it is below. */
export type LookResult = ColorInput | null | undefined | false | void;

/**
 * What a light should make, here and now: a function of here giving a color,
 * one color for every light, or a palette, laid across the room.
 */
export type Look = ((here: Here) => LookResult) | ColorInput | Palette;

export interface SketchOptions {
  /** Old bulbs switch on when asked for this many lumens or more (default 100: about halfway, to the eye, to one that's on). */
  switchOn?: number;
  /** And off when asked for fewer than this (default 70). */
  switchOff?: number;
}

// A tick after a long gap (the sketch paused, or held up) counts as at most this long.
const MAX_DT = 0.25;

/** Your look (a function of here, or a field) as arclamp's update(). */
export function sketch(look: (here: Here) => LookResult, options?: SketchOptions): Update;
/** One color for every light, or a palette laid across the room, as arclamp's update(). */
export function sketch(look: ColorInput | Palette, options?: SketchOptions): Update;
export function sketch(look: Look, options: SketchOptions = {}): Update {
  const ask = lookOf(look);
  const switchOn = options.switchOn ?? 100;
  const switchOff = Math.min(options.switchOff ?? 70, switchOn);
  let room: Room | null = null;
  let last: number | null = null;
  const on = new Map<number, boolean>();
  const warned = new Set<string>();

  const warn = (kind: string, text: string) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.warn(`${text} (warning once)`);
  };

  return (prev: Prev, nowMs: number, initialMs: number): Out => {
    const list = Array.isArray(prev?.lights) ? prev.lights : [];
    if (!room || !sameLayout(prev, room)) room = roomOf(prev, room);
    const t = (nowMs - initialMs) / 1000;
    const dt = last === null ? 0 : Math.min(MAX_DT, Math.max(0, (nowMs - last) / 1000));
    last = nowMs;

    const lights: Out["lights"] = [];
    for (let i = 0; i < list.length; i++) {
      const light = room.lights[i]!;
      light.below = colorOf(list[i]!, light.kind);
      const v = ask(new Here(light.x, light.y, t, dt, nowMs, light, room));
      if (v === null || v === undefined || v === false) continue;

      let c: Color;
      try {
        c = v instanceof Color ? v : color(v as ColorInput);
      } catch (err) {
        if (typeof v === "number") {
          warn("number", `light ${light.id} was given ${v}, and a number is read as a color temperature in kelvin; for a pattern from 0 to 1, color it first, like osc(3).color(palettes.dusk)`);
        } else {
          warn("unreadable", `light ${light.id} was given something that isn't a color, so it's left as it is: ${(err as Error).message}`);
        }
        continue;
      }

      if (light.kind === "switch") {
        if (!Number.isFinite(c.lm)) {
          warn("nan", `light ${light.id} was given a color that isn't all numbers, ${JSON.stringify(c)}, so it's left as it is`);
          continue;
        }
        const was = on.get(light.id) ?? c.lm >= switchOn;
        const now = c.lm >= switchOn ? true : c.lm < switchOff ? false : was;
        on.set(light.id, now);
        lights.push({ id: light.id, channels: { on: now ? 1 : 0 } });
        continue;
      }

      const channels = c.channels;
      if (!Number.isFinite(channels.a) || !Number.isFinite(channels.b) || !Number.isFinite(channels.brightness) || !Number.isFinite(channels.fidelity)) {
        warn("nan", `light ${light.id} was given a color that isn't all numbers, ${JSON.stringify(c)}, so it's left as it is`);
        continue;
      }
      lights.push({ id: light.id, channels });
    }
    return { lights };
  };
}

/** The look as a function of here. One color is the same everywhere (and said wrong, an error now, not each tick). */
function lookOf(look: Look): (here: Here) => unknown {
  if (isPalette(look)) return (here) => look(here.u);
  if (typeof look === "function") return look as (here: Here) => unknown;
  const c = color(look);
  return () => c;
}
