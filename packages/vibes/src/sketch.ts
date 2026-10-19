// sketch(): your looks as arclamp's update().
//
// Color lights and old bulbs are controlled apart, each by a look of its own,
// named for the kind of light it's for (light.kind):
//
//   sketch({ color: osc(3).color(palettes.dusk), switch: osc(1, 0.25).thresh() })
//
// The color look is asked about the color bulbs and panels only: a function
// of here (your own, or a field) giving a color, one color for every light,
// or a palette laid across the room. Anything that says a color will do (a
// Color, "#f80", "2700K", { r, g, b }, …). sketch(look) is
// sketch({ color: look }).
//
// The switch look is asked about the old bulbs only, which just switch: true or
// false, a number (on at 0.5 or more, as arclamp's own `on` channel), "on" or
// "off", or a function of here (a field too) giving one. Without one, the old
// bulbs are left as they are; a color never switches them.
//
// Null or undefined from either leaves the light as it is below (so does
// false from a color look). Something that can't be read leaves it as it is
// too, with a warning (once for each kind of mistake), so one slip doesn't
// stop the sketch.

import { Color, color, isPalette, type ColorInput } from "./color.ts";
import type { Out, Prev, Update } from "./arclamp.ts";
import { colorOf, Here, roomOf, sameLayout, type Room } from "./here.ts";

// Plain V8 (arclamp's sandbox) has only what arclamp's prelude gives it.
declare const console: { warn(...data: unknown[]): void };

/** What a color light should make, here and now; null, undefined or false leaves it as it is below. */
export type LookResult = ColorInput | null | undefined | false | void;

/** The color lights' look: a function of here giving a color, one color for every light, or a palette, laid across the room. */
export type Look = ((here: Here) => LookResult) | ColorInput;

/** Whether an old bulb should be on: true or false, a number (on at 0.5 or more), "on" or "off"; null or undefined leaves it as it is. */
export type SwitchResult = boolean | number | string | null | undefined | void;

/** The old bulbs' look: a function of here (a field too) saying whether each is on, or one answer for them all. */
export type SwitchLook = ((here: Here) => SwitchResult) | boolean | number | string;

/** A look for each kind of light (light.kind); either may be left out, and its lights are left as they are. */
export interface Looks {
  /** For the color bulbs and panels. */
  color?: Look;
  /** For the old bulbs, which only switch. */
  switch?: SwitchLook;
}

export interface SketchOptions {
  /** The old bulbs' look, beside a color look given on its own. */
  switch?: SwitchLook;
}

// A tick after a long gap (the sketch paused, or held up) counts as at most this long.
const MAX_DT = 0.25;

// Time is the frame's: arclamp's initialMs is when the room tone made this
// frame (the tick's wall-clock time), the same for every layer of it, so
// layers stay in step (nowMs is only this layer's own clock, a little later).
// t counts from the first frame any sketch() here saw, kept on globalThis so
// that an edit in the editor, which runs the sketch's module again in the
// same worker, carries on rather than starting over. In the room each script
// gets a fresh sandbox, so it starts over there.
const START = "__vibesStart";

function startOf(frame: number): number {
  const g = globalThis as Record<string, unknown>;
  const start = g[START];
  if (typeof start === "number" && Number.isFinite(start)) return start;
  g[START] = frame;
  return frame;
}

/** Your color look (a function of here, or a field) as arclamp's update(); old bulbs are left alone, unless given `switch`. */
export function sketch(look: (here: Here) => LookResult, options?: SketchOptions): Update;
/** A look for each kind of light: { color, switch }. */
export function sketch(looks: Looks): Update;
/** One color for every color light, or a palette laid across the room, as arclamp's update(). */
export function sketch(look: ColorInput, options?: SketchOptions): Update;
export function sketch(given: Looks | Look, options: SketchOptions = {}): Update {
  if (options && typeof options === "object" && "on" in options) throw new Error(ON_KEY);
  const looks: Looks = isLooks(given) ? { switch: options.switch, ...given } : { color: given as Look, switch: options.switch };
  const askColor = looks.color === undefined ? null : lookOf(looks.color);
  const askSwitch = looks.switch === undefined ? null : switchLookOf(looks.switch);
  let room: Room | null = null;
  let last: number | null = null;
  const warned = new Set<string>();

  const warn = (kind: string, text: string) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.warn(`${text} (warning once)`);
  };

  return (prev: Prev, nowMs: number, initialMs: number): Out => {
    const list = Array.isArray(prev?.lights) ? prev.lights : [];
    if (!room || !sameLayout(prev, room)) room = roomOf(prev, room);
    const frame = Number.isFinite(initialMs) ? initialMs : nowMs;
    const t = (frame - startOf(frame)) / 1000;
    const dt = last === null ? 0 : Math.min(MAX_DT, Math.max(0, (frame - last) / 1000));
    last = frame;

    const lights: Out["lights"] = [];
    for (let i = 0; i < list.length; i++) {
      const light = room.lights[i]!;
      light.below = colorOf(list[i]!, light.kind);
      light.belowOn = light.below.lm > 0;
      const ask = light.kind === "switch" ? askSwitch : askColor;
      if (!ask) continue;
      const v = ask(new Here(light.x, light.y, t, dt, frame, light, room));

      if (light.kind === "switch") {
        const on = readOn(v);
        if (on === "unreadable") {
          warn(
            "on",
            `light ${light.id} is an old bulb, which only switches: its look gives true or false, a number (on at 0.5 or more), or "on" or "off", not ${describe(v)}; give old bulbs a look of their own, sketch({ color, switch })`,
          );
        } else if (on !== null) lights.push({ id: light.id, channels: { on: on ? 1 : 0 } });
        continue;
      }

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

const ON_KEY = 'old bulbs\' look is `switch`, for the kind of light it\'s for: sketch({ color, switch }), or sketch(look, { switch })';

/** Whether a sketch was given a look for each kind of light ({ color, switch }) rather than one look. */
function isLooks(v: unknown): v is Looks {
  if (!v || typeof v !== "object" || v instanceof Color || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  // { on } would read as an old bulb's channels, a color: say what's meant instead.
  if (keys.includes("on")) throw new Error(ON_KEY);
  return keys.length > 0 && keys.every((k) => k === "color" || k === "switch");
}

/** The color look as a function of here. One color is the same everywhere (and said wrong, an error now, not each tick). */
function lookOf(look: Look): (here: Here) => unknown {
  if (isPalette(look)) return (here) => look(here.u);
  if (typeof look === "function") return look as (here: Here) => unknown;
  const c = color(look);
  return () => c;
}

/** The switch look as a function of here. One answer is the same everywhere (and said wrong, an error now). */
function switchLookOf(look: SwitchLook): (here: Here) => unknown {
  if (typeof look === "function") return look as (here: Here) => unknown;
  const on = readOn(look);
  if (on === "unreadable") throw new Error(`${describe(look)} isn't on or off: give true or false, a number (on at 0.5 or more), or "on" or "off"`);
  return () => on;
}

/** On (true), off (false), leave it (null), or can't tell. */
function readOn(v: unknown): boolean | null | "unreadable" {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v >= 0.5 : "unreadable";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "on" || s === "true" || s === "yes") return true;
    if (s === "off" || s === "false" || s === "no") return false;
    return s !== "" && Number.isFinite(Number(s)) ? Number(s) >= 0.5 : "unreadable";
  }
  if (typeof v === "object" && !(v instanceof Color) && "on" in v) return readOn((v as { on: unknown }).on);
  return "unreadable";
}

const describe = (v: unknown) => (v instanceof Color ? `a color (${v})` : typeof v === "string" ? `"${v}"` : JSON.stringify(v) ?? String(v));
