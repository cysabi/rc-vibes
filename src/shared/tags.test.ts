import { describe, expect, it } from "vitest";
import { normalizeTag, sameTags, tagLabel } from "./tags.ts";

describe("normalizeTag", () => {
  it("lowercases and joins words with hyphens", () => {
    expect(normalizeTag("  Back Wall ")).toBe("back-wall");
    expect(normalizeTag("kitchen_2")).toBe("kitchen_2");
  });

  it("refuses what shaders couldn't easily match", () => {
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("-lead")).toBeNull();
    expect(normalizeTag("café")).toBeNull();
    expect(normalizeTag("a".repeat(33))).toBeNull();
  });
});

describe("tagLabel", () => {
  it("reads a tag back as words", () => {
    expect(tagLabel("dining-room")).toBe("Dining Room");
    expect(tagLabel("presentation-space")).toBe("Presentation Space");
    expect(tagLabel("kitchen_2")).toBe("Kitchen 2");
    expect(tagLabel("dave")).toBe("Dave");
  });

  it("undoes what normalizeTag did to typed words", () => {
    expect(tagLabel(normalizeTag("Back Wall")!)).toBe("Back Wall");
  });
});

describe("sameTags", () => {
  it("ignores order, and treats none as empty", () => {
    expect(sameTags(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameTags(null, [])).toBe(true);
    expect(sameTags(["a"], ["a", "b"])).toBe(false);
  });
});
