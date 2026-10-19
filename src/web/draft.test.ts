import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneNode } from "../shared/vibes.ts";

const calls: string[] = [];
let failOn: string | null = null;
let scene: SceneNode[] = [];
// Something done while the next request is in flight (an edit mid-apply).
let during: (() => void) | null = null;

vi.mock("./api.ts", () => ({
  request: vi.fn(async (method: string, path: string, body?: unknown) => {
    const call = `${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`;
    if (method === "GET" && path === "/api/scene") return scene;
    calls.push(call);
    if (during) {
      const meanwhile = during;
      during = null;
      meanwhile();
    }
    if (failOn && call.startsWith(failOn)) throw new Error("arclamp said no");
    return {};
  }),
}));
vi.mock("./scene.ts", () => ({ invalidateScene: vi.fn(async () => {}) }));

const { applyDraft, currentDraft, drafts, EMPTY, layerOf, layersOf, pendingCount, reachOf, reorderWithin, roomtoneChanges, switchEverywhere, switchFor, switchState, templateOf } =
  await import("./draft.ts");

function shader(id: number, position: number, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    type: "js",
    position,
    script: `function update() { return { lights: [] }; } // ${id}`,
    state: "running",
    muted: false,
    created_by: "rc:1",
    modified_by: "rc:1",
    ...extra,
  } as SceneNode;
}

const roomtone: SceneNode = {
  id: 0,
  type: "roomtone",
  position: 0,
  template: { lights: { "1": { a: 0.0600728851, b: 0.134711643, brightness: 0.7, fidelity: 1 }, "64": { on: 0 } } },
  state: "running",
  muted: false,
  created_by: "",
  modified_by: "",
} as SceneNode;

// Live: shader 12 on top of 11.
const live = [roomtone, shader(11, 1), shader(12, 2)];
const keys = (d = currentDraft()) => layersOf(live, d).map((l) => l.key);

beforeEach(() => {
  drafts.discard();
  calls.length = 0;
  failOn = null;
  during = null;
  scene = live;
});

describe("the stack with pending edits", () => {
  it("shows the live stack, top first, with nothing pending", () => {
    expect(keys()).toEqual(["#12", "#11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("doesn't count an edit that matches what's live", () => {
    drafts.patchShader("#11", { muted: false });
    expect(keys()).toEqual(["#12", "#11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
    drafts.patchShader("#11", { muted: true });
    expect(pendingCount(live, currentDraft())).toBe(1);
  });

  it("rearranges some shaders among their own places, leaving the rest put", () => {
    expect(reorderWithin(["a", "b", "c", "d", "e"], ["d", "b"])).toEqual(["a", "d", "c", "b", "e"]);
    expect(reorderWithin(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("counts a mask that differs from the live one, in any order", () => {
    const masked = [roomtone, shader(11, 1, { mask: [1, 64] }), shader(12, 2)];
    drafts.patchShader("#11", { mask: [64, 1] });
    expect(pendingCount(masked, currentDraft())).toBe(0);
    drafts.patchShader("#11", { mask: [64] });
    expect(layersOf(masked, currentDraft()).find((l) => l.key === "#11")!.mask).toEqual([64]);
    expect(pendingCount(masked, currentDraft())).toBe(1);
  });

  it("counts a reorder once, and not once it's back as it was", () => {
    drafts.reorder(["#11", "#12"]);
    expect(keys()).toEqual(["#11", "#12"]);
    expect(pendingCount(live, currentDraft())).toBe(1);
    drafts.reorder(["#12", "#11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("shows shaders that turned up live after you reordered, on top", () => {
    drafts.reorder(["#11", "#12"]);
    const later = [...live, shader(13, 3)];
    expect(layersOf(later, currentDraft()).map((l) => l.key)).toEqual(["#13", "#11", "#12"]);
  });

  it("takes a shader out of the stack, counted once, and keeps it again", () => {
    drafts.remove("#11");
    expect(keys()).toEqual(["#12"]);
    expect(pendingCount(live, currentDraft())).toBe(1);
    expect(layerOf(live, currentDraft(), "#11")).toMatchObject({ key: "#11" });
    drafts.keep("#11");
    expect(keys()).toEqual(["#12", "#11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("doesn't count taking out a shader that's already gone", () => {
    drafts.remove("#13");
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("names shaders by id, and credits whoever arclamp says made them", () => {
    const [top] = layersOf(live, currentDraft());
    expect(top).toMatchObject({ name: "Shader #12", by: "rc:1" });
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
  it("sends room tone, then mutes and masks, then the order", async () => {
    drafts.setRoomtone({ "64": { on: 1 } }, "on");
    drafts.patchShader("#12", { muted: true });
    drafts.reorder(["#11", "#12"]);
    await applyDraft(live);
    expect(calls).toEqual([
      'PUT /api/roomtone {"lights":{"64":{"on":1}},"code":"on"}',
      'POST /api/shaders/12/muted {"muted":true}',
      'POST /api/shaders/12/position {"position":1}',
      'POST /api/shaders/11/position {"position":2}',
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("masks before unmuting, so a shader switched on for some lights never runs on the rest", async () => {
    const muted = [roomtone, shader(11, 1, { muted: true }), shader(12, 2)];
    scene = muted;
    drafts.patchShader("#11", { muted: false, mask: [64] });
    await applyDraft(muted);
    expect(calls).toEqual(['POST /api/shaders/11/mask {"mask":[64]}', 'POST /api/shaders/11/muted {"muted":false}']);
  });

  it("takes shaders out, without sending what else was pending for them", async () => {
    drafts.patchShader("#12", { muted: true });
    drafts.patchShader("#11", { muted: true });
    drafts.remove("#12");
    await applyDraft(live);
    expect(calls).toEqual(["DELETE /api/shaders/12", 'POST /api/shaders/11/muted {"muted":true}']);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("leaves a shader it couldn't take out pending", async () => {
    drafts.remove("#12");
    failOn = "DELETE /api/shaders/12";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    expect(currentDraft().removed).toEqual(["#12"]);
  });

  it("moves shaders bottom first when the order changed", async () => {
    drafts.reorder(["#11", "#12"]);
    await applyDraft(live);
    expect(calls).toEqual(['POST /api/shaders/12/position {"position":1}', 'POST /api/shaders/11/position {"position":2}']);
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
    drafts.patchShader("#12", { muted: true });
    failOn = "POST /api/shaders/12/muted";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    const left = currentDraft();
    expect(left.roomtone).toEqual({});
    expect(left.edits).toEqual({ "#12": { muted: true } });
  });
});

describe("adding a sketch", () => {
  const aurora = () => drafts.add({ sketchId: "s1", sketchName: "Aurora", branch: "main", home: [1, 2], mask: [64] });
  const rain = () => drafts.add({ sketchId: "s2", sketchName: "Rain", branch: "ada/try", home: [1], mask: [2, 64] });
  const built = { id: "b1", commit: "abc1234def", state: "built" as const, error: null };

  it("goes on top, the latest topmost, each counted once", () => {
    const first = aurora();
    const second = rain();
    expect(keys()).toEqual([second, first, "#12", "#11"]);
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
    expect(layersOf(live, currentDraft())[0]).toMatchObject({ script: "function update() {}", node: { sketch: { commit: "abc1234def" } } });
  });

  it("isn't counted as a reorder, and isn't added after all once let go", () => {
    const key = aurora();
    drafts.reorder(keys());
    expect(pendingCount(live, currentDraft())).toBe(1);
    drafts.unadd(key);
    expect(keys()).toEqual(["#12", "#11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("goes in on its home, from its branch: at the commit previewed, or the branch's head if it wasn't built yet", async () => {
    const first = aurora();
    drafts.built(first, built, "function update() {}");
    const second = rain();
    await applyDraft(live);
    expect(calls).toEqual([
      `POST /api/instances {"sketch":"s1","branch":"main","commit":"abc1234def","home":[1,2],"key":"${first}"}`,
      `POST /api/instances {"sketch":"s2","branch":"ada/try","home":[1],"key":"${second}"}`,
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("goes in once, however the draft changes while it's sent", async () => {
    const key = aurora();
    // Its build looked at, and room tone dragged, while it's on its way.
    during = () => {
      drafts.built(key, { ...built, state: "building" });
      drafts.setRoomtone({ "1": { brightness: 0.3 } }, "dimmer");
    };
    await applyDraft(live);
    expect(calls.filter((c) => c.startsWith("POST /api/instances"))).toHaveLength(1);
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
    failOn = "POST /api/instances";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    expect(currentDraft().added).toMatchObject([{ sketchId: "s1" }]);
  });
});

describe("switching a shader on and off", () => {
  const ALL = [1, 2, 3, 4, 5, 6];
  const instance = { id: "i", sketchId: "s", sketchName: "Wave", commit: "c", buildId: "b", branch: "main", head: "c", home: [1, 2, 3], shaderId: 9, state: "live", error: null, next: null, by: { id: "u", name: "U" }, at: 0 } as const;
  // An instance homed on 1–3 (masked off 4–6), and a shader from elsewhere that's lit 1 and 2.
  const homed = () => layerOf([roomtone, shader(9, 1, { instance: { ...instance, home: [1, 2, 3] }, mask: [4, 5, 6] })], EMPTY, "#9")!;
  const other = () => layerOf([roomtone, shader(8, 1, { footprint: [1, 2] })], EMPTY, "#8")!;

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
