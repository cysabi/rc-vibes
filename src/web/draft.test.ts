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
  invalidateScene: vi.fn(async () => {}),
}));

const { applyDraft, currentDraft, drafts, EMPTY, layersOf, pendingCount, reorderWithin, roomtoneChanges, templateOf } = await import("./draft.ts");

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
