// Admin mode's readout of how well this page knows arclamp's time (rtime.ts),
// beside the map's delay: at most how far off it might be, in all, and of
// that, this page from vibes and vibes from arclamp; and how far this
// machine's own clock is from arclamp's (what it's put right by).

import { useTimeSync } from "../rtime.ts";

const ms = (v: number) => `${v.toFixed(1)} ms`;

export function ClockSync() {
  const s = useTimeSync();
  const total = s.error === null ? null : s.error + (s.vibesError ?? 0);
  return (
    <div
      className="latency clock-sync"
      role="group"
      aria-label="How near this page is to the room's time (arclamp's), which the show clock and every press are in: at most this far off, this page from vibes and vibes from arclamp, as each last measured it. Below, how far this machine's own clock is from arclamp's."
    >
      <span className="label">Clock</span>
      <span className="latency-value mono">{total === null ? "–" : `±${ms(total)}`}</span>
      <span className="latency-late mono clock-parts">
        page {s.error === null ? "–" : `±${ms(s.error)}`} · vibes {s.vibesError === null ? "–" : `±${ms(s.vibesError)}`}
      </span>
      <span className="latency-late mono">{s.offset === null ? "not yet" : `${s.offset >= 0 ? "+" : "−"}${ms(Math.abs(s.offset))} off`}</span>
    </div>
  );
}
