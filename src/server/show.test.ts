import { beforeEach, describe, expect, it } from "vitest";
import type { Op } from "../shared/live.ts";
import { STOPPED, type ShowClock } from "../shared/show.ts";
import type { Me } from "../shared/vibes.ts";
import { openDb, type Db } from "./db.ts";
import { Refused } from "./shaders.ts";
import { createShow } from "./show.ts";

const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const T = 1_800_000_000_000;

describe("the show clock, as vibes keeps it", () => {
  let db: Db;
  let published: Op[];
  let told: ShowClock[];
  let now: number;
  const make = () => createShow({ db, publish: (ops) => published.push(...ops), rNow: () => now, onClock: (c) => told.push(c) });

  beforeEach(() => {
    db = openDb(":memory:");
    published = [];
    told = [];
    now = T;
  });

  it("starts stopped at 0, with no tempo", () => {
    expect(make().clock()).toEqual(STOPPED);
    expect(make().tree()).toEqual({ clock: STOPPED });
  });

  it("makes each action a new clock, told to every page and sketch, saved, and in the history, a run as one", async () => {
    const show = make();
    const playing = show.act({ do: "play", at: T - 20 }, ada);
    expect(playing).toMatchObject({ playing: true, at: T - 20, t: 0 });
    expect(published).toEqual([["show/clock", playing]]);
    expect(told).toEqual([playing]);
    show.act({ do: "tempo", at: T, bpm: 120, onBeat: true }, ada);
    show.act({ do: "tempo", at: T + 500, bpm: 121, onBeat: true }, ada);
    expect((await db.activity(10)).map((a) => [a.action, a.detail])).toEqual([
      ["show.clock", { do: "tempo", bpm: 121 }],
      ["show.clock", { do: "play" }],
    ]);
    // vibes starts again: it carries on.
    expect(make().clock()).toEqual(show.clock());
  });

  it("refuses an action from a page whose clock is off, and one out of range", () => {
    const show = make();
    const refused = (a: Parameters<typeof show.act>[0]) => {
      try {
        show.act(a, ada);
        return null;
      } catch (err) {
        return err instanceof Refused ? err.code : "thrown";
      }
    };
    expect(refused({ do: "play", at: T + 60_000 })).toBe("bad_time");
    expect(refused({ do: "tempo", at: T, bpm: 5 })).toBe("bad_tempo");
    expect(refused({ do: "tempo", at: T, bpm: Number.NaN })).toBe("bad_tempo");
    expect(refused({ do: "nudge", ms: 5000 })).toBe("bad_nudge");
    expect(refused({ do: "seek", at: T, t: -1 })).toBe("bad_time");
    expect(published).toEqual([]);
    expect(show.clock()).toEqual(STOPPED);
  });

  it("starts stopped if what's saved isn't a clock", () => {
    db.setSetting("show.clock", '{"playing":"yes"}');
    expect(make().clock()).toEqual(STOPPED);
    db.setSetting("show.clock", "not json");
    expect(make().clock()).toEqual(STOPPED);
  });
});
