// show: the show clock, one for the room, as vibes runs it: where the piece
// is, in seconds, and whether it's running; and, once someone's set a
// tempo (typed, tapped, or synced to a downbeat), the beats and bars going
// by. Every sketch reads it at its frame's own time, so all of them agree,
// to the frame, where the piece is and which beat it's on.
//
//   const t = show.time;
//   export const update = sketch((here) => (t(here) < 40 ? intro(here) : verse(here)));
//
//   const beat = show.beat;
//   export const update = sketch((here) => white.at(800 * (1 - (beat(here) % 1))));
//
// show.clock is the same tempo as a clock (signal.ts), for its marks: a
// flash on each beat, a new look each bar, as clock(96) would, on the room's.
//
//   const hit = show.clock.every(1).env({ release: 0.4 });
//   const look = show.clock.every(4).seq([palettes.dusk, palettes.sea]);
//
// It comes from vibes on the sketch's stream, as its params do (param.ts),
// when the stream opens and each time it changes; between, it runs on by
// itself. With no show on, it rests: playing, at 120 beats a minute, on a
// beat every sketch shares. Till vibes has said (or with no stream: a sketch
// run elsewhere), it rests too, the piece starting with the sketch.

import { field, type Field } from "./field.ts";
import { heardClock } from "./param.ts";
import { beatClock, type Clock } from "./signal.ts";
import { BEATS_PER_BAR, beatAt, RESTING_BPM, timeAt } from "./wire.ts";

export interface Show {
  /** Where the piece is, in seconds. */
  readonly time: Field<number>;
  /** Whether the piece is running. */
  readonly playing: Field<boolean>;
  /** Beats gone by, counting up smoothly (2.5 is halfway from the third to the fourth), playing or not; 0 with no tempo. */
  readonly beat: Field<number>;
  /** Bars gone by (4 beats each), counting up the same way: a whole number is a downbeat. */
  readonly bar: Field<number>;
  /** The tempo, in beats a minute; 0 with none. */
  readonly bpm: Field<number>;
  /** The tempo as a clock (clock()'s every, env, seq), on the room's beats: still, with none. */
  readonly clock: Clock;
}

// Till vibes has said: resting, on the grid vibes rests on, from 1970.
const beat = field(({ now }) => {
  const c = heardClock();
  return c ? beatAt(c, now) : (now * RESTING_BPM) / 60_000;
});
const bpmNow = () => {
  const c = heardClock();
  return c ? (c.bpm ?? 0) : RESTING_BPM;
};

export const show: Show = {
  time: field(({ now, t }) => {
    const c = heardClock();
    return c ? timeAt(c, now) : t;
  }),
  playing: field(() => heardClock()?.playing ?? true),
  beat,
  bar: field((here) => beat(here) / BEATS_PER_BAR),
  bpm: field(bpmNow),
  clock: beatClock(beat, bpmNow),
};
