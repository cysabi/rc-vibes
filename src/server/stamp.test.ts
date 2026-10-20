import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { keyId, readStamp, sketchOf, stamp, stampAs } from "./stamp.ts";

const KEY = "k".repeat(32);
const OTHER = "o".repeat(32);
const SKETCH = "0f4527e5-4faf-4691-b789-e4c389175401";
const COMMIT = "a".repeat(40);
const S = { sketch: SKETCH, commit: COMMIT, builder: "1" };
const BODY = "var __sketch = (() => {})();\nfunction update(prev) { return prev; }\n";

describe("a stamp", () => {
  it("says what was built, and checks out", () => {
    const script = stamp(BODY, S, KEY);
    expect(script.endsWith(BODY)).toBe(true);
    expect(script.split("\n")[0]).toContain(`key=${keyId(KEY)}`);
    expect(readStamp(script, KEY)).toEqual({ stamp: S, verified: true });
  });

  it("isn't on a script vibes didn't build", () => {
    expect(readStamp(BODY, KEY)).toBeNull();
    expect(readStamp(`// a comment\n${BODY}`, KEY)).toBeNull();
  });

  it("no longer checks out once anything's changed", () => {
    const script = stamp(BODY, S, KEY);
    const [line, ...rest] = script.split("\n");
    const tampered = [
      // The code: a character, appended, or removed.
      script.replace("return prev", "return prev "),
      `${script}// more\n`,
      script.slice(0, -1),
      // What it says it is.
      script.replace(COMMIT, "b".repeat(40)),
      script.replace(SKETCH, "3206740a-ca32-4097-b21a-53a95e996938"),
      script.replace("builder=1", "builder=2"),
      // Its signature.
      `${line!.replace(/sig=(.)/, (_, c: string) => `sig=${c === "A" ? "B" : "A"}`)}\n${rest.join("\n")}`,
    ];
    for (const t of tampered) expect(readStamp(t, KEY)?.verified).toBe(false);
  });

  it("isn't trusted when it was made with another key, or there's no key to check it with", () => {
    const script = stamp(BODY, S, OTHER);
    expect(readStamp(script, KEY)).toEqual({ stamp: S, verified: false });
    expect(readStamp(stamp(BODY, S, KEY), null)).toEqual({ stamp: S, verified: false });
  });

  it("can't say something that wouldn't read back", () => {
    expect(() => stamp(BODY, { ...S, commit: "abc" }, KEY)).toThrow();
    expect(() => stamp(BODY, { ...S, sketch: "nope" }, KEY)).toThrow();
    expect(() => stamp(BODY, { ...S, builder: "1 sig=x" }, KEY)).toThrow();
  });
});

describe("a shader's stamp (v2)", () => {
  const SHADER = "3206740a-ca32-4097-b21a-53a95e996938";

  it("names the shader too, and checks out, over the same code", () => {
    const script = stampAs(stamp(BODY, S, KEY), SHADER, KEY)!;
    expect(script.split("\n")[0]).toMatch(new RegExp(`^// vibes-stamp v2 sketch=${SKETCH} commit=${COMMIT} builder=1 shader=${SHADER} key=${keyId(KEY)} sig=`));
    expect(script.endsWith(BODY)).toBe(true);
    expect(readStamp(script, KEY)).toEqual({ stamp: { ...S, shader: SHADER }, verified: true });
    // Stamped as another shader, from the same build: the build's own stamp stays v1.
    expect(readStamp(stampAs(script, "0f4527e5-0000-4000-8000-000000000000", KEY)!, KEY)!.stamp.shader).toBe("0f4527e5-0000-4000-8000-000000000000");
    expect(readStamp(stamp(BODY, S, KEY), KEY)!.stamp).not.toHaveProperty("shader");
  });

  it("can't be moved to another shader, or kept on edited code", () => {
    const script = stampAs(stamp(BODY, S, KEY), SHADER, KEY)!;
    const moved = script.replace(SHADER, "0f4527e5-0000-4000-8000-000000000000");
    expect(readStamp(moved, KEY)!.verified).toBe(false);
    expect(readStamp(`${script}x`, KEY)!.verified).toBe(false);
  });

  it("is only made over a stamp that checks out", () => {
    expect(stampAs(BODY, SHADER, KEY)).toBeNull();
    expect(stampAs(stamp(BODY, S, OTHER), SHADER, KEY)).toBeNull();
    expect(stampAs(`${stamp(BODY, S, KEY)}x`, SHADER, KEY)).toBeNull();
    expect(() => stamp(BODY, { ...S, shader: "rclamp-12" }, KEY)).toThrow();
  });
});

describe("a shader's sketch", () => {
  const db = openDb(":memory:");
  db.addSketch({ id: SKETCH, name: "Warm wave", by_id: "rc:1", by_name: "Ada", at: 0 });

  it("is named, with its commit, from its stamp", () => {
    expect(sketchOf(stamp(BODY, S, KEY), KEY, db)).toEqual({ id: SKETCH, name: "Warm wave", commit: COMMIT, edited: false, deleted: false });
  });

  it("is shown as edited, or deleted", () => {
    expect(sketchOf(`${stamp(BODY, S, KEY)}x`, KEY, db)).toMatchObject({ edited: true });
    db.deleteSketch(SKETCH, { id: "rc:2", name: "Grace", dev: false }, 1);
    expect(sketchOf(stamp(BODY, S, KEY), KEY, db)).toMatchObject({ name: "Warm wave", deleted: true });
    db.restoreSketch(SKETCH);
  });

  it("is unnamed when vibes has no such sketch, and absent with no stamp", () => {
    expect(sketchOf(stamp(BODY, { ...S, sketch: "3206740a-ca32-4097-b21a-53a95e996938" }, KEY), KEY, db)).toMatchObject({ name: null });
    expect(sketchOf(BODY, KEY, db)).toBeUndefined();
    expect(sketchOf(undefined, KEY, db)).toBeUndefined();
  });
});
