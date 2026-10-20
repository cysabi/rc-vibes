import { describe, expect, it } from "vitest";
import { makesExactly } from "../shared/bulb.ts";
import { gunzip, makeCutoffs, pack, unpack, type Cutoffs, type Table } from "./cutoffs.ts";
import { wheelColor } from "./wheel.ts";
import { whitesColor } from "./whites.ts";

const gzip = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

describe("pack and unpack", () => {
  const sizes = { wheel: [5, 4], strip: [7, 3] } as const;

  it("give the tables back to 16 bits, jumps from 0 to 1 and back included", async () => {
    // Every fifth value 0 and the next 1, the biggest jumps there are; the rest anything.
    const values = (n: number, seed: number) =>
      Float32Array.from({ length: n }, (_, k) => (k % 5 === 0 ? 0 : k % 5 === 1 ? 1 : ((k * 7919 + seed) % 1000) / 1000));
    const tables: Cutoffs = {
      wheel: { width: 5, height: 4, cutoffs: values(20, 1) },
      strip: { width: 7, height: 3, cutoffs: values(21, 2) },
    };
    const back = unpack(await gunzip(await gzip(pack(tables))), sizes)!;
    for (const t of ["wheel", "strip"] as const) {
      expect([back[t].width, back[t].height]).toEqual([tables[t].width, tables[t].height]);
      expect([...back[t].cutoffs]).toEqual([...tables[t].cutoffs].map((v) => Math.fround(Math.round(v * 0xffff) / 0xffff)));
    }
  });

  it("won't unpack what isn't the tables", () => {
    expect(unpack(new Uint8Array(10), sizes)).toBeNull();
  });
});

describe("makeCutoffs", () => {
  const madeAt = (a: number, b: number, look: number) => makesExactly(a, b, look ** 3 * 1000, 0.5);
  /** How many of a table's points have a cutoff between 0 and 1, and how many are never made as asked, checking each against the solve. */
  function check(t: Table, colorAt: (x: number, y: number) => [number, number], worked: (x: number, y: number) => boolean) {
    let [between, never] = [0, 0];
    for (let j = 0; j < t.height; j++) {
      for (let i = 0; i < t.width; i++) {
        const [x, y] = [i / (t.width - 1), j / (t.height - 1)];
        if (!worked(x, y)) continue;
        const [a, b] = colorAt(x, y);
        const cut = t.cutoffs[j * t.width + i]!;
        if (cut === 0) {
          never++;
          expect(madeAt(a, b, 0.005)).toBe(false);
        } else if (cut < 1) {
          between++;
          // Made just under it; not just past where it was found to (2^-14 of the slider).
          expect(madeAt(a, b, cut - 1e-6)).toBe(true);
          expect(madeAt(a, b, cut + 1e-4)).toBe(false);
        }
      }
    }
    return { between, never };
  }

  it("puts each color's cutoff where the bulbs stop making it as asked", () => {
    const { wheel, strip } = makeCutoffs({ wheel: [15, 15], strip: [17, 7] });
    const w = check(wheel, (x, y) => wheelColor(x * 2 - 1, 1 - y * 2), (x, y) => Math.hypot(x * 2 - 1, 1 - y * 2) <= 1.08);
    const s = check(strip, whitesColor, () => true);
    // Both kinds on the wheel; on the strip of whites, nearly every one's made up to a
    // point (not the greenest of the warmest, at its bottom left, which never are).
    expect(w.between).toBeGreaterThan(20);
    expect(w.never).toBeGreaterThan(20);
    expect(s.between).toBeGreaterThan(100);
  });
});
