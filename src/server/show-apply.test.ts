import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_COLOR } from "../shared/base-color.ts";
import type { Pool } from "../shared/live.ts";
import type { ParamSpec } from "../shared/params.ts";
import type { Scene } from "../shared/scenes.ts";
import type { ShowState } from "../shared/show.ts";
import type { Me, Shader } from "../shared/vibes.ts";
import type { Schedule } from "./arclamp.ts";
import { Refused } from "./shaders.ts";
import { createShowApply } from "./show-apply.ts";
import { applyCode } from "./timeline.ts";

const T = 1_800_000_000_000;
const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 1, min: 0, max: 10, step: 0.1 };
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const shader = (key: string, more: Partial<Shader> = {}) => ({ key, stage: "live", muted: false, pool: null, instance: null, ...more }) as Shader;

describe("a scene applied in a show", () => {
  let state: ShowState;
  let shaders: Record<string, Shader>;
  let pools: Record<string, Pool>;
  let list: Record<string, Scene>;
  let mutes: ({ key: string; muted: boolean } & Schedule)[];
  let evals: ({ shaderId: number; code: string } & Schedule)[];
  let sets: { pool: string; name: string; changes: unknown }[];
  let now: number;
  const apply = createShowApplyFor();

  function createShowApplyFor() {
    return () =>
      createShowApply({
        show: { tree: () => state, queue: (q) => void (state = { ...state, queued: q }) },
        scenes: { get: (id) => list[id] },
        room: () => ({ shaders, stack: Object.keys(shaders), pools }),
        shaders: {
          setMutedAt: async (key, muted, s) => (mutes.push({ key, muted, ...s }), s.at),
          idOf: (key) => ({ a: 11, b: 12 })[key] ?? null,
        },
        arclamp: { evalAt: async (shaderId, code, s) => (evals.push({ shaderId, code, ...s }), true) },
        pools: { set: async (pool, name, changes) => (sets.push({ pool, name, changes }), true) },
        db: { log: () => {} },
        rNow: () => now,
      });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    now = T;
    // 120 BPM, beat 8 at T: a bar's first beat (12) at T + 2000.
    state = { on: true, clock: { playing: true, at: T, t: 0, bpm: 120, beat: 8, nudge: 0 }, cue: "now", queued: null };
    shaders = { a: shader("a", { muted: true, pool: "pa" }), b: shader("b"), base: shader("base", { pool: BASE_COLOR.pool }) };
    pools = { pa: { declared: [speed], values: { speed: { "1": 3 } } } as unknown as Pool };
    const scene = (s: Scene["shaders"]): Scene => ({ name: "s", shaders: s, by: { id: "u", name: "U" }, at: 0 });
    list = { [A]: scene({ a: { speed: { "1": 5 } } }), [B]: scene({ b: {} }) };
    mutes = [];
    evals = [];
    sets = [];
  });
  afterEach(() => vi.useRealTimers());

  const refused = async (p: Promise<unknown>) => p.then(() => null, (err) => (err instanceof Refused ? err.code : "thrown"));

  it("is refused with no show on, no such scene, or none of its sketches in the room", async () => {
    const show = apply();
    expect(await refused(show.apply("00000000-0000-4000-8000-000000000000", T, ada))).toBe("no_such_scene");
    list[B] = { ...list[B]!, shaders: { gone: {} } };
    expect(await refused(show.apply(B, T, ada))).toBe("no_sketch");
    state = { ...state, on: false };
    expect(await refused(show.apply(A, T, ada))).toBe("no_show");
    expect(mutes).toEqual([]);
  });

  it("puts everything it changes in one frame: its sketch on, the rest off but Base Color; its knobs by a statement before that frame; the pools as it comes", async () => {
    const show = apply();
    const frame = await show.apply(A, T, ada);
    expect(frame).toBe(T + 40);
    expect(mutes.map(({ key, muted, at }) => [key, muted, at])).toEqual([
      ["a", false, T + 40],
      ["b", true, T + 40],
    ]);
    expect(evals).toEqual([{ shaderId: 11, code: applyCode([{ name: "speed", set: [[5, [1]]] }]), at: T + 40, id: expect.stringMatching(/^k:/), emplace: undefined }]);
    expect(state.queued).toEqual({ scene: A, frame: T + 40 });
    expect(sets).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(sets).toEqual([{ pool: "pa", name: "speed", changes: [[1, 5]] }]);
    expect(state.queued).toBeNull();
  });

  it("comes in on the next bar's first beat, with the show's cue so", async () => {
    state = { ...state, cue: "bar" };
    expect(await apply().apply(A, T + 250, ada)).toBe(T + 2000);
  });

  it("takes the place of one waiting for its frame, change by change, putting back what only that one would have changed", async () => {
    state = { ...state, cue: "bar" };
    const show = apply();
    await show.apply(A, T + 250, ada);
    const first = new Map(mutes.map((m) => [m.key, m.id]));
    const firstEval = evals[0]!.id;
    mutes = [];
    evals = [];
    await show.apply(B, T + 300, ada);
    // a back off, b on: each in place of A's.
    expect(mutes.map(({ key, muted, emplace }) => [key, muted, emplace])).toEqual([
      ["a", true, first.get("a")],
      ["b", false, first.get("b")],
    ]);
    // a's knob back as it was (3), in place of A's statement.
    expect(evals).toEqual([{ shaderId: 11, code: applyCode([{ name: "speed", set: [[3, [1]]] }]), at: T + 2000, id: expect.stringMatching(/^k:/), emplace: firstEval }]);
    vi.advanceTimersByTime(2000);
    // A's never made it into the pools; B's (putting a's back) did.
    expect(sets).toEqual([{ pool: "pa", name: "speed", changes: [[1, 3]] }]);
    expect(state.queued).toBeNull();
  });

  it("says each change whole, so it ends right even if the room shows the first one in already", async () => {
    state = { ...state, cue: "bar" };
    const show = apply();
    await show.apply(A, T + 250, ada);
    const first = new Map(mutes.map((m) => [m.key, m.id]));
    mutes = [];
    // The feed shows A's mutes at its frame; the second comes in just then.
    shaders = { ...shaders, a: { ...shaders.a!, muted: false }, b: { ...shaders.b!, muted: true } };
    await show.apply(B, T + 300, ada);
    expect(mutes.map(({ key, muted, emplace }) => [key, muted, emplace])).toEqual([
      ["a", true, first.get("a")],
      ["b", false, first.get("b")],
    ]);
  });
});
