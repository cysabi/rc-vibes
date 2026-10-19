// Numbers to numbers: waves, easing, ranges, hashing, noise, and time steps.
// Waves count in cycles: wave(t / 8) goes round once every 8 seconds. They
// all run 0 to 1, starting at 0, so they make good brightnesses and mixes.

const TAU = 2 * Math.PI;

/** The fractional part: 2.25 → 0.25, -0.25 → 0.75. */
export const fract = (x: number) => x - Math.floor(x);

export const clamp = (x: number, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);

/** From a (at t = 0) to b (at t = 1). */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** x from the range [inLo, inHi] to [outLo, outHi], not clamped. */
export const remap = (x: number, inLo: number, inHi: number, outLo = 0, outHi = 1) =>
  outLo + ((x - inLo) / (inHi - inLo || 1)) * (outHi - outLo);

/** 0 below e0, 1 above e1, and a smooth S between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1));
  return t * t * (3 - 2 * t);
}

/** A smooth wave, one cycle per unit: 0 at whole numbers, 1 halfway between. */
export const wave = (x: number) => 0.5 - 0.5 * Math.cos(TAU * x);

/** Rises from 0 to 1 over each cycle, then drops back at once. */
export const saw = (x: number) => fract(x);

/** Rises from 0 to 1 over the first half of each cycle and falls back over the second. */
export const tri = (x: number) => 1 - Math.abs(2 * fract(x) - 1);

/** 1 for the first `duty` of each cycle, 0 for the rest: a hard on and off. */
export const square = (x: number, duty = 0.5) => (fract(x) < duty ? 1 : 0);

/** Easings, 0 to 1 onto 0 to 1 (cubic). */
export const ease = {
  in: (x: number) => clamp(x) ** 3,
  out: (x: number) => 1 - (1 - clamp(x)) ** 3,
  inOut: (x: number) => {
    const t = clamp(x);
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  },
};

// Each number's exact bits, so any number (not only whole ones) hashes.
const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);

/** A number from 0 to 1 that looks random but is always the same for the same inputs. */
export function hash(...ns: number[]): number {
  let h = 0x9e3779b9;
  for (const n of ns) {
    bits[0] = n === 0 ? 0 : n; // -0 and 0 hash the same
    h = mixBits(h ^ words[0]!);
    h = mixBits(h ^ words[1]!);
  }
  return (h >>> 0) / 4294967296;
}

function mixBits(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
}

// Whole-number lattice hashing for noise: faster than hash() and as good there.
function lattice(x: number, y: number, z: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  h = mixBits(h);
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Smooth noise from 0 to 1, in up to three dimensions: nearby inputs give
 * nearby values, and features are about 1 unit apart. noiseAt(x / 4, y / 4,
 * t / 5) makes blobs about 4 m across that change over about 5 s.
 */
export function noiseAt(x: number, y = 0, z = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);
  const c = (dx: number, dy: number, dz: number) => lattice(xi + dx, yi + dy, zi + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

/**
 * How much of something is left after dt seconds, if half goes every
 * `halfLife` seconds: value *= decay(dt, 2) halves it every 2 s, whatever the
 * tick rate.
 */
export const decay = (dt: number, halfLife: number) => (halfLife > 0 ? 0.5 ** (dt / halfLife) : 0);

/**
 * True with the chance of something that happens `perSecond` times a second
 * on average, over the last dt seconds: the same in the room (100 ticks a
 * second) as in the preview (about 30).
 */
export const chance = (perSecond: number, dt: number) => Math.random() < 1 - Math.exp(-perSecond * dt);
