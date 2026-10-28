import { describe, expect, it } from "vitest";
import { DEVICES, SOLVERS, type Device } from "../shared/devices.ts";
import { gunzip, lookTopOf, makeCutoffs, pack, unpack, type Cutoffs, type Table } from "./cutoffs.ts";
import { wheelColor } from "./wheel.ts";
import { whitesColor } from "./whites.ts";

const gzip = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

describe("pack and unpack", () => {
  const sizes = { wheel: [5, 4], strip: [7, 3] } as const;

  it("give each kind of light's tables back to 16 bits of its top, jumps from 0 to the top and back included", async () => {
    // Every fifth value 0 and the next the top, the biggest jumps there are; the rest anything.
    const values = (n: number, seed: number, top: number) =>
      Float32Array.from({ length: n }, (_, k) => top * (k % 5 === 0 ? 0 : k % 5 === 1 ? 1 : ((k * 7919 + seed) % 1000) / 1000));
    const tablesOf = (top: number, seed: number) => ({
      wheel: { width: 5, height: 4, cutoffs: values(20, seed, top) },
      strip: { width: 7, height: 3, cutoffs: values(21, seed + 1, top) },
    });
    const tables: Cutoffs = { bulb: tablesOf(lookTopOf("bulb"), 1), panel: tablesOf(lookTopOf("panel"), 3) };
    const back = unpack(await gunzip(await gzip(pack(tables))), sizes)!;
    for (const d of DEVICES) {
      const top = lookTopOf(d);
      for (const t of ["wheel", "strip"] as const) {
        expect([back[d][t].width, back[d][t].height]).toEqual([tables[d][t].width, tables[d][t].height]);
        expect([...back[d][t].cutoffs]).toEqual([...tables[d][t].cutoffs].map((v) => Math.fround((Math.round((v / top) * 0xffff) / 0xffff) * top)));
      }
    }
  });

  it("won't unpack what isn't the tables", () => {
    expect(unpack(new Uint8Array(10), sizes)).toBeNull();
  });
});

describe("makeCutoffs", () => {
  const tables = makeCutoffs({ wheel: [15, 15], strip: [17, 7] });

  /** How many of a table's points have a cutoff between 0 and the top, how many are never made as asked, and how many always are, checking each against the solve. */
  function check(device: Device, t: Table, colorAt: (x: number, y: number) => [number, number], worked: (x: number, y: number) => boolean) {
    const madeAt = (a: number, b: number, look: number) => SOLVERS[device].makesExactly(a, b, look ** 3 * 1000, 0.5);
    // As the tables keep it (float32): 4000 lm's cube root, a panel's top, isn't one.
    const top = Math.fround(lookTopOf(device));
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
        } else if (cut < top) {
          between++;
          // Made just under it; not just past where it was found to (2^-14 of the slider).
          expect(madeAt(a, b, cut - 1e-6)).toBe(true);
          expect(madeAt(a, b, cut + 1e-4)).toBe(false);
        }
      }
    }
    return { between, never, always: t.cutoffs.filter((c) => c >= top).length };
  }

  it.each(DEVICES)("puts each color's cutoff where the %s stops making it as asked", (device) => {
    const { wheel, strip } = tables[device];
    // The wheel's whole square, its corners past the rim too (seen while it morphs to the whites' square).
    const w = check(device, wheel, (x, y) => wheelColor(x * 2 - 1, 1 - y * 2), () => true);
    const s = check(device, strip, whitesColor, () => true);
    // Both kinds on the wheel; on the strip of whites, nearly every one's made up to a
    // point, or all the way (not the greenest of the warmest, at its bottom left, which
    // never are). A panel's R, G and B add to its whites' 4000 lm, so it makes many whites
    // all the way to its top.
    expect(w.between).toBeGreaterThan(20);
    expect(w.never).toBeGreaterThan(20);
    expect(s.between + s.always).toBeGreaterThan(100);
  });
});
