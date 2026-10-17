import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneNode } from "../shared/vibes.ts";

const calls: string[] = [];
let failOn: string | null = null;
let scene: SceneNode[] = [];

vi.mock("./api.ts", () => ({
  request: vi.fn(async (method: string, path: string, body?: unknown) => {
    const call = `${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`;
    if (method === "GET" && path === "/api/scene") return scene;
    calls.push(call);
    if (failOn && call.startsWith(failOn)) throw new Error("arclamp said no");
    if (method === "POST" && path === "/api/shaders") return { id: 90 + calls.length };
    return {};
  }),
  invalidateScene: vi.fn(async () => {}),
}));

const { applyDraft, currentDraft, drafts, EMPTY, layersOf, pendingCount, roomtoneChanges, templateOf } = await import("./draft.ts");

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
    meta: { name: `S${id}`, createdBy: { id: "rc:1", name: "Ana" }, modifiedBy: { id: "rc:1", name: "Ana" }, seenError: null },
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
  meta: null,
} as SceneNode;

// Live: shader 12 on top of 11.
const live = [roomtone, shader(11, 1), shader(12, 2)];
const keys = (d = currentDraft()) => layersOf(live, d).map((l) => `${l.key}:${l.status}`);

beforeEach(() => {
  drafts.discard();
  calls.length = 0;
  failOn = null;
  scene = live;
});

describe("the stack with pending edits", () => {
  it("shows the live stack, top first, with nothing pending", () => {
    expect(keys()).toEqual(["#12:live", "#11:live"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("puts new shaders on top, and marks edits and deletions in place", () => {
    drafts.createShader("Fresh", "function update(){}", "Rose");
    drafts.patchShader("#11", { script: "function update(){ return {lights:[]} }" });
    drafts.deleteShader("#12");
    expect(keys()).toEqual([expect.stringMatching(/^new-.*:new$/), "#12:deleted", "#11:edited"]);
    expect(pendingCount(live, currentDraft())).toBe(3);
  });

  it("doesn't count an edit that matches what's live", () => {
    drafts.patchShader("#11", { name: "S11", muted: false });
    expect(keys()).toEqual(["#12:live", "#11:live"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
    drafts.patchShader("#11", { muted: true });
    expect(pendingCount(live, currentDraft())).toBe(1);
  });

  it("counts a reorder once, and not once it's back as it was", () => {
    drafts.reorder(["#11", "#12"]);
    expect(keys()).toEqual(["#11:live", "#12:live"]);
    expect(pendingCount(live, currentDraft())).toBe(1);
    drafts.reorder(["#12", "#11"]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("drops a new shader outright when it's deleted, and restores a live one", () => {
    const key = drafts.createShader("Fresh", "function update(){}", "Rose");
    drafts.deleteShader(key);
    drafts.deleteShader("#11");
    drafts.restoreShader("#11");
    expect(currentDraft().created).toEqual([]);
    expect(pendingCount(live, currentDraft())).toBe(0);
  });

  it("shows shaders that turned up live after you reordered, on top", () => {
    drafts.reorder(["#11", "#12"]);
    const later = [...live, shader(13, 3)];
    expect(layersOf(later, currentDraft()).map((l) => l.key)).toEqual(["#13", "#11", "#12"]);
  });

  it("clears the stack by deleting every shader", () => {
    drafts.createShader("Fresh", "function update(){}", "Rose");
    drafts.clearAll(live);
    expect(keys()).toEqual(["#12:deleted", "#11:deleted"]);
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
  it("sends room tone, deletions, edits, new shaders, then the order", async () => {
    drafts.setRoomtone({ "64": { on: 1 } }, "on");
    drafts.deleteShader("#11");
    drafts.patchShader("#12", { name: "Renamed", muted: true });
    drafts.createShader("Fresh", "function update(){}", "Rose");
    // After the deletion and creation, arclamp has 12 under the new 95.
    scene = [roomtone, shader(12, 1), shader(95, 2)];
    await applyDraft(live);
    expect(calls).toEqual([
      'PUT /api/roomtone {"lights":{"64":{"on":1}},"code":"on"}',
      "DELETE /api/shaders/11",
      'PUT /api/shaders/12 {"name":"Renamed"}',
      'POST /api/shaders/12/muted {"muted":true}',
      'POST /api/shaders {"name":"Fresh","script":"function update(){}"}',
    ]);
    expect(currentDraft()).toBe(EMPTY);
  });

  it("moves shaders bottom first when the order changed", async () => {
    drafts.reorder(["#11", "#12"]);
    await applyDraft(live);
    expect(calls).toEqual(['POST /api/shaders/12/position {"position":1}', 'POST /api/shaders/11/position {"position":2}']);
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
