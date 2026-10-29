import { describe, expect, it } from "vitest";
import { keyedMode, leavingFor, ringStyle, selectionWith } from "./selection.ts";

const set = (...ids: number[]) => new Set(ids);

describe("a light's ring", () => {
  it("is solid selected, dashed hovered, dotted about to be let go of, and none otherwise", () => {
    expect(ringStyle(false, false, false)).toBe("none");
    expect(ringStyle(true, false, false)).toBe("solid");
    expect(ringStyle(false, true, false)).toBe("dashed");
    expect(ringStyle(true, false, true)).toBe("dotted");
  });

  it("shows what a click would do over what is: letting go over hovered, hovered over selected", () => {
    expect(ringStyle(true, true, true)).toBe("dotted");
    expect(ringStyle(true, true, false)).toBe("dashed");
  });

  it("is never let go of when it isn't selected", () => {
    expect(ringStyle(false, false, true)).toBe("none");
    expect(ringStyle(false, true, true)).toBe("dashed");
  });
});

describe("about to be let go of", () => {
  it("is the selected lights a change would leave out", () => {
    // A click on 3 replaces the selection with it.
    expect(leavingFor(set(1, 2, 3), selectionWith(set(1, 2, 3), [3], "replace"))).toEqual(set(1, 2));
    // Shift on 4 adds it: nothing's let go of.
    expect(leavingFor(set(1, 2), selectionWith(set(1, 2), [4], keyedMode("add", [4], set(1, 2))))).toEqual(set());
    // Alt on 2 takes it out.
    expect(leavingFor(set(1, 2), selectionWith(set(1, 2), [2], keyedMode("remove", [2], set(1, 2))))).toEqual(set(2));
  });

  it("is alt's to take out, always: on lights none of which are selected, it adds nothing", () => {
    expect(keyedMode("remove", [4], set(1, 2))).toBe("remove");
    expect(selectionWith(set(1, 2), [4], keyedMode("remove", [4], set(1, 2)))).toEqual(set(1, 2));
  });

  it("is everything selected, for a click that selects nothing here", () => {
    expect(leavingFor(set(1, 2), selectionWith(set(1, 2), [], "replace"))).toEqual(set(1, 2));
  });
});
