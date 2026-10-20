import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Change, Instance } from "../shared/vibes.ts";
import type { Scene, SceneShader } from "./scene.ts";

// What was sent, as each apply's changes.
const sent: Change[] = [];
// Refuses the first change this says, as vibes would.
let failOn: ((c: Change) => boolean) | null = null;
// Something done while an apply is on its way (an edit mid-apply).
let during: (() => void) | null = null;

vi.mock("./scene.ts", () => {
  class ApplyError extends Error {
    at: number;
    made: Record<string, string>;
    constructor(message: string, at: number, made: Record<string, string>) {
      super(message);
      this.at = at;
      this.made = made;
    }
  }
  return {
    ApplyError,
    invalidateScene: vi.fn(async () => {}),
    applyChanges: vi.fn(async (changes: Change[]) => {
      sent.push(...changes);
      if (during) {
        const meanwhile = during;
        during = null;
        meanwhile();
      }
      const made: Record<string, string> = {};
      for (const [at, c] of changes.entries()) {
        if (failOn?.(c)) throw new ApplyError("arclamp said no", at, made);
        // An instance, made: its id vibes' own.
        if (c.op === "add") made[c.key] = `made${c.key}`;
      }
      return made;
    }),
  };
});

const { applyDraft, currentDraft, drafts, EMPTY, keyNow, layerOf, layersOf, pendingCount, reachOf, reorderWithin, roomtoneChanges, switchEverywhere, switchFor, switchState, templateOf } =
  await import("./draft.ts");

/** A shader in the room, as vibes sends it (with its script fetched): arclamp's shader `id`, put in some other way. */
function shader(id: number, extra: Partial<SceneShader> = {}): SceneShader {
  return {
    key: `rclamp-${id}`,
    stage: "live",
    name: `Shader #${id}`,
    state: "running",
    error: null,
    muted: false,
    mask: [],
    sketch: null,
    instance: null,
    by: "rc:1",
    footprint: [],
    scriptHash: `h${id}`,
    script: `function update() { return { lights: [] }; } // ${id}`,
    ...extra,
  };
}

const roomtone = { lights: { "1": { a: 0.0600728851, b: 0.134711643, brightness: 0.7, fidelity: 1 }, "64": { on: 0 } } };
/** The room: its shaders, top first. */
const room = (...shaders: SceneShader[]): Scene => ({ shaders, roomtone });

const instance: Instance = { id: "i", sketchId: "s", sketchName: "Wave", commit: "c", buildId: "b", branch: "main", head: "c", home: [1, 2, 3], state: "live", error: null, next: null, by: { id: "u", name: "U" }, at: 0 };
/** One put in from a sketch in vibes, still building: its key its instance's. */
const coming = (extra: Partial<SceneShader> = {}) =>
  shader(0, { key: "i1", stage: "building", name: "Wave", state: null, script: undefined, scriptHash: null, by: "U", instance: { ...instance, id: "i1", home: [1], state: "building" }, ...extra });

// Live: shader 12 on top of 11.
const live = room(shader(12), shader(11));
const keys = (d = currentDraft()) => layersOf(live, d).map((l) => l.key);

beforeEach(() => {
  drafts.discard();
  sent.length = 0;
  failOn = null;
  during = null;
});

describe("the stack with pending edits", () => {
  it("shows the live stack, top first, with nothing pending", () => {
    expect(keys()).toEqual(["rclamp-12", "rclamp-11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("doesn't count an edit that matches what's live", () => {
    drafts.patchShader("rclamp-11", { muted: false });
    expect(keys()).toEqual(["rclamp-12", "rclamp-11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
    drafts.patchShader("rclamp-11", { muted: true });
    expect(pendingCount(live, currentDraft())).toBe(1);
  });

  it("rearranges some shaders among their own places, leaving the rest put", () => {
    expect(reorderWithin(["a", "b", "c", "d", "e"], ["d", "b"])).toEqual(["a", "d", "c", "b", "e"]);
    expect(reorderWithin(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("counts a mask that differs from the live one, in any order", () => {
    const masked = room(shader(12), shader(11, { mask: [1, 64] }));
    drafts.patchShader("rclamp-11", { mask: [64, 1] });
    expect(pendingCount(masked, currentDraft())).toBe(0);
    drafts.patchShader("rclamp-11", { mask: [64] });
    expect(layersOf(masked, currentDraft()).find((l) => l.key === "rclamp-11")!.mask).toEqual([64]);
    expect(pendingCount(masked, currentDraft())).toBe(1);
  });

  it("counts a reorder once, and not once it's back as it was", () => {
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    expect(keys()).toEqual(["rclamp-11", "rclamp-12"]);
    expect(pendingCount(live, currentDraft())).toBe(1);
    drafts.reorder(["rclamp-12", "rclamp-11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("shows shaders that turned up live after you reordered, on top", () => {
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    const later = room(shader(13), ...live.shaders);
    expect(layersOf(later, currentDraft()).map((l) => l.key)).toEqual(["rclamp-13", "rclamp-11", "rclamp-12"]);
  });

  it("takes a shader out of the stack, counted once, and keeps it again", () => {
    drafts.remove("rclamp-11");
    expect(keys()).toEqual(["rclamp-12"]);
    expect(pendingCount(live, currentDraft())).toBe(1);
    expect(layerOf(live, currentDraft(), "rclamp-11")).toMatchObject({ key: "rclamp-11" });
    drafts.keep("rclamp-11");
    expect(keys()).toEqual(["rclamp-12", "rclamp-11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("doesn't count taking out a shader that's already gone", () => {
    drafts.remove("rclamp-13");
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("names shaders, and credits whoever made them, as vibes says", () => {
    const [top] = layersOf(live, currentDraft());
    expect(top).toMatchObject({ name: "Shader #12", by: "rc:1" });
  });
});

describe("shaders on their way in", () => {
  it("are in the stack over the room's, as vibes has them, whatever your order, and aren't pending edits", () => {
    const scene = room(coming(), shader(12), shader(11));
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    expect(layersOf(scene, currentDraft()).map((l) => [l.key, l.stage])).toEqual([
      ["i1", "building"],
      ["rclamp-11", "live"],
      ["rclamp-12", "live"],
    ]);
    expect(pendingCount(scene, currentDraft())).toBe(1);
    expect(layerOf(scene, currentDraft(), "i1")).toMatchObject({ name: "Wave", script: "", by: "U" });
    expect(reachOf(layerOf(scene, currentDraft(), "i1")!)).toEqual([1]);
  });

  it("are switched and moved like any other: vibes keeps it, to put them in that way", async () => {
    const scene = room(coming(), shader(12), shader(11));
    drafts.patchShader("i1", { muted: true });
    drafts.reorder(["rclamp-12", "i1", "rclamp-11"]);
    expect(layerOf(scene, currentDraft(), "i1")!.muted).toBe(true);
    expect(pendingCount(scene, currentDraft())).toBe(2);
    await applyDraft(scene);
    expect(sent).toEqual([
      { op: "muted", key: "i1", muted: true },
      { op: "stack", order: ["rclamp-12", "i1", "rclamp-11"] },
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("that couldn't go in, aren't switched", async () => {
    const scene = room(coming({ stage: "failed" }), shader(12));
    drafts.patchShader("i1", { muted: true });
    expect(layerOf(scene, currentDraft(), "i1")!.muted).toBe(false);
    expect(pendingCount(scene, currentDraft())).toBe(0);
  });

  it("can be taken out, by their key", async () => {
    const scene = room(coming({ stage: "failed", error: "it didn't compile" }), shader(12));
    drafts.remove("i1");
    expect(pendingCount(scene, currentDraft())).toBe(1);
    await applyDraft(scene);
    expect(sent).toEqual([{ op: "remove", key: "i1" }]);
  });
});

describe("room tone with pending edits", () => {
  it("lays the draft over the live template", () => {
    drafts.setRoomtone({ "1": { brightness: 0.2 } }, "dim");
    expect(templateOf(live, currentDraft())["1"]).toEqual({ a: 0.0600728851, b: 0.134711643, brightness: 0.2, fidelity: 1 });
    expect(roomtoneChanges(live, currentDraft())).toEqual({ "1": { brightness: 0.2 } });
    expect(pendingCount(live, currentDraft())).toBe(1);
  });

  it("treats values that match at float32 as unchanged", () => {
    // What arclamp sends back for 3000 K, against what vibes computes.
    drafts.setRoomtone({ "1": { a: 0.060072885, b: 0.13471164, brightness: 0.7, fidelity: 1 } }, null);
    expect(roomtoneChanges(live, currentDraft())).toEqual({});
    expect(pendingCount(live, currentDraft())).toBe(0);
  });
});

describe("apply", () => {
  it("sends room tone, then mutes and masks, then the order, as one apply", async () => {
    drafts.setRoomtone({ "64": { on: 1 } }, "on");
    drafts.patchShader("rclamp-12", { muted: true });
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    await applyDraft(live);
    expect(sent).toEqual([
      { op: "roomtone", lights: { "64": { on: 1 } }, code: "on" },
      { op: "muted", key: "rclamp-12", muted: true },
      { op: "stack", order: ["rclamp-11", "rclamp-12"] },
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("masks before unmuting, so a shader switched on for some lights never runs on the rest", async () => {
    const muted = room(shader(12), shader(11, { muted: true }));
    drafts.patchShader("rclamp-11", { muted: false, mask: [64] });
    await applyDraft(muted);
    expect(sent).toEqual([
      { op: "mask", key: "rclamp-11", mask: [64] },
      { op: "muted", key: "rclamp-11", muted: false },
    ]);
  });

  it("takes shaders out, without sending what else was pending for them", async () => {
    drafts.patchShader("rclamp-12", { muted: true });
    drafts.patchShader("rclamp-11", { muted: true });
    drafts.remove("rclamp-12");
    await applyDraft(live);
    expect(sent).toEqual([
      { op: "remove", key: "rclamp-12" },
      { op: "muted", key: "rclamp-11", muted: true },
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("leaves a shader it couldn't take out pending", async () => {
    drafts.remove("rclamp-12");
    failOn = (c) => c.op === "remove";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    expect(currentDraft().removed).toEqual(["rclamp-12"]);
  });

  it("sends the order, top first, only when it changed", async () => {
    drafts.reorder(["rclamp-12", "rclamp-11"]);
    drafts.patchShader("rclamp-11", { muted: true });
    await applyDraft(live);
    expect(sent).toEqual([{ op: "muted", key: "rclamp-11", muted: true }]);
    sent.length = 0;
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    await applyDraft(live);
    expect(sent).toEqual([{ op: "stack", order: ["rclamp-11", "rclamp-12"] }]);
  });

  it("lets go of edits to a shader that's gone", async () => {
    drafts.patchShader("rclamp-99", { muted: true });
    expect(pendingCount(live, currentDraft())).toBe(0);
    await applyDraft(live);
    expect(sent).toEqual([]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("keeps edits made while it sends", async () => {
    drafts.setRoomtone({ "1": { brightness: 0.2 } }, "dim");
    // Dragged on while the room tone is on its way.
    during = () => drafts.setRoomtone({ "1": { brightness: 0.3 } }, "dimmer");
    await applyDraft(live);
    expect(currentDraft().roomtone).toEqual({ "1": { brightness: 0.3 } });
  });

  it("leaves just what didn't land pending when a step fails", async () => {
    drafts.setRoomtone({ "1": { brightness: 0.2 } }, "dim");
    drafts.patchShader("rclamp-12", { muted: true });
    failOn = (c) => c.op === "muted" && c.key === "rclamp-12";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    const left = currentDraft();
    expect(left.roomtone).toEqual({});
    expect(left.edits).toEqual({ "rclamp-12": { muted: true } });
  });
});

describe("adding a sketch", () => {
  const aurora = () => drafts.add({ sketchId: "s1", sketchName: "Aurora", branch: "main", home: [1, 2], mask: [64] });
  const rain = () => drafts.add({ sketchId: "s2", sketchName: "Rain", branch: "ada/try", home: [1], mask: [2, 64] });
  const built = { id: "b1", commit: "abc1234def", state: "built" as const, error: null };

  it("goes on top, the latest topmost, each counted once", () => {
    const first = aurora();
    const second = rain();
    expect(keys()).toEqual([second, first, "rclamp-12", "rclamp-11"]);
    expect(pendingCount(live, currentDraft())).toBe(2);
    const [top] = layersOf(live, currentDraft());
    expect(top).toMatchObject({ name: "Rain", mask: [2, 64], script: "", adding: { sketchId: "s2" } });
    expect(reachOf(top!)).toEqual([1]);
  });

  it("is previewed once it's built, with its script", () => {
    const key = aurora();
    drafts.built(key, { ...built, state: "building" });
    expect(layersOf(live, currentDraft())[0]!.script).toBe("");
    drafts.built(key, built, "function update() {}");
    expect(layersOf(live, currentDraft())[0]).toMatchObject({ stage: "adding", script: "function update() {}", sketch: { commit: "abc1234def" } });
  });

  it("isn't counted as a reorder, and isn't added after all once let go", () => {
    const key = aurora();
    drafts.reorder(keys());
    expect(pendingCount(live, currentDraft())).toBe(1);
    drafts.unadd(key);
    expect(keys()).toEqual(["rclamp-12", "rclamp-11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("goes in on its home, from its branch: as the build previewed, or the branch's head if none was asked for yet", async () => {
    const first = aurora();
    drafts.built(first, built, "function update() {}");
    const second = rain();
    await applyDraft(live);
    expect(sent).toEqual([
      { op: "add", key: first, sketch: "s1", branch: "main", build: "b1", home: [1, 2], muted: false, mask: [64] },
      { op: "add", key: second, sketch: "s2", branch: "ada/try", home: [1], muted: false, mask: [2, 64] },
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("is switched like any other, and goes in that way", async () => {
    const key = aurora();
    drafts.patchShader(key, { mask: [2, 64] });
    expect(layersOf(live, currentDraft())[0]!.mask).toEqual([2, 64]);
    // Still one change.
    expect(pendingCount(live, currentDraft())).toBe(1);
    drafts.patchShader(key, { muted: true });
    await applyDraft(live);
    expect(sent).toEqual([{ op: "add", key, sketch: "s1", branch: "main", home: [1, 2], muted: true, mask: [2, 64] }]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("goes in where you put it, just above the one under it, the lowest first", async () => {
    const first = aurora();
    const second = rain();
    // Rain under the rest; Aurora between the room's two.
    drafts.reorder(["rclamp-12", first, "rclamp-11", second]);
    expect(pendingCount(live, currentDraft())).toBe(2);
    await applyDraft(live);
    expect(sent).toEqual([
      { op: "add", key: second, sketch: "s2", branch: "ada/try", home: [1], muted: false, mask: [2, 64], above: "" },
      { op: "add", key: first, sketch: "s1", branch: "main", home: [1, 2], muted: false, mask: [64], above: "rclamp-11" },
    ]);
  });

  it("goes in above another you're adding, by that one's key; and the stack's sent with them", async () => {
    const first = aurora();
    const second = rain();
    drafts.reorder([first, second, "rclamp-11", "rclamp-12"]);
    await applyDraft(live);
    expect(sent).toEqual([
      { op: "add", key: second, sketch: "s2", branch: "ada/try", home: [1], muted: false, mask: [2, 64], above: "rclamp-11" },
      { op: "add", key: first, sketch: "s1", branch: "main", home: [1, 2], muted: false, mask: [64], above: second },
      { op: "stack", order: [first, second, "rclamp-11", "rclamp-12"] },
    ]);
    // What's open on one stays open on the shader it's become.
    expect(keyNow(first)).toBe(`made${first}`);
    expect(keyNow("rclamp-11")).toBe("rclamp-11");
  });

  it("goes in once, however the draft changes while it's sent", async () => {
    const key = aurora();
    // Its build looked at, and room tone dragged, while it's on its way.
    during = () => {
      drafts.built(key, { ...built, state: "building" });
      drafts.setRoomtone({ "1": { brightness: 0.3 } }, "dimmer");
    };
    await applyDraft(live);
    expect(sent.filter((c) => c.op === "add")).toHaveLength(1);
    expect(currentDraft().added).toEqual([]);
    expect(currentDraft().roomtone).toEqual({ "1": { brightness: 0.3 } });
    expect(pendingCount(live, currentDraft())).toBe(1);
  });

  it("doesn't change the draft when its build hasn't changed", () => {
    const key = aurora();
    drafts.built(key, { ...built, state: "building" });
    const before = currentDraft();
    drafts.built(key, { ...built, state: "building" });
    expect(currentDraft()).toBe(before);
    drafts.built(key, built, "function update() {}");
    expect(currentDraft()).not.toBe(before);
  });

  it("stays pending if it couldn't go in", async () => {
    aurora();
    failOn = (c) => c.op === "add";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    expect(currentDraft().added).toMatchObject([{ sketchId: "s1" }]);
  });

  it("comes out of the draft once it's in, though the apply stops after it", async () => {
    const key = aurora();
    drafts.patchShader("rclamp-12", { muted: true });
    failOn = (c) => c.op === "muted";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    expect(currentDraft().added).toEqual([]);
    expect(currentDraft().edits).toEqual({ "rclamp-12": { muted: true } });
    expect(keyNow(key)).toBe(`made${key}`);
  });
});

describe("switching a shader on and off", () => {
  const ALL = [1, 2, 3, 4, 5, 6];
  // An instance homed on 1–3 (masked off 4–6), and a shader from elsewhere that's lit 1 and 2.
  const homed = () => layerOf(room(shader(9, { key: "i", instance, mask: [4, 5, 6] })), EMPTY, "i")!;
  const other = () => layerOf(room(shader(8, { footprint: [1, 2] })), EMPTY, "rclamp-8")!;

  it("is about its home, or with none, where it's lit", () => {
    expect(reachOf(homed())).toEqual([1, 2, 3]);
    expect(reachOf(other())).toEqual([1, 2]);
  });

  it("is on for lights whatever its mask outside its home", () => {
    expect(switchState(homed(), [1, 2])).toBe("on");
    expect(switchState(homed())).toBe("on");
    expect(switchState({ ...homed(), mask: [1, 4, 5, 6] }, [1, 2])).toBe("mixed");
    expect(switchState({ ...homed(), muted: true }, [1])).toBe("off");
  });

  it("switches only lights in its home", () => {
    expect(switchFor(homed(), [1, 4], false, ALL)).toEqual({ mask: [1, 4, 5, 6] });
    expect(switchFor({ ...homed(), mask: [1, 2, 4, 5, 6] }, [2, 6], true, ALL)).toEqual({ mask: [1, 4, 5, 6] });
  });

  it("is off, muted, once it's off on everything it's about", () => {
    expect(switchFor(homed(), [1, 2, 3], false, ALL)).toEqual({ muted: true });
    expect(switchFor({ ...other(), mask: [1] }, [2], false, ALL)).toEqual({ muted: true });
  });

  it("switched on while muted, is on for just these lights", () => {
    expect(switchFor({ ...homed(), muted: true }, [2], true, ALL)).toEqual({ muted: false, mask: [1, 3, 4, 5, 6] });
  });

  it("on everywhere is all of its home", () => {
    expect(switchEverywhere({ ...homed(), muted: true, mask: [1, 4, 5, 6] }, true, ALL)).toEqual({ muted: false, mask: [4, 5, 6] });
    expect(switchEverywhere(other(), true, ALL)).toEqual({ muted: false, mask: [] });
    expect(switchEverywhere(other(), false, ALL)).toEqual({ muted: true });
  });
});
