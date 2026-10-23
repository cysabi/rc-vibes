import { describe, expect, it } from "vitest";
import { pickTiers, type Manifest, type Tier } from "./basis.ts";

// 271 maps: 54 bulbs × 5 channels, and the room with them all off.
const tier = (width: number, height: number): Tier => ({
  width,
  height,
  encodings: [
    {
      codec: "av1",
      codec_string: "av01.0.08M.08",
      crf: 34,
      bytes: 0,
      streams: {
        WW: { file: "", order: Array.from({ length: 270 }, (_, i) => `m${i}`), packets: [], keyframes: [], scales: [], bytes: 0 },
        AMB: { file: "", order: ["amb"], packets: [], keyframes: [], scales: [], bytes: 0 },
      },
    },
  ],
});
const m: Manifest = { id: "30", made: "", gamma: 2.4, channels: [], ambient: "amb", tiers: [tier(4080, 2720), tier(1020, 680), tier(2040, 1360)] };
const size = (t: Tier | null) => t && `${t.width}x${t.height}`;

describe("pickTiers", () => {
  it("shows 1080p-class on a computer, settling to 4K-class", () => {
    const { live, settle } = pickTiers(m, "bc7", false, 16384);
    expect([size(live), size(settle)]).toEqual(["2040x1360", "4080x2720"]);
  });

  it("shows 720p-class on a phone, settling to 1080p-class", () => {
    const { live, settle } = pickTiers(m, "astc", true, 16384);
    expect([size(live), size(settle)]).toEqual(["1020x680", "2040x1360"]);
  });

  it("keeps uncompressed maps to what fits: 1080p-class, nothing to settle to", () => {
    const { live, settle } = pickTiers(m, "rgba8", false, 16384);
    expect([size(live), size(settle)]).toEqual(["2040x1360", null]);
  });

  it("skips sizes past the device's largest texture", () => {
    const { live, settle } = pickTiers(m, "bc7", false, 4096);
    expect([size(live), size(settle)]).toEqual(["2040x1360", "4080x2720"]);
    expect(size(pickTiers(m, "bc7", false, 2048).settle)).toBe(null);
  });
});
