import { afterEach, describe, expect, it, vi } from "vitest";
import { chance, clamp, decay, ease, fract, hash, lerp, noiseAt, remap, saw, smoothstep, square, tri, wave } from "./shape.ts";

afterEach(() => vi.restoreAllMocks());

describe("waves", () => {
  it("go round once per unit, from 0", () => {
    expect(wave(0)).toBeCloseTo(0, 12);
    expect(wave(0.5)).toBeCloseTo(1, 12);
    expect(wave(3)).toBeCloseTo(0, 12);
    expect(saw(2.25)).toBeCloseTo(0.25, 12);
    expect(tri(0.25)).toBeCloseTo(0.5, 12);
    expect(tri(0.5)).toBeCloseTo(1, 12);
    expect(tri(-0.25)).toBeCloseTo(0.5, 12);
    expect(square(0.2)).toBe(1);
    expect(square(0.7)).toBe(0);
    expect(square(0.2, 0.1)).toBe(0);
  });
});

describe("ranges", () => {
  it("clamp, mix, remap and smooth", () => {
    expect(fract(-0.25)).toBeCloseTo(0.75, 12);
    expect(clamp(2)).toBe(1);
    expect(clamp(-1, -0.5, 3)).toBe(-0.5);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(remap(5, 0, 10, 100, 200)).toBe(150);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0, 1, -1)).toBe(0);
    for (const f of [ease.in, ease.out, ease.inOut]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
    }
    expect(ease.inOut(0.5)).toBe(0.5);
  });
});

describe("hash and noise", () => {
  it("hashes to the same number every time, spread over 0 to 1", () => {
    expect(hash(7)).toBe(hash(7));
    expect(hash(0)).toBe(hash(-0));
    expect(hash(1, 2)).not.toBe(hash(2, 1));
    expect(hash(0.1)).not.toBe(hash(0.1000001));
    const values = Array.from({ length: 2000 }, (_, i) => hash(i));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("makes smooth noise between 0 and 1", () => {
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 4000; i++) {
      const x = i * 0.0731;
      const v = noiseAt(x, x * 0.37, x * 0.11);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      // Nearby inputs, nearby values.
      expect(Math.abs(noiseAt(x + 0.001, x * 0.37, x * 0.11) - v)).toBeLessThan(0.01);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.6);
    expect(noiseAt(1.5, 2.5, 3.5)).toBe(noiseAt(1.5, 2.5, 3.5));
  });
});

describe("time steps", () => {
  it("decays by half every half-life, whatever the step", () => {
    expect(decay(2, 2)).toBeCloseTo(0.5, 12);
    expect(decay(0.01, 2) ** 400).toBeCloseTo(0.25, 9);
    expect(decay(1, 0)).toBe(0);
  });

  it("happens as often per second, whatever the step", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.05);
    // 1 - e^(-2 × 0.03) ≈ 0.058: a 5% draw happens, at 2 a second over 30 ms.
    expect(chance(2, 0.03)).toBe(true);
    expect(chance(2, 0.01)).toBe(false);
  });
});
