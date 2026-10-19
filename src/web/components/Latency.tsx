// Admin mode's readout of the live stream's timing: how far the map runs
// behind the room, and whether frames get here in time for that. Each bar is
// a second, as tall as the latest frame to arrive in it; the line is the
// delay. A frame that arrives after it was due makes the map hold the last
// one, and its second turns amber.

import { useEffect, useState } from "react";
import { liveTiming } from "../live.ts";
import type { PlayoutStats } from "../playout.ts";

const SECONDS = 30;
const STEP = 2; // px a second
const WIDTH = SECONDS * STEP;
const HEIGHT = 20;

export function Latency() {
  const [seconds, setSeconds] = useState<PlayoutStats[]>([]);
  useEffect(() => {
    liveTiming(); // count from now
    const t = window.setInterval(() => setSeconds((s) => [...s.slice(1 - SECONDS), liveTiming()]), 1000);
    return () => window.clearInterval(t);
  }, []);

  const delay = seconds.at(-1)?.delay ?? null;
  const late = seconds.reduce((n, s) => n + s.late, 0);
  // A quarter to spare over the tallest, so the line never rides the top edge.
  const top = 1.25 * Math.max(100, ...seconds.flatMap((s) => [s.delay ?? 0, s.worst ?? 0]));
  const y = (ms: number) => (HEIGHT - (ms / top) * HEIGHT).toFixed(1);
  const x0 = WIDTH - seconds.length * STEP;
  let line = "";
  seconds.forEach((s, i) => {
    if (s.delay === null) return;
    line += `${line ? "L" : "M"}${x0 + i * STEP} ${y(s.delay)}H${x0 + (i + 1) * STEP}`;
  });

  return (
    <div
      className="latency"
      title="How far the map runs behind the room. Bars: the latest frame to arrive each second; amber ones came too late, and the map held its last frame. In a still room vibes sends a frame a second, so the delay waits for the lights to change."
    >
      <span className="label">Map delay</span>
      <span className="latency-value mono">{delay === null ? "–" : `${Math.round(delay)} ms`}</span>
      <svg width={WIDTH} height={HEIGHT} role="img" aria-label={`Frames late in the last ${SECONDS} seconds: ${late}`}>
        {seconds.map(
          (s, i) =>
            s.worst !== null && (
              <rect key={i} className={s.late > 0 ? "late" : undefined} x={x0 + i * STEP} y={y(s.worst)} width={STEP - 0.5} height={HEIGHT - Number(y(s.worst))} />
            ),
        )}
        <path d={line} />
      </svg>
      <span className={late > 0 ? "latency-late mono late" : "latency-late mono"}>{late === 0 ? "none late" : `${late} late`}</span>
    </div>
  );
}
