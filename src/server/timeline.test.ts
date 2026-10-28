import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ChangeEvent } from "../shared/params.ts";
import type { Schedule } from "./arclamp.ts";
import { applyCode, createTimeline, frameOf } from "./timeline.ts";

const T = 1_800_000_000_003;
const change = (name: string, v: number): ChangeEvent => ({ name, set: [[v, [1]]] });

/** A stand-in arclamp: each statement put off, kept; each answered when `release` says (at once by default). */
function fakeArclamp() {
  const sent: { shaderId: number; code: string; schedule: Schedule }[] = [];
  const waits: (() => void)[] = [];
  let hold = false;
  let fail: Error | null = null;
  return {
    sent,
    holdAnswers: () => void (hold = true),
    release: () => waits.shift()?.(),
    failWith: (err: Error | null) => void (fail = err),
    arclamp: {
      evalAt: (shaderId: number, code: string, schedule: Schedule) => {
        sent.push({ shaderId, code, schedule });
        if (fail) return Promise.reject(fail);
        if (!hold) return Promise.resolve(true);
        return new Promise<boolean>((done) => waits.push(() => done(true)));
      },
    },
  };
}

/** What a statement does to a sketch's library: the events it's told, in order (none without one). */
function applied(code: string, withLibrary = true): unknown[] {
  const told: unknown[] = [];
  const globalThis: Record<string, unknown> = withLibrary ? { __vibes: { apply: (event: string, data: unknown) => told.push([event, data]) } } : {};
  runInNewContext(code, { globalThis });
  return told;
}

describe("the timeline", () => {
  it("puts a shader's changes made together in one statement, in order, at the earliest frame it can take", async () => {
    const f = fakeArclamp();
    const timeline = createTimeline({ arclamp: f.arclamp, rNow: () => T, lead: 20 });
    const frames = await Promise.all([timeline.soon(3, change("hue", 0.1)), timeline.soon(3, change("hue", 0.2)), timeline.soon(3, change("speed", 2))]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.shaderId).toBe(3);
    expect(f.sent[0]!.schedule).toEqual({ at: frameOf(T + 20) });
    expect(frames).toEqual([frameOf(T + 20), frameOf(T + 20), frameOf(T + 20)]);
    expect(applied(f.sent[0]!.code)).toEqual([
      ["change", change("hue", 0.1)],
      ["change", change("hue", 0.2)],
      ["change", change("speed", 2)],
    ]);
  });

  it("sends one shader's changes one at a time, in order, each at the frame it goes in with", async () => {
    const f = fakeArclamp();
    let now = T;
    const timeline = createTimeline({ arclamp: f.arclamp, rNow: () => now, lead: 20 });
    f.holdAnswers();
    const first = timeline.soon(3, change("hue", 0.1));
    await new Promise((r) => setImmediate(r));
    const second = timeline.soon(3, change("hue", 0.2));
    const other = timeline.soon(4, change("hue", 0.9));
    await new Promise((r) => setImmediate(r));
    // The other shader's goes at once; this one's second waits for its first.
    expect(f.sent.map((s) => s.shaderId)).toEqual([3, 4]);
    now = T + 35;
    f.release();
    f.release();
    await first;
    await other;
    await new Promise((r) => setImmediate(r));
    expect(f.sent.map((s) => s.shaderId)).toEqual([3, 4, 3]);
    expect(f.sent[2]!.schedule.at).toBe(frameOf(T + 35 + 20));
    f.release();
    expect(await second).toBe(frameOf(T + 55));
  });

  it("puts what comes while a send is on its way in the next one, together: a fast drag coalesces", async () => {
    const f = fakeArclamp();
    const timeline = createTimeline({ arclamp: f.arclamp, rNow: () => T });
    f.holdAnswers();
    const first = timeline.soon(3, change("hue", 0.1));
    await new Promise((r) => setImmediate(r));
    const later = [0.2, 0.3, 0.4].map((v) => timeline.soon(3, change("hue", v)));
    await new Promise((r) => setImmediate(r));
    expect(f.sent).toHaveLength(1);
    f.release();
    await first;
    await new Promise((r) => setImmediate(r));
    expect(f.sent).toHaveLength(2);
    expect(applied(f.sent[1]!.code)).toEqual([0.2, 0.3, 0.4].map((v) => ["change", change("hue", v)]));
    f.release();
    await Promise.all(later);
  });

  it("says when a change couldn't go, for the caller to send another way", async () => {
    const f = fakeArclamp();
    const timeline = createTimeline({ arclamp: f.arclamp, rNow: () => T });
    f.failWith(new Error("arclamp unreachable"));
    await expect(timeline.soon(3, change("hue", 0.1))).rejects.toThrow("unreachable");
    // And the next goes as ever.
    f.failWith(null);
    await expect(timeline.soon(3, change("hue", 0.2))).resolves.toBeGreaterThan(T);
  });

  it("makes a statement that's only data, and that does nothing where there's no library", () => {
    const sly = { name: 'x"); throw 1; ("', set: [[1, [1]]] } as ChangeEvent;
    expect(applied(applyCode([sly]))).toEqual([["change", sly]]);
    expect(applied(applyCode([change("hue", 0.5)]), false)).toEqual([]);
  });
});
