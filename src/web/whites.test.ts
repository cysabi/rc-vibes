import { describe, expect, it } from "vitest";
import { tintAt, toneText, TINT_STEPS, whiteAt } from "./whites.ts";

describe("a color, as it's said", () => {
  it("says a white by its temperature", () => {
    expect(toneText(...whiteAt(3000, 0))).toBe("3000K");
    expect(toneText(...whiteAt(4520, 0))).toBe("4500K");
  });

  it("says a white's tint in steps up (pinker) or down (greener)", () => {
    expect(toneText(...whiteAt(3000, tintAt(2 / TINT_STEPS)))).toBe("3000K (+2 tint)");
    expect(toneText(...whiteAt(3000, tintAt(-5 / TINT_STEPS)))).toBe("3000K (-5 tint)");
  });

  it("says anything else by its hue and chroma", () => {
    expect(toneText(0.2, 0)).toBe("0° C0.20");
    expect(toneText(0, 0.25)).toBe("90° C0.25");
  });
});
