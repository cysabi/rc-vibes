import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Op, Pool } from "../shared/live.ts";
import type { ParamSpec } from "../shared/params.ts";
import type { Instance } from "../shared/vibes.ts";
import type { Scene, SceneShader } from "./scene.ts";

// What was sent: each update's changes, and what it said it's for.
const sent: { ops: Op[]; note?: string }[] = [];
// Refuses at the first change this says, as vibes would.
let failOn: ((op: Op) => boolean) | null = null;
// Something done while an update is on its way (an edit mid-send).
let during: (() => void) | null = null;

vi.mock("./scene.ts", () => {
  class UpdateError extends Error {
    code: string;
    made: Record<string, string>;
    constructor(message: string, code: string, made: Record<string, string>) {
      super(message);
      this.code = code;
      this.made = made;
    }
  }
  return {
    UpdateError,
    invalidateScene: vi.fn(async () => {}),
    sendUpdate: vi.fn(async (ops: Op[], note?: string) => {
      sent.push({ ops, ...(note ? { note } : {}) });
      if (during) {
        const meanwhile = during;
        during = null;
        meanwhile();
      }
      const made: Record<string, string> = {};
      for (const op of ops) {
        if (failOn?.(op)) throw new UpdateError("arclamp said no", "refused", made);
        // A sketch put in: an instance, its id vibes' own.
        const add = /^shaders\/(\+[^/]+)$/.exec(op[0]);
        if (add && op.length === 2) made[add[1]!] = `made${add[1]}`;
      }
      return made;
    }),
  };
});

const { applyDraft, changedLights, changesByLayer, currentDraft, drafts, EMPTY, keyNow, layerOf, layersOf, opsOf, pendingCount, reachOf, reorderWithin, roomtoneChanges, switchEverywhere, switchFor, switchState, templateOf } =
  await import("./draft.ts");
const { sendUpdate } = await import("./scene.ts");

/** Every change sent, in all its updates. */
const ops = () => sent.flatMap((s) => s.ops);

/** A shader in the room, as vibes has it (with its script fetched): arclamp's shader `id`, put in some other way. */
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
    pool: null,
    ...extra,
  };
}

const roomtone = { lights: { "1": { a: 0.0600728851, b: 0.134711643, brightness: 0.7, fidelity: 1 }, "64": { on: 0 } } };
/** The room: its shaders, top first, and its pools. */
const room = (...shaders: SceneShader[]): Scene => ({ shaders, roomtone, pools: {} });
const withPools = (scene: Scene, pools: Record<string, Pool>): Scene => ({ ...scene, pools });

const instance: Instance = { id: "i", sketchId: "s", sketchName: "Wave", commit: "c", buildId: "b", branch: "main", head: "c", home: [1, 2, 3], state: "live", error: null, next: null, by: { id: "u", name: "U" }, at: 0 };
/** One put in from a sketch in vibes, still building: its key its instance's. */
const coming = (extra: Partial<SceneShader> = {}) =>
  shader(0, { key: "i1", stage: "building", name: "Wave", state: null, script: undefined, scriptHash: null, by: "U", instance: { ...instance, id: "i1", home: [1], state: "building" }, ...extra });

const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 7, min: 0, max: 20, step: 0.1 };

// Live: shader 12 on top of 11.
const live = room(shader(12), shader(11));
const keys = (d = currentDraft()) => layersOf(live, d).map((l) => l.key);

beforeEach(() => {
  drafts.discard();
  sent.length = 0;
  failOn = null;
  during = null;
});

describe("a scene applied as pending edits", () => {
  it("switches every shader as the scene says, its knobs to the scene's, in place of what was pending for them, and leaves Base Color and the rest", () => {
    const pools: Record<string, Pool> = { pa: { declared: [speed], values: { speed: { "1": 3 } } } as unknown as Pool };
    const base = shader(1, { pool: "b45e0c01-0000-4000-8000-000000000003" });
    const here = withPools(room(shader(13, { pool: "pa", muted: true }), shader(12), shader(11), base), pools);
    drafts.patchShader("rclamp-13", { muted: true, params: { speed: { "2": 9 } } });
    drafts.patchShader("rclamp-11", { muted: false, params: { speed: { "1": 1 } }, mask: [5] });
    drafts.applyScene({ name: "S", shaders: { "rclamp-13": { speed: { "1": 5 } } }, by: { id: "u", name: "U" }, at: 0 }, here);
    expect(currentDraft().edits).toEqual({
      // On, with the scene's knobs (light 1 to 5): what was pending for its knobs gives way.
      "rclamp-13": { muted: false, params: { speed: { "1": 5 } } },
      "rclamp-12": { muted: true },
      // Off; its pending knobs and mask stay.
      "rclamp-11": { muted: true, params: { speed: { "1": 1 } }, mask: [5] },
    });
  });
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
      {
        ops: [
          ["shaders/i1/muted", true],
          ["stack", ["rclamp-12", "i1", "rclamp-11"]],
        ],
      },
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
    expect(ops()).toEqual([["shaders/i1"]]);
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

describe("a shader's params, in its pool", () => {
  const pooled = withPools(room(shader(12, { pool: "p1" }), shader(11)), { p1: { declared: [speed], values: { speed: { "1": 2 } } } });

  it("are what its pool declares, with its values by light grouped, and none for a shader with no pool (or one not there yet)", () => {
    expect(layerOf(pooled, EMPTY, "rclamp-12")!.params).toEqual({ declared: [speed], values: { speed: [[2, [1]]] } });
    expect(layerOf(pooled, EMPTY, "rclamp-11")!.params).toBeNull();
    expect(layerOf(room(shader(12, { pool: "p9" })), EMPTY, "rclamp-12")!.params).toBeNull();
    // Nothing declared yet: no values to show.
    expect(layerOf(withPools(room(shader(12, { pool: "p1" })), { p1: { declared: null, values: { speed: { "1": 2 } } } }), EMPTY, "rclamp-12")!.params).toEqual({ declared: null, values: {} });
  });

  it("are kept as pending edits, light by light, previewed, and only what actually changes is sent", async () => {
    drafts.setParam("rclamp-12", "speed", [
      [1, 9],
      [2, 9],
    ]);
    expect(pendingCount(pooled, currentDraft())).toBe(1);
    expect(layerOf(pooled, currentDraft(), "rclamp-12")!.params).toEqual({ declared: [speed], values: { speed: [[9, [1, 2]]] } });
    // A later change goes over the first, light by light; null is back to the default.
    drafts.setParam("rclamp-12", "speed", [
      [2, 3],
      [3, null],
    ]);
    expect(layerOf(pooled, currentDraft(), "rclamp-12")!.params!.values).toEqual({ speed: [[9, [1]], [3, [2]]] });
    await applyDraft(pooled);
    // Light 3 was at the default already: nothing to send for it.
    expect(ops()).toEqual([
      ["pools/p1/values/speed/1", 9],
      ["pools/p1/values/speed/2", 3],
    ]);
    expect(currentDraft()).toBe(EMPTY);
    // Back to what's live: nothing to send.
    sent.length = 0;
    drafts.setParam("rclamp-12", "speed", [
      [1, 2],
      [2, null],
    ]);
    expect(pendingCount(pooled, currentDraft())).toBe(0);
    await applyDraft(pooled);
    expect(sent).toEqual([]);
  });

  it("back to the default takes the light's value away", () => {
    drafts.setParam("rclamp-12", "speed", [[1, null]]);
    expect(opsOf(pooled, currentDraft())).toEqual([["pools/p1/values/speed/1"]]);
  });

  it("passes over a param its pool doesn't declare", () => {
    drafts.setParam("rclamp-12", "gone", [[1, 3]]);
    expect(opsOf(pooled, currentDraft())).toEqual([]);
    expect(pendingCount(pooled, currentDraft())).toBe(0);
  });

  it("sends just the numbers of a color that change, each number's lights together", () => {
    const tint: ParamSpec = { kind: "color", name: "tint", label: "Tint", lights: {}, default: { a: 0, b: 0, lm: 300, fidelity: 1 } };
    const red = { a: 0.2, b: 0.1, lm: 500, fidelity: 1 };
    const blue = { a: -0.1, b: -0.2, lm: 200, fidelity: 1 };
    const colored = withPools(room(shader(12, { pool: "p1" })), { p1: { declared: [tint], values: { tint: { "1": red, "2": blue } } } });
    // Over both; and light 3, at the default, over the default's color.
    drafts.setParam("rclamp-12", "tint", [
      [1, { ...red, lm: 40, a: 0.3 }],
      [2, { ...blue, lm: 40, a: 0.3 }],
      [3, { a: 0.5, b: 0, lm: 300, fidelity: 1 }],
    ]);
    expect(opsOf(colored, currentDraft())).toEqual([
      ["pools/p1/values/tint/1/a", 0.3],
      ["pools/p1/values/tint/2/a", 0.3],
      ["pools/p1/values/tint/3/a", 0.5],
      ["pools/p1/values/tint/1/lm", 40],
      ["pools/p1/values/tint/2/lm", 40],
    ]);
    // Back to the default, or a value that isn't a color: whole.
    drafts.setParam("rclamp-12", "tint", [[1, null]]);
    expect(opsOf(colored, currentDraft())[0]).toEqual(["pools/p1/values/tint/1"]);
  });
});

describe("apply", () => {
  it("sends room tone, mutes and masks, and the order, as one update, saying what the room tone's for", async () => {
    drafts.setRoomtone({ "64": { on: 1 } }, "on");
    drafts.patchShader("rclamp-12", { muted: true });
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    await applyDraft(live);
    expect(sent).toEqual([
      {
        ops: [
          ["roomtone/64/on", 1],
          ["shaders/rclamp-12/muted", true],
          ["stack", ["rclamp-11", "rclamp-12"]],
        ],
        note: "on",
      },
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("sends a mask and a mute together, for vibes to make in the order that keeps the room right", async () => {
    const muted = room(shader(12), shader(11, { muted: true }));
    drafts.patchShader("rclamp-11", { muted: false, mask: [64] });
    await applyDraft(muted);
    expect(sent).toHaveLength(1);
    expect(ops()).toEqual([
      ["shaders/rclamp-11/muted", false],
      ["shaders/rclamp-11/mask", [64]],
    ]);
  });

  it("takes shaders out, without sending what else was pending for them", async () => {
    drafts.patchShader("rclamp-12", { muted: true });
    drafts.patchShader("rclamp-11", { muted: true });
    drafts.remove("rclamp-12");
    await applyDraft(live);
    expect(ops()).toEqual([["shaders/rclamp-12"], ["shaders/rclamp-11/muted", true]]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("leaves a shader it couldn't take out pending", async () => {
    drafts.remove("rclamp-12");
    failOn = (op) => op[0] === "shaders/rclamp-12" && op.length === 1;
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    expect(currentDraft().removed).toEqual(["rclamp-12"]);
  });

  it("sends the order, top first, only when it changed", async () => {
    drafts.reorder(["rclamp-12", "rclamp-11"]);
    drafts.patchShader("rclamp-11", { muted: true });
    await applyDraft(live);
    expect(ops()).toEqual([["shaders/rclamp-11/muted", true]]);
    sent.length = 0;
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    await applyDraft(live);
    expect(ops()).toEqual([["stack", ["rclamp-11", "rclamp-12"]]]);
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

  it("sends live mode's drafts without waiting: only the newest's answer, with nothing edited since, clears it", async () => {
    const answers: (() => void)[] = [];
    const usual = vi.mocked(sendUpdate).getMockImplementation()!;
    vi.mocked(sendUpdate).mockImplementation((updateOps, note) => {
      sent.push({ ops: updateOps, ...(note ? { note } : {}) });
      return new Promise((done) => answers.push(() => done({})));
    });
    try {
      drafts.setRoomtone({ "1": { brightness: 0.2 } }, "dim");
      const first = applyDraft(live);
      drafts.setRoomtone({ "1": { brightness: 0.3 } }, "dim");
      const second = applyDraft(live);
      // Both on their way at once, each with what was pending then.
      expect(sent).toEqual([
        { ops: [["roomtone/1/brightness", 0.2]], note: "dim" },
        { ops: [["roomtone/1/brightness", 0.3]], note: "dim" },
      ]);
      answers[0]!();
      await first;
      expect(currentDraft().roomtone).toEqual({ "1": { brightness: 0.3 } });
      answers[1]!();
      await second;
      expect(currentDraft()).toBe(EMPTY);
    } finally {
      vi.mocked(sendUpdate).mockImplementation(usual);
    }
  });

  it("keeps the draft pending when it's refused; what landed before it stopped isn't pending once the room shows it", async () => {
    drafts.setRoomtone({ "1": { brightness: 0.2 } }, "dim");
    drafts.patchShader("rclamp-12", { muted: true });
    failOn = (op) => op[0] === "shaders/rclamp-12/muted";
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    const left = currentDraft();
    expect(left.roomtone).toEqual({ "1": { brightness: 0.2 } });
    expect(left.edits).toEqual({ "rclamp-12": { muted: true } });
    // The room tone landed: only the mute's pending.
    const landed: Scene = { ...live, roomtone: { lights: { ...roomtone.lights, "1": { ...roomtone.lights["1"], brightness: 0.2 } } } };
    expect(pendingCount(landed, left)).toBe(1);
    expect(opsOf(landed, left)).toEqual([["shaders/rclamp-12/muted", true]]);
  });
});

describe("adding a sketch", () => {
  const aurora = () => drafts.add({ sketchId: "s1", sketchName: "Aurora", branch: "main", home: [1, 2], mask: [64] });
  const rain = () => drafts.add({ sketchId: "s2", sketchName: "Rain", branch: "ada/try", home: [1], mask: [2, 64] });
  const built = { id: "b1", commit: "abc1234def", state: "built" as const, error: null };
  const poolOf = (key: string) => currentDraft().added.find((a) => a.key === key)!.pool;

  it("goes on top, the latest topmost, each counted once", () => {
    const first = aurora();
    const second = rain();
    expect(keys()).toEqual([second, first, "rclamp-12", "rclamp-11"]);
    expect(pendingCount(live, currentDraft())).toBe(2);
    const [top] = layersOf(live, currentDraft());
    expect(top).toMatchObject({ name: "Rain", mask: [2, 64], script: "", adding: { sketchId: "s2" } });
    expect(reachOf(top!)).toEqual([1]);
  });

  it("has a pool of its own from the start, and no params until its preview says what it declares", () => {
    const first = aurora();
    const second = rain();
    expect(poolOf(first)).toMatch(/^[0-9a-f-]{36}$/);
    expect(poolOf(first)).not.toBe(poolOf(second));
    expect(layerOf(live, currentDraft(), first)).toMatchObject({ pool: poolOf(first), params: null });
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

  it("goes in on its home, from its branch, with its pool: as the build previewed, or the branch's head if none was asked for yet", async () => {
    const first = aurora();
    drafts.built(first, built, "function update() {}");
    const second = rain();
    await applyDraft(live);
    // The lowest first.
    expect(ops()).toEqual([
      [`shaders/${first}`, { sketch: "s1", branch: "main", build: "b1", home: [1, 2], muted: false, mask: [64], pool: expect.any(String) }],
      [`shaders/${second}`, { sketch: "s2", branch: "ada/try", home: [1], muted: false, mask: [2, 64], pool: expect.any(String) }],
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("is switched like any other, and goes in that way", async () => {
    const key = aurora();
    const pool = poolOf(key);
    drafts.patchShader(key, { mask: [2, 64] });
    expect(layersOf(live, currentDraft())[0]!.mask).toEqual([2, 64]);
    // Still one change.
    expect(pendingCount(live, currentDraft())).toBe(1);
    drafts.patchShader(key, { muted: true });
    await applyDraft(live);
    expect(ops()).toEqual([[`shaders/${key}`, { sketch: "s1", branch: "main", home: [1, 2], muted: true, mask: [2, 64], pool }]]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("has the params its preview says it declares, set like any other's, and goes in with them in its pool", async () => {
    const key = aurora();
    const pool = poolOf(key);
    drafts.declared(key, [speed]);
    expect(layerOf(live, currentDraft(), key)!.params).toEqual({ declared: [speed], values: {} });
    // Said again, the same: the draft's as it was.
    const before = currentDraft();
    drafts.declared(key, [speed]);
    expect(currentDraft()).toBe(before);
    drafts.setParam(key, "speed", [
      [1, 9],
      [2, 7],
    ]);
    expect(layerOf(live, currentDraft(), key)!.params!.values).toEqual({ speed: [[9, [1]]] });
    await applyDraft(live);
    // What it declares, and the values set (2 is at the default: nothing to send).
    expect(ops()).toEqual([
      [`shaders/${key}`, { sketch: "s1", branch: "main", home: [1, 2], muted: false, mask: [64], pool }],
      [`pools/${pool}/declared`, [speed]],
      [`pools/${pool}/values/speed/1`, 9],
    ]);
  });

  it("goes in where you put it, just above the one under it, the lowest first", async () => {
    const first = aurora();
    const second = rain();
    const [p1, p2] = [poolOf(first), poolOf(second)];
    // Rain under the rest; Aurora between the room's two.
    drafts.reorder(["rclamp-12", first, "rclamp-11", second]);
    expect(pendingCount(live, currentDraft())).toBe(2);
    await applyDraft(live);
    expect(ops()).toEqual([
      [`shaders/${second}`, { sketch: "s2", branch: "ada/try", home: [1], muted: false, mask: [2, 64], above: "", pool: p2 }],
      [`shaders/${first}`, { sketch: "s1", branch: "main", home: [1, 2], muted: false, mask: [64], above: "rclamp-11", pool: p1 }],
    ]);
  });

  it("goes in above another you're adding, by that one's key; and the stack's sent with them", async () => {
    const first = aurora();
    const second = rain();
    const [p1, p2] = [poolOf(first), poolOf(second)];
    drafts.reorder([first, second, "rclamp-11", "rclamp-12"]);
    await applyDraft(live);
    expect(ops()).toEqual([
      [`shaders/${second}`, { sketch: "s2", branch: "ada/try", home: [1], muted: false, mask: [2, 64], above: "rclamp-11", pool: p2 }],
      [`shaders/${first}`, { sketch: "s1", branch: "main", home: [1, 2], muted: false, mask: [64], above: second, pool: p1 }],
      ["stack", [first, second, "rclamp-11", "rclamp-12"]],
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
    expect(ops().filter(([path]) => path.startsWith("shaders/+"))).toHaveLength(1);
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
    failOn = (op) => op[0].startsWith("shaders/+");
    await expect(applyDraft(live)).rejects.toThrow("arclamp said no");
    expect(currentDraft().added).toMatchObject([{ sketchId: "s1" }]);
  });

  it("comes out of the draft once it's in, though the update stops after it", async () => {
    const key = aurora();
    drafts.patchShader("rclamp-12", { muted: true });
    failOn = (op) => op[0].endsWith("/muted");
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

describe("what's changed, shader by shader", () => {
  const fp = room(shader(12, { footprint: [1, 2] }), shader(11, { footprint: [2, 3] }));

  it("has nothing for a shader with nothing pending, or an edit that matches what's live", () => {
    drafts.patchShader("rclamp-11", { muted: false });
    expect(changesByLayer(fp, currentDraft()).size).toBe(0);
  });

  it("has each changed shader's own lights, which the room's are all of", () => {
    drafts.patchShader("rclamp-12", { mask: [2] });
    drafts.patchShader("rclamp-11", { muted: true });
    const by = changesByLayer(fp, currentDraft());
    expect(by.get("rclamp-12")).toEqual([2]);
    expect(by.get("rclamp-11")).toEqual([2, 3]);
    expect(changedLights(fp, currentDraft())).toEqual([2, 3]);
  });

  it("has one taken out, or moved in the stack, on all it reaches", () => {
    drafts.remove("rclamp-12");
    expect([...changesByLayer(fp, currentDraft())]).toEqual([["rclamp-12", [1, 2]]]);
    drafts.discard();
    drafts.reorder(["rclamp-11", "rclamp-12"]);
    expect(changesByLayer(fp, currentDraft()).get("rclamp-11")).toEqual([2, 3]);
  });

  it("has a change even when it changes no lights", () => {
    drafts.patchShader("rclamp-9", { muted: true });
    const none = room(shader(9));
    expect(changesByLayer(none, currentDraft()).get("rclamp-9")).toEqual([]);
  });
  it("has a color's lights, however much of each color changes (its numbers are paths of their own)", () => {
    const tint: ParamSpec = { kind: "color", name: "tint", label: "Tint", lights: {}, default: { a: 0, b: 0, lm: 300, fidelity: 1 } };
    const colored = withPools(room(shader(12, { pool: "p1" })), { p1: { declared: [tint], values: { tint: {} } } });
    drafts.setParam("rclamp-12", "tint", [
      [3, { a: 0.5, b: 0, lm: 300, fidelity: 1 }],
      [1, { a: 0, b: 0.2, lm: 40, fidelity: 1 }],
    ]);
    expect(changesByLayer(colored, currentDraft()).get("rclamp-12")).toEqual([1, 3]);
  });
});
