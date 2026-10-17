import { describe, expect, it } from "vitest";
import { fitView, formatLength, gridFor, scaleBar, toPlan, zoomAt } from "./viewport.ts";

describe("viewport", () => {
  it("fits bounds inside the padded space, centered", () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 10_000, maxY: 5_000 }, 1100, 700, 50);
    expect(v.scale).toBeCloseTo(0.1);
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
