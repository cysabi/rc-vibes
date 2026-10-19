// Fields: patterns over the room and time, made by chaining.
//
// A field is a function of `here`, so it's what a sketch's own function is
// too: field(fn) gives a function the chain methods, and any field can be
// called with a `here` to read it. Sources make numbers from 0 to 1; a
// palette (.color) makes them colors; sketch() turns a color field into
// update().
//
// Sources count across the room's width: osc(3) is three bands wall to wall,
// and the room's center is the middle of what its lights fill. Any number a
// method or source takes can instead be a function of here (a field too):
// osc(3, ({ u }) => 0.05 + 0.2 * u) goes round faster toward the right.
//
// Every transform is also a plain function on here (rotate(here, 30), ...),
// built on here.at(), so nothing needs a chain.

import { color, isPalette, toPalette, type Bulb, type Color, type ColorInput, type ColorLike, type Palette, type Stop } from "./color.ts";
import type { Here, Light } from "./here.ts";
import { clamp, hash, lerp, noiseAt, wave } from "./shape.ts";

/** A number, or a number that depends on here (a field, or any function of here). */
export type Param = number | ((here: Here) => number);

/** A color (anything that says one), or one that depends on here. */
export type ColorParam = ColorInput | ((here: Here) => ColorInput);

export interface Field<T> {
  (here: Here): T;

  /** Turned by `degrees` around the room's center (clockwise on the plan). */
  rotate(degrees: Param): Field<T>;
  /** k times as big, from the room's center. */
  scale(k: Param): Field<T>;
  /** Moved dx meters right and dy down. */
  move(dx: Param, dy?: Param): Field<T>;
  /** Folded into n mirrored slices around the room's center, like a kaleidoscope. */
  kaleid(n: Param): Field<T>;
  /** Pushed around by another field: up to `amount` meters (default 1) where it's 0 or 1, not at all where it's 0.5. */
  warp(by: (here: Here) => number, amount?: Param): Field<T>;
  /** `seconds` behind: .delay(({ u }) => 2 * u) runs two seconds later at the room's right than its left. */
  delay(seconds: Param): Field<T>;
  /** k times as fast. */
  speed(k: Param): Field<T>;

  /** Its value, changed by your own function. */
  map<U>(fn: (value: T, here: Here) => U): Field<U>;
  /** Only on the lights that pass `test`; the rest are left as they are below. */
  only(test: (light: Light) => unknown): Field<T | null>;

  /** Raised to the power k: above 1 darkens the middle, below 1 lifts it. */
  pow(this: Field<number>, k: Param): Field<number>;
  /** Cut into n flat steps from 0 to 1. */
  steps(this: Field<number>, n: Param): Field<number>;
  /** 1 at or above `level` (default 0.5), 0 below: hard edges. */
  thresh(this: Field<number>, level?: Param): Field<number>;
  /** 1 minus it. */
  invert(this: Field<number>): Field<number>;
  /** Times k. */
  mul(this: Field<number>, k: Param): Field<number>;
  /** Plus another number, or (for colors) another light, shining together. */
  add(this: Field<number>, other: Param): Field<number>;
  add(this: Field<ColorLike>, other: ColorParam): Field<Color>;
  /** Toward `other` by t (0.5 if not given), from 0 (all this) to 1 (all other). */
  mix(this: Field<number>, other: Param, t?: Param): Field<number>;
  mix(this: Field<ColorLike>, other: ColorParam, t?: Param): Field<Color>;
  /** Made a color: by a palette (0 to 1 along it), or your own function. */
  color(this: Field<number>, by: (value: number, here: Here) => ColorInput): Field<Color>;
  /** Made a color by a palette that changes: a field of palettes, like clock(96).every(16).seq([...]). */
  color(this: Field<number>, by: Field<Palette>): Field<Color>;
  /** Made a color by a palette's stops ([dark, "#f80", "white"]), or by one color, from dark at 0 to it at 1. */
  color(this: Field<number>, by: readonly Stop[] | ColorLike): Field<Color>;

  /** At `lm` lumens. */
  at(this: Field<ColorLike>, lm: Param): Field<Color>;
  /** k times the light. */
  dim(this: Field<ColorLike>, k: Param): Field<Color>;
  /** Looks k times as bright. */
  fade(this: Field<ColorLike>, k: Param): Field<Color>;
  /** Brighter by `amount` (default 1, twice the light) times `by`: .boost(beat, 0.8) lifts it 80% on each beat. */
  boost(this: Field<ColorLike>, by: Param, amount?: Param): Field<Color>;
  /** The hue turned by `degrees`. */
  shiftHue(this: Field<ColorLike>, degrees: Param): Field<Color>;
  /** k times the chroma. */
  saturate(this: Field<ColorLike>, k: Param): Field<Color>;
  /** Dimmed where need be to what a bulb makes (a color bulb, br30, unless told), so its colors aren't paled. */
  vivid(this: Field<ColorLike>, bulb?: Bulb): Field<Color>;
}

// ---- making fields ------------------------------------------------------------

/** Reads a number or color that may depend on here. */
const read = <T>(p: T | ((here: Here) => T), here: Here): T =>
  typeof p === "function" ? (p as (here: Here) => T)(here) : p;

// The chain methods, shared by every field (a field is a function whose prototype is this).
const methods = {
  rotate(this: Field<unknown>, degrees: Param) {
    return make((here) => this(rotate(here, read(degrees, here))));
  },
  scale(this: Field<unknown>, k: Param) {
    return make((here) => this(scale(here, read(k, here))));
  },
  move(this: Field<unknown>, dx: Param, dy: Param = 0) {
    return make((here) => this(move(here, read(dx, here), read(dy, here))));
  },
  kaleid(this: Field<unknown>, n: Param) {
    return make((here) => this(kaleid(here, read(n, here))));
  },
  warp(this: Field<unknown>, by: (here: Here) => number, amount: Param = 1) {
    return make((here) => this(warp(here, by, read(amount, here))));
  },
  delay(this: Field<unknown>, seconds: Param) {
    return make((here) => this(delay(here, read(seconds, here))));
  },
  speed(this: Field<unknown>, k: Param) {
    return make((here) => this(speed(here, read(k, here))));
  },
  map(this: Field<unknown>, fn: (value: unknown, here: Here) => unknown) {
    return make((here) => fn(this(here), here));
  },
  only(this: Field<unknown>, test: (light: Light) => unknown) {
    return make((here) => (test(here.light) ? this(here) : null));
  },
  pow(this: Field<number>, k: Param) {
    return make((here) => Math.max(0, this(here)) ** read(k, here));
  },
  steps(this: Field<number>, n: Param) {
    return make((here) => {
      const count = Math.max(2, Math.round(read(n, here)));
      return Math.min(count - 1, Math.floor(clamp(this(here)) * count)) / (count - 1);
    });
  },
  thresh(this: Field<number>, level: Param = 0.5) {
    return make((here) => (this(here) >= read(level, here) ? 1 : 0));
  },
  invert(this: Field<number>) {
    return make((here) => 1 - this(here));
  },
  mul(this: Field<number>, k: Param) {
    return make((here) => this(here) * read(k, here));
  },
  add(this: Field<number | ColorLike>, other: Param | ColorParam) {
    return make((here) => {
      const v = this(here);
      return typeof v === "number" ? v + read(other as Param, here) : color(v).add(read(other as ColorParam, here));
    });
  },
  mix(this: Field<number | ColorLike>, other: Param | ColorParam, t: Param = 0.5) {
    return make((here) => {
      const v = this(here);
      const k = read(t, here);
      return typeof v === "number" ? lerp(v, read(other as Param, here), k) : color(v).mix(read(other as ColorParam, here), k);
    });
  },
  color(this: Field<number>, by: unknown) {
    if (isField(by)) return make((here) => toPalette(by(here))(this(here)));
    if (isPalette(by)) return make((here) => by(this(here)));
    if (typeof by === "function") return make((here) => color((by as (value: number, here: Here) => ColorInput)(this(here), here)));
    const p = toPalette(by);
    return make((here) => p(this(here)));
  },
  at(this: Field<ColorLike>, lm: Param) {
    return make((here) => color(this(here)).at(read(lm, here)));
  },
  dim(this: Field<ColorLike>, k: Param) {
    return make((here) => color(this(here)).dim(read(k, here)));
  },
  fade(this: Field<ColorLike>, k: Param) {
    return make((here) => color(this(here)).fade(read(k, here)));
  },
  boost(this: Field<ColorLike>, by: Param, amount: Param = 1) {
    return make((here) => color(this(here)).dim(1 + read(amount, here) * read(by, here)));
  },
  shiftHue(this: Field<ColorLike>, degrees: Param) {
    return make((here) => color(this(here)).shiftHue(read(degrees, here)));
  },
  saturate(this: Field<ColorLike>, k: Param) {
    return make((here) => color(this(here)).saturate(read(k, here)));
  },
  vivid(this: Field<ColorLike>, bulb?: Bulb) {
    return make((here) => color(this(here)).vivid(bulb));
  },
};

const proto: object = Object.setPrototypeOf(methods, Function.prototype);

function make<T>(fn: (here: Here) => T): Field<T> {
  return Object.setPrototypeOf(fn, proto) as Field<T>;
}

/** Your own function of here as a field, to chain onto. */
export function field<T>(fn: (here: Here) => T): Field<T> {
  return isField(fn) ? (fn as Field<T>) : make((here) => fn(here));
}

/** Whether v is a field (made by a source, field(), or a chain). */
export const isField = (v: unknown): v is Field<unknown> => typeof v === "function" && Object.getPrototypeOf(v) === proto;

// ---- sources --------------------------------------------------------------------

/** Here as room units: centered on the room, 1 = its width, the same scale both ways. */
function unit(here: Here): [number, number] {
  const { center, width } = here.room;
  return [(here.x - center.x) / width, (here.y - center.y) / width];
}

/** Smooth bands, `n` across the room (left to right), each light going round `speed` times a second. */
export function osc(n: Param = 3, speed: Param = 0.1, phase: Param = 0): Field<number> {
  return make((here) => wave(unit(here)[0] * read(n, here) - here.t * read(speed, here) + read(phase, here)));
}

/** Smooth noise, blobs about `n` across the room, changing about `speed` times a second. */
export function noise(n: Param = 3, speed: Param = 0.1): Field<number> {
  return make((here) => {
    const [s, w] = unit(here);
    const k = read(n, here);
    return noiseAt(s * k + 7.31, w * k + 3.17, here.t * read(speed, here));
  });
}

/** Rings out from the room's center, `n` of them out to its left and right ends, moving out `speed` times a second. */
export function rings(n: Param = 3, speed: Param = 0.1): Field<number> {
  return make((here) => {
    const [s, w] = unit(here);
    return wave(2 * Math.hypot(s, w) * read(n, here) - here.t * read(speed, here));
  });
}

/** 0 to 1 across the room: left to right at 0°, top to bottom at 90°. */
export function gradient(degrees: Param = 0): Field<number> {
  return make((here) => {
    const r = (read(degrees, here) * Math.PI) / 180;
    const dx = Math.cos(r);
    const dy = Math.sin(r);
    const { center, width, depth } = here.room;
    const reach = (width * Math.abs(dx) + depth * Math.abs(dy)) / 2;
    return clamp(0.5 + ((here.x - center.x) * dx + (here.y - center.y) * dy) / (2 * reach));
  });
}

/** Cells, about `n` across the room, their centers drifting `speed` times a second: 0 at a cell's center, rising toward its edges. */
export function voronoi(n: Param = 4, speed: Param = 0.1): Field<number> {
  return make((here) => {
    const [s, w] = unit(here);
    const k = read(n, here);
    const x = s * k;
    const y = w * k;
    const phase = here.t * read(speed, here) * 2 * Math.PI;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cx = ix + dx;
        const cy = iy + dy;
        const px = cx + 0.5 + 0.35 * Math.sin(phase + 2 * Math.PI * hash(cx, cy, 1));
        const py = cy + 0.5 + 0.35 * Math.cos(phase + 2 * Math.PI * hash(cx, cy, 2));
        best = Math.min(best, Math.hypot(x - px, y - py));
      }
    }
    return clamp(best);
  });
}

/** The same value everywhere: solid(0.5), or a color, solid(white(2700, 300)). */
export function solid<T>(value: T): Field<T> {
  return make(() => value);
}

// ---- transforms, as plain functions -----------------------------------------------

/** Here, looking as if the pattern were turned by `degrees` around the room's center. */
export function rotate(here: Here, degrees: number): Here {
  const { center } = here.room;
  const r = (-degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = here.x - center.x;
  const dy = here.y - center.y;
  return here.at({ x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c });
}

/** Here, looking as if the pattern were k times as big, from the room's center. */
export function scale(here: Here, k: number): Here {
  const { center } = here.room;
  if (k === 0) return here.at({ x: center.x, y: center.y });
  return here.at({ x: center.x + (here.x - center.x) / k, y: center.y + (here.y - center.y) / k });
}

/** Here, looking as if the pattern were moved dx meters right and dy down. */
export function move(here: Here, dx: number, dy = 0): Here {
  return here.at({ x: here.x - dx, y: here.y - dy });
}

/** Here, folded into n mirrored slices around the room's center. */
export function kaleid(here: Here, n: number): Here {
  if (!(n >= 1)) return here;
  const { center } = here.room;
  const dx = here.x - center.x;
  const dy = here.y - center.y;
  const slice = (2 * Math.PI) / n;
  let a = Math.atan2(dy, dx);
  a = ((a % slice) + slice) % slice;
  a = Math.abs(a - slice / 2);
  const r = Math.hypot(dx, dy);
  return here.at({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
}

/** Here, pushed up to `amount` meters each way by `by` (none where it's 0.5). */
export function warp(here: Here, by: (here: Here) => number, amount = 1): Here {
  const ox = (by(here) - 0.5) * 2 * amount;
  // The push down comes from somewhere else in `by`, so it isn't the same as the push right.
  const oy = (by(here.at({ x: here.x + 37.7, y: here.y - 19.1 })) - 0.5) * 2 * amount;
  return here.at({ x: here.x + ox, y: here.y + oy });
}

/** Here, `seconds` earlier. */
export const delay = (here: Here, seconds: number): Here => here.at({ t: here.t - seconds });

/** Here, with time going k times as fast. */
export const speed = (here: Here, k: number): Here => here.at({ t: here.t * k });
