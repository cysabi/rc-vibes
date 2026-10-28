// The show (shared/show.ts): one for the room, kept here, in the live tree
// (show/on, show/clock), and saved, so a vibes that starts again carries on
// with it (arclamp's time goes on meanwhile: a playing piece is further in).
// Pages act on it (show/transport, made by updates.ts); each action is a
// new anchor, told to every page (the tree) and every sketch (onClock: its
// stream, params.ts), and noted in the history, a run of the same action
// (taps, say) as one entry. With no show on, the clock rests, and only
// starting one does anything.

import { MAX_BPM, MAX_NUDGE_MS, MIN_BPM, restingClock, showClock, transported, type ShowClock, type ShowState, type TransportAction } from "../shared/show.ts";
import type { Op } from "../shared/live.ts";
import type { Me } from "../shared/vibes.ts";
import type { Db } from "./db.ts";
import { Refused } from "./shaders.ts";

const KEY = "show";
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
  let show = load();

  function load(): ShowState {
    try {
      const saved = JSON.parse(db.setting(KEY) ?? "null") as Partial<ShowState> | null;
      const clock = showClock(saved?.clock);
      if (clock && typeof saved?.on === "boolean") return { on: saved.on, clock };
    } catch {
      // Rests, as if there'd never been a show.
    }
    return { on: false, clock: restingClock(rNow()) };
  }

  return {
    clock: () => show.clock,

    /** The show, as the live tree has it. */
    tree: (): ShowState => show,

    /** An action on the show: its clock, told to everyone; Refused if it isn't one vibes can make. */
    act(a: TransportAction, user: Me): ShowClock {
      // Two pages starting (or ending) one at once: the second has nothing to do.
      if ((a.do === "start" && show.on) || (a.do === "end" && !show.on)) return show.clock;
      if (a.do !== "start" && !show.on) throw new Refused(409, "no_show", "there's no show on: start one first");
      if (a.do !== "nudge" && Math.abs(a.at - rNow()) > MOST_SKEW_MS) {
        throw new Refused(400, "bad_time", "that happened too far from now: this page's clock is off");
      }
      if (a.do === "tempo" && !(a.bpm >= MIN_BPM && a.bpm <= MAX_BPM)) throw new Refused(400, "bad_tempo", `a tempo is ${MIN_BPM}–${MAX_BPM} beats a minute`);
      if (a.do === "nudge" && !(Math.abs(a.ms) <= MAX_NUDGE_MS)) throw new Refused(400, "bad_nudge", `a nudge is at most ${MAX_NUDGE_MS} ms either way`);
      if (a.do === "seek" && !(a.t >= 0)) throw new Refused(400, "bad_time", "a piece starts at 0");
      const on = a.do === "start" ? true : a.do === "end" ? false : show.on;
      show = { on, clock: transported(show.clock, a) };
      db.setSetting(KEY, JSON.stringify(show));
      publish(a.do === "start" || a.do === "end" ? [["show/on", on], ["show/clock", show.clock]] : [["show/clock", show.clock]]);
      onClock(show.clock);
      const detail: Record<string, unknown> = { do: a.do };
      if (a.do === "tempo") detail.bpm = a.bpm;
      if (a.do === "seek") detail.t = a.t;
      if (a.do === "nudge") detail.ms = a.ms;
      db.logCoalesced({ user, action: "show.clock", detail }, LOG_WINDOW_MS, (last) => last?.do === a.do);
      return show.clock;
    },
  };
}

export type Show = ReturnType<typeof createShow>;
