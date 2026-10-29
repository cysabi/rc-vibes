import { beforeEach, describe, expect, it } from "vitest";
import type { Op } from "../shared/live.ts";
import { restingClock, type ShowClock } from "../shared/show.ts";
import type { Me } from "../shared/vibes.ts";
import { openDb, type Db } from "./db.ts";
import { Refused } from "./shaders.ts";
import { createShow } from "./show.ts";

const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const T = 1_800_000_000_000;

describe("the show, as vibes keeps it", () => {
  let db: Db;
  let published: Op[];
  let told: ShowClock[];
  let now: number;
  const make = () => createShow({ db, publish: (ops) => published.push(...ops), rNow: () => now, onClock: (c) => told.push(c) });
  const refused = (show: ReturnType<typeof make>, a: Parameters<ReturnType<typeof make>["act"]>[0]) => {
    try {
      show.act(a, ada);
      return null;
    } catch (err) {
      return err instanceof Refused ? err.code : "thrown";
    }
  };

  beforeEach(() => {
    db = openDb(":memory:");
    published = [];
    told = [];
    now = T;
  });

  it("starts with no show on, resting", () => {
    expect(make().clock()).toEqual(restingClock(T));
    expect(make().tree()).toEqual({ on: false, clock: restingClock(T), cue: "now", queued: null });
  });

  it("keeps how scenes come in as the show says, told to everyone; and, not kept, the one waiting for its frame", () => {
    const show = make();
    expect(refused(show, { do: "cue", mode: "bar" })).toBe("no_show");
    show.act({ do: "start", at: T }, ada);
    published = [];
    show.act({ do: "cue", mode: "bar" }, ada);
    expect(show.tree().cue).toBe("bar");
    expect(published).toEqual([["show/cue", "bar"]]);
    show.queue({ scene: "s", frame: T + 2000 });
    expect(published).toContainEqual(["show/queued", { scene: "s", frame: T + 2000 }]);
    // vibes starts again: the cue mode as it was, nothing waiting.
    expect(make().tree()).toMatchObject({ on: true, cue: "bar", queued: null });
  });

  it("takes nothing but a start with no show on", () => {
    const show = make();
    expect(refused(show, { do: "play", at: T })).toBe("no_show");
    expect(refused(show, { do: "nudge", ms: 10 })).toBe("no_show");
    // Ending none: nothing to do.
    expect(refused(show, { do: "end", at: T })).toBeNull();
    expect(published).toEqual([]);
    expect(show.tree().on).toBe(false);
  });

  it("starts a show, for everyone, and ends it, resting again; two starting at once start one", async () => {
    const show = make();
    const started = show.act({ do: "start", at: T + 1000 }, ada);
    expect(started).toMatchObject({ playing: false, t: 0 });
    expect(published).toEqual([
      ["show/on", true],
      ["show/clock", started],
    ]);
    expect(told).toEqual([started]);
    show.act({ do: "play", at: T + 1500 }, ada);
    published = [];
    expect(show.act({ do: "start", at: T + 1600 }, ada)).toEqual(show.clock());
    expect(published).toEqual([]);
    const ended = show.act({ do: "end", at: T + 2000 }, ada);
    expect(ended).toEqual(restingClock(T + 2000));
    expect(published).toEqual([
      ["show/on", false],
      ["show/clock", ended],
    ]);
    expect((await db.activity(10)).map((a) => a.detail)).toEqual([{ do: "end" }, { do: "play" }, { do: "start" }]);
  });

  it("makes each action a new clock, told to every page and sketch, saved, and in the history, a run as one", async () => {
    const show = make();
    show.act({ do: "start", at: T + 20 }, ada);
    published = [];
    told = [];
    const playing = show.act({ do: "play", at: T + 40 }, ada);
    expect(playing).toMatchObject({ playing: true, at: T + 40, t: 0 });
    expect(published).toEqual([["show/clock", playing]]);
    expect(told).toEqual([playing]);
    show.act({ do: "tempo", at: T, bpm: 120, onBeat: true }, ada);
    show.act({ do: "tempo", at: T + 500, bpm: 121, onBeat: true }, ada);
    expect((await db.activity(10)).map((a) => [a.action, a.detail])).toEqual([
      ["show.clock", { do: "tempo", bpm: 121 }],
      ["show.clock", { do: "play" }],
      ["show.clock", { do: "start" }],
    ]);
    // vibes starts again: it carries on, the show still on.
    expect(make().tree()).toEqual(show.tree());
  });

  it("refuses an action from a page whose clock is off, and one out of range", () => {
    const show = make();
    expect(refused(show, { do: "start", at: T + 60_000 })).toBe("bad_time");
    show.act({ do: "start", at: T }, ada);
    published = [];
    const clock = show.clock();
    expect(refused(show, { do: "play", at: T + 60_000 })).toBe("bad_time");
    expect(refused(show, { do: "tempo", at: T, bpm: 5 })).toBe("bad_tempo");
    expect(refused(show, { do: "tempo", at: T, bpm: Number.NaN })).toBe("bad_tempo");
    expect(refused(show, { do: "nudge", ms: 5000 })).toBe("bad_nudge");
    expect(refused(show, { do: "seek", at: T, t: -1 })).toBe("bad_time");
    expect(published).toEqual([]);
    expect(show.clock()).toEqual(clock);
  });

  it("rests if what's saved isn't a show", () => {
    const resting = { on: false, clock: restingClock(T), cue: "now", queued: null };
    db.setSetting("show", '{"on":true,"clock":{"playing":"yes"}}');
    expect(make().tree()).toEqual(resting);
    db.setSetting("show", "not json");
    expect(make().tree()).toEqual(resting);
  });
});
