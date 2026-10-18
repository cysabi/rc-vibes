import { describe, expect, it } from "vitest";
import {
  between,
  fitView,
  flickOf,
  formatLength,
  gridFor,
  looksLikeTrackpad,
  motionAt,
  pinchView,
  rubberBand,
  scaleBar,
  toPlan,
  zoomAt,
} from "./viewport.ts";

describe("viewport", () => {
  it("fits bounds inside the padded space, centered", () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 10_000, maxY: 5_000 }, 1100, 700, 50);
    expect(v.scale).toBeCloseTo(0.1);
    expect(toPlan(v, 550, 350)).toEqual({ x: 5000, y: 2500 });
  });

  it("fits between uneven insets, centered in the space they leave", () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 10_000, maxY: 5_000 }, 1400, 700, { top: 50, right: 350, bottom: 50, left: 50 });
    expect(v.scale).toBeCloseTo(0.1);
    // The free space runs from x 50 to 1050, so its middle is 550.
    expect(toPlan(v, 550, 350)).toEqual({ x: 5000, y: 2500 });
  });

  it("zooms around the pointer and respects the limits", () => {
    const v = { scale: 0.1, ox: 0, oy: 0 };
    const z = zoomAt(v, 300, 200, 2, 0.05, 0.8);
    expect(z.scale).toBeCloseTo(0.2);
    expect(toPlan(z, 300, 200)).toEqual(toPlan(v, 300, 200));
    expect(zoomAt(v, 0, 0, 100, 0.05, 0.8).scale).toBe(0.8);
    expect(zoomAt(v, 0, 0, 0.01, 0.05, 0.8).scale).toBe(0.05);
  });

  it("picks round scale-bar lengths that fit", () => {
    const s = scaleBar(0.05, 120); // 120 px = 2.4 m
    expect(s.metric.label).toBe("2 m");
    expect(s.metric.px).toBeCloseTo(100);
    expect(s.imperial.label).toBe("5 ft");
    expect(scaleBar(0.8, 120).metric.label).toBe("10 cm");
    expect(scaleBar(0.8, 120).imperial.label).toBe("2 in");
  });

  it("chooses grid steps that stay readable", () => {
    expect(gridFor(0.03)).toMatchObject({ minor: 500, major: 5000 });
    expect(gridFor(0.2)).toMatchObject({ minor: 100, major: 500 });
    expect(gridFor(0.03).minorAlpha).toBeGreaterThan(0);
  });
});

describe("formatLength", () => {
  it("gives meters and feet-and-inches", () => {
    expect(formatLength(6400)).toBe("6.40 m · 21′ 0″");
    expect(formatLength(850)).toBe("85 cm · 2′ 9″");
    expect(formatLength(1219.2)).toBe("1.22 m · 4′ 0″");
  });
});

describe("moving the view", () => {
  const v = { scale: 0.1, ox: 40, oy: -20 };

  it("pinches around the fingers' midpoint", () => {
    // Spread to twice as far apart without moving: the plan under them stays put.
    const z = pinchView(v, { x: 300, y: 200 }, 100, { x: 300, y: 200 }, 200, 0.01, 0.8);
    expect(z.scale).toBeCloseTo(0.2);
    expect(toPlan(z, 300, 200).x).toBeCloseTo(toPlan(v, 300, 200).x);
    // Moving the fingers drags the plan along with them.
    const p = pinchView(v, { x: 300, y: 200 }, 100, { x: 350, y: 180 }, 100, 0.01, 0.8);
    expect(toPlan(p, 350, 180).y).toBeCloseTo(toPlan(v, 300, 200).y);
  });

  it("gives way less and less past the zoom limits", () => {
    expect(rubberBand(0.5, 0.1, 0.8)).toBe(0.5);
    expect(rubberBand(6.4, 0.1, 0.8)).toBeCloseTo(1.6); // 8× too far shows as 2×
    expect(rubberBand(0.0125, 0.1, 0.8)).toBeCloseTo(0.05);
  });

  it("flies as one zoom around the point both views share", () => {
    const b = zoomAt(v, 500, 300, 4, 0, 10);
    const mid = between(v, b, 0.5);
    expect(mid.scale).toBeCloseTo(0.2); // halfway in zoom is the geometric mean
    expect(toPlan(mid, 500, 300).x).toBeCloseTo(toPlan(v, 500, 300).x);
    expect(between(v, b, 1)).toMatchObject({ scale: b.scale, ox: expect.closeTo(b.ox), oy: expect.closeTo(b.oy) });
    // Without a zoom it's a pan.
    expect(between(v, { ...v, ox: 140 }, 0.25).ox).toBeCloseTo(65);
  });

  it("glides after a flick and comes to rest", () => {
    const glide = { kind: "glide" as const, from: v, vx: 1, vy: 0, start: 0 };
    expect(motionAt(glide, 0).view.ox).toBe(40);
    const later = motionAt(glide, 5000);
    expect(later.done).toBe(true);
    expect(later.view.ox).toBeCloseTo(40 + 325, 0); // speed × 325 ms
    const fly = { kind: "fly" as const, from: v, to: { ...v, ox: 140 }, start: 100, ms: 200 };
    expect(motionAt(fly, 150).done).toBe(false);
    expect(motionAt(fly, 300)).toEqual({ view: { ...v, ox: 140 }, done: true });
  });

  it("reads a flick from the last moments of a pan", () => {
    const trail = [0, 20, 40, 60, 80, 100, 120].map((t) => ({ t, x: t * 2, y: 0 }));
    expect(flickOf(trail, 125)).toEqual({ vx: 2, vy: 0 });
    // Held still before letting go, or barely moving: no glide.
    expect(flickOf(trail, 300)).toBeNull();
    expect(flickOf([{ t: 0, x: 0, y: 0 }, { t: 100, x: 5, y: 0 }], 100)).toBeNull();
  });

  it("tells a trackpad's scroll from a mouse wheel's", () => {
    const wheel = { deltaMode: 0, deltaX: 0, deltaY: 100, shiftKey: false };
    expect(looksLikeTrackpad({ ...wheel, wheelDeltaY: -120 })).toBe(false);
    expect(looksLikeTrackpad({ ...wheel, deltaY: 4, wheelDeltaY: -12 })).toBe(true);
    expect(looksLikeTrackpad({ ...wheel, deltaX: 3 })).toBe(true);
    expect(looksLikeTrackpad({ ...wheel, deltaMode: 1, deltaY: 3 })).toBe(false);
  });
});
