import { describe, expect, it } from "vitest";
import { decodeFrame, decodeTouched, lightsOf, normalizeLights, type LightsResponse } from "./arclamp.ts";

const layout: LightsResponse = {
  id_width: 1,
  rails: [],
  lights: [
    {
      id: 1,
      type: "br30",
      tags: [],
      coords: null,
      rail: null,
      channels: ["a", "b", "brightness", "fidelity"],
    },
    { id: 64, type: "relay", tags: [], coords: null, rail: null, channels: ["brightness"] },
  ],
};

describe("normalizeLights", () => {
  it("fills in what older arclamps leave out", () => {
    const old = { id_width: 1, lights: [{ id: 1, type: "br30", tags: [], coords: "", channels: [] }] } as unknown as LightsResponse;
    expect(normalizeLights(old)).toEqual({ id_width: 1, rails: [], lights: [{ id: 1, type: "br30", tags: [], coords: null, rail: null, channels: [] }] });
  });

  it("keeps rails and rail spots", () => {
    const rail = { id: "r1", floor: 5, from: { mm_x: 0, mm_y: 0 }, to: { mm_x: 1000, mm_y: 0 } };
    const raw = {
      id_width: 1 as const,
      rails: [rail],
      lights: [{ id: 1, type: "br30", tags: [], coords: { mm_x: 500, mm_y: 0, floor: 5 }, rail: { id: "r1", mm_along: 500 }, channels: [] }],
    };
    expect(normalizeLights(raw)).toEqual(raw);
  });
});

function frame(lights: number[][], { idWidth = 1, rev = 1 } = {}): Uint8Array {
  const bytes: number[] = [];
  const header = new DataView(new ArrayBuffer(12));
  header.setBigUint64(0, 1724842800000n, true);
  header.setUint16(8, lights.length, true);
  header.setUint16(10, rev, true);
  bytes.push(...new Uint8Array(header.buffer));
  for (const [id, mask, ...values] of lights) {
    if (idWidth === 2) bytes.push(id! & 0xff, id! >> 8);
    else bytes.push(id!);
    bytes.push(mask!);
    for (const v of values) bytes.push(...new Uint8Array(new Float32Array([v!]).buffer)); // little-endian on every host we run
  }
  return new Uint8Array(bytes);
}

describe("decodeFrame", () => {
  it("maps mask bits to channel names in /v1/lights order", () => {
    const f = decodeFrame(frame([[1, 0b1111, 0.25, -0.5, 0.75, 1], [64, 0b1, 0.4]]), layout);
    expect(f.initialTime).toBe(1724842800000);
    expect(f.lights.get(1)).toEqual({ a: 0.25, b: -0.5, brightness: 0.75, fidelity: 1 });
    expect(f.lights.get(64)!.brightness).toBeCloseTo(0.4, 6); // float32
  });

  it("keeps values outside the usual ranges", () => {
    const f = decodeFrame(frame([[1, 0b0101, 3.5, 2.25]]), layout);
    expect(f.lights.get(1)).toEqual({ a: 3.5, brightness: 2.25 });
  });

  it("only reads values for set bits", () => {
    const f = decodeFrame(frame([[1, 0b1010, 0.5, 0.125]]), layout);
    expect(f.lights.get(1)).toEqual({ b: 0.5, fidelity: 0.125 });
  });

  it("reads two-byte little-endian ids", () => {
    const wide = { ...layout, id_width: 2 as const, lights: [{ ...layout.lights[1]!, id: 300 }] };
    const f = decodeFrame(frame([[300, 0b1, 1]], { idWidth: 2 }), wide);
    expect(f.lights.get(300)).toEqual({ brightness: 1 });
  });

  it("rejects other format revisions and truncated frames", () => {
    expect(() => decodeFrame(frame([[64, 1, 1]], { rev: 2 }), layout)).toThrow(/format_rev/);
    expect(() => decodeFrame(frame([[1, 0b1111, 1, 2]]), layout)).toThrow(/truncated/);
  });

  it("reads a frame with the touched section after it as it is", () => {
    const f = decodeFrame(withTouched(frame([[1, 0b0100, 0.5], [64, 0b1, 1]]), [{ id: 3, flags: 0, touched: [0b01], mask: [0b10] }]), layout);
    expect(f.lights.get(1)).toEqual({ brightness: 0.5 });
    expect(f.lights.get(64)).toEqual({ brightness: 1 });
  });
});

/** A frame with a touched section after it: one byte per bitfield (up to 8 lights). */
function withTouched(f: Uint8Array, shaders: { id: number; flags: number; touched: number[]; mask: number[] }[]): Uint8Array {
  const fieldBytes = shaders[0]?.touched.length ?? 1;
  const section = new DataView(new ArrayBuffer(4 + shaders.length * (5 + 2 * fieldBytes)));
  section.setUint16(0, shaders.length, true);
  section.setUint16(2, fieldBytes, true);
  let at = 4;
  for (const s of shaders) {
    section.setUint32(at, s.id, true);
    section.setUint8(at + 4, s.flags);
    at += 5;
    for (const b of [...s.touched, ...s.mask]) section.setUint8(at++, b);
  }
  return new Uint8Array([...f, ...new Uint8Array(section.buffer)]);
}

describe("decodeTouched", () => {
  const lights = frame([[1, 0b0100, 0.5], [64, 0b1, 1]]);

  it("reads what each shader touched and may not touch, by the frame's lights", () => {
    const t = decodeTouched(
      withTouched(lights, [
        { id: 3, flags: 0, touched: [0b11], mask: [0b10] },
        { id: 70000, flags: 1, touched: [0b10], mask: [0] },
      ]),
      layout,
    )!;
    expect(t.ids).toEqual([1, 64]);
    expect(t.shaders.map((s) => ({ id: s.id, muted: s.muted, touched: lightsOf(s.touched, t.ids), mask: lightsOf(s.mask, t.ids) }))).toEqual([
      { id: 3, muted: false, touched: [1, 64], mask: [64] },
      { id: 70000, muted: true, touched: [64], mask: [] },
    ]);
  });

  it("is null for a frame without one, and rejects a cut-off one", () => {
    expect(decodeTouched(lights, layout)).toBeNull();
    const whole = withTouched(lights, [{ id: 3, flags: 0, touched: [1], mask: [0] }]);
    expect(() => decodeTouched(whole.subarray(0, whole.length - 1), layout)).toThrow(/truncated/);
  });
});
