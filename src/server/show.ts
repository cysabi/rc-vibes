// The show clock (shared/show.ts): one for the room, kept here, in the live
// tree (show/clock), and saved, so a vibes that starts again carries on with
// it (arclamp's time goes on meanwhile: a playing piece is further in).
// Pages act on it (show/transport, made by updates.ts); each action is a
// new anchor, told to every page (the tree) and every sketch (onClock: its
// stream, params.ts), and noted in the history, a run of the same action
// (taps, say) as one entry.

import { MAX_BPM, MAX_NUDGE_MS, MIN_BPM, showClock, STOPPED, transported, type ShowClock, type TransportAction } from "../shared/show.ts";
import type { Op } from "../shared/live.ts";
import type { Me } from "../shared/vibes.ts";
import type { Db } from "./db.ts";
import { Refused } from "./shaders.ts";

const KEY = "show.clock";
// An action this far from arclamp's now (by vibes' reckoning) is a page whose clock is wrong.
const MOST_SKEW_MS = 5_000;
// A run of the same action from one person (taps, nudges) is one entry in the history.
const LOG_WINDOW_MS = 15_000;

interface Deps {
  db: Pick<Db, "setting" | "setSetting" | "logCoalesced">;
  /** Changes to the live tree (live.ts). */
  publish: (ops: Op[]) => void;
  /** arclamp's time now (rclamp-time.ts). */
  rNow: () => number;
  /** Told the clock each time it changes: for every sketch's stream. */
  onClock?: (clock: ShowClock) => void;
}

export function createShow({ db, publish, rNow, onClock = () => {} }: Deps) {
  let clock = load();

  function load(): ShowClock {
    try {
      return showClock(JSON.parse(db.setting(KEY) ?? "null")) ?? STOPPED;
    } catch {
      return STOPPED;
    }
  }

  return {
    clock: () => clock,

    /** The show, as the live tree has it. */
    tree: () => ({ clock }),

    /** An action on the clock: the new clock, told to everyone; Refused if it isn't one vibes can make. */
    act(a: TransportAction, user: Me): ShowClock {
      if (a.do !== "nudge" && Math.abs(a.at - rNow()) > MOST_SKEW_MS) {
        throw new Refused(400, "bad_time", "that happened too far from now: this page's clock is off");
      }
      if (a.do === "tempo" && !(a.bpm >= MIN_BPM && a.bpm <= MAX_BPM)) throw new Refused(400, "bad_tempo", `a tempo is ${MIN_BPM}–${MAX_BPM} beats a minute`);
      if (a.do === "nudge" && !(Math.abs(a.ms) <= MAX_NUDGE_MS)) throw new Refused(400, "bad_nudge", `a nudge is at most ${MAX_NUDGE_MS} ms either way`);
      if (a.do === "seek" && !(a.t >= 0)) throw new Refused(400, "bad_time", "a piece starts at 0");
      clock = transported(clock, a);
      db.setSetting(KEY, JSON.stringify(clock));
      publish([["show/clock", clock]]);
      onClock(clock);
      const detail: Record<string, unknown> = { do: a.do };
      if (a.do === "tempo") detail.bpm = a.bpm;
      if (a.do === "seek") detail.t = a.t;
      if (a.do === "nudge") detail.ms = a.ms;
      db.logCoalesced({ user, action: "show.clock", detail }, LOG_WINDOW_MS, (last) => last?.do === a.do);
      return clock;
    },
  };
}

export type Show = ReturnType<typeof createShow>;
