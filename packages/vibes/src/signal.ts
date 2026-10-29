// Signals: fields that only read the time, for wiring into any number a field
// or source takes. A clock counts beats; every(n) marks each n-th one, and
// from those come envelopes (a flash on each), sequences (a new value each)
// and ramps (0 to 1 across each).
//
//   const beat = clock(96);
//   osc(4).rotate(beat.every(4).seq([0, 45, 90, 135])).color(palettes.dusk).boost(beat.every(1).env(), 0.8)

import { field, type Field } from "./field.ts";
import { fract } from "./shape.ts";

export interface Every {
  /** How many marks so far: 0, 1, 2, … */
  count: Field<number>;
  /** 0 to 1 from one mark to the next. */
  ramp: Field<number>;
  /** Seconds since the last mark. */
  since: Field<number>;
  /** 0, up to 1 in `attack` seconds after each mark (default 0.01), and back to 0 over `release` (default 0.3). */
  env(options?: { attack?: number; release?: number }): Field<number>;
  /** The next of these at each mark, round and round. */
  seq<T>(list: readonly T[]): Field<T>;
}

export interface Clock {
  readonly bpm: number;
  /** Beats so far (not whole: 2.5 is halfway through the third). */
  beats: Field<number>;
  /** Marks every n beats: every(1) is each beat, every(4) each bar of four. */
  every(n: number): Every;
}

/** A clock at `bpm` beats a minute, starting with the sketch. */
export function clock(bpm: number): Clock {
  const beats = field(({ t }) => (t * bpm) / 60);
  return {
    bpm,
    beats,
    every(n: number): Every {
      const at = (t: number) => (t * bpm) / 60 / n;
      const seconds = (60 / bpm) * n;
      const since = field(({ t }) => fract(at(t)) * seconds);
      return {
        count: field(({ t }) => Math.floor(at(t))),
        ramp: field(({ t }) => fract(at(t))),
        since,
        env({ attack = 0.01, release = 0.3 } = {}) {
          return field((here) => {
            const s = since(here);
            if (s < attack) return s / attack;
            const k = Math.max(0, 1 - (s - attack) / release);
            return k * k;
          });
        },
        seq<T>(list: readonly T[]) {
          if (list.length === 0) throw new Error("seq(): give it at least one value");
          return field(({ t }) => {
            const i = Math.floor(at(t)) % list.length;
            return list[i < 0 ? i + list.length : i]!;
          });
        },
      };
    },
  };
}
