// The timeline: params' changes to shaders running in the room, through
// arclamp's schedule rather than their streams (params.ts). Each goes in
// with a frame, the earliest the shader can take (now, plus a lead to get
// there), as a statement run in the shader's sandbox before it renders that
// frame: __vibes.apply, the same events the stream carries. So the room
// shows a change in that frame and no other, and anything that knows the
// frame (a page) can show it then too.
//
// A shader's sends go one at a time, in order: a later change never lands
// before an earlier one. Its changes waiting for a send (made together, or
// while the last was on its way) go as one statement, so a drag faster than
// a send takes coalesces rather than queueing up. A send that fails
// (arclamp away, the shader gone or starting over) is the caller's to
// deliver another way; a shader that starts over gets every value when it
// opens its stream again.

import type { ChangeEvent } from "../shared/params.ts";
import type { Arclamp } from "./arclamp.ts";

/** arclamp's frames: every FRAME_MS of its clock. */
export const FRAME_MS = 10;
// How far ahead of now a change is put, to reach arclamp before its frame.
const LEAD_MS = 20;

/** The first frame at or after `ms` (arclamp's time). */
export const frameOf = (ms: number) => Math.ceil(ms / FRAME_MS) * FRAME_MS;

/** The statement that makes these changes, in order. Generated, with JSON for data: nothing anyone typed is ever run. */
export const applyCode = (events: readonly ChangeEvent[]) =>
  `(() => { const v = globalThis.__vibes; if (!v) return; for (const e of ${JSON.stringify(events)}) v.apply("change", e); })()`;

interface TimelineDeps {
  arclamp: Pick<Arclamp, "evalAt">;
  /** arclamp's time now (rclamp-time.ts). */
  rNow: () => number;
  lead?: number;
}

interface Gathering {
  events: ChangeEvent[];
  done: Promise<number>;
  resolve: (frame: number) => void;
  reject: (err: unknown) => void;
}

export function createTimeline({ arclamp, rNow, lead = LEAD_MS }: TimelineDeps) {
  // Each shader's changes waiting to go, and the shaders with a send on its way.
  const gathering = new Map<number, Gathering>();
  const inFlight = new Set<number>();

  function flush(shaderId: number) {
    // One on its way: these go when it's done.
    if (inFlight.has(shaderId)) return;
    const g = gathering.get(shaderId);
    if (!g) return;
    gathering.delete(shaderId);
    inFlight.add(shaderId);
    // Its frame as it goes, not as it was gathered: waiting behind an earlier send doesn't make it late.
    const frame = frameOf(rNow() + lead);
    arclamp
      .evalAt(shaderId, applyCode(g.events), { at: frame })
      .then(() => g.resolve(frame), g.reject)
      .finally(() => {
        inFlight.delete(shaderId);
        flush(shaderId);
      });
  }

  return {
    /**
     * A change to a shader running in the room, at the earliest frame it can
     * take: the frame it went in with, or why it couldn't (the caller's to
     * deliver another way).
     */
    soon(shaderId: number, event: ChangeEvent): Promise<number> {
      let g = gathering.get(shaderId);
      if (!g) {
        let resolve!: (frame: number) => void;
        let reject!: (err: unknown) => void;
        const done = new Promise<number>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        g = { events: [], done, resolve, reject };
        gathering.set(shaderId, g);
        // Whatever else comes in this turn goes with it (or, with a send on its way, whatever comes till that's done).
        if (!inFlight.has(shaderId)) setImmediate(() => flush(shaderId));
      }
      g.events.push(event);
      return g.done;
    },
  };
}

export type Timeline = ReturnType<typeof createTimeline>;
