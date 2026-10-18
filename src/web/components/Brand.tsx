// The top of the room tone panel: the wordmark, and a dot glowing with the
// room's color.

import { useEffect, useState } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { seenOf } from "../../shared/fixtures.ts";
import { lookOf, swatch } from "../../shared/lemtone.ts";
import { latestFrame } from "../live.ts";

export function Brand({ lights }: { lights: LightInfo[] }) {
  return (
    <div className="brand">
      <RoomGlow lights={lights} />
      <span className="wordmark">vibes</span>
    </div>
  );
}

/**
 * A dot glowing with the room's average color right now. The color is also
 * set as --room on the page, for anything else that wants to follow the room.
 */
function RoomGlow({ lights }: { lights: LightInfo[] }) {
  const [color, setColor] = useState("rgb(60 56 50)");
  useEffect(() => {
    const t = window.setInterval(() => {
      const frame = latestFrame();
      if (!frame || lights.length === 0) return;
      // The room's average look: each light's color, dimmed by how bright it looks.
      const sum = [0, 0, 0];
      for (const l of lights) {
        const t = seenOf(frame.lights.get(l.id), l.type);
        if (!t) continue;
        const k = lookOf(t.brightness);
        swatch(t.a, t.b).forEach((v, i) => (sum[i]! += v * k));
      }
      const [r, g, b] = sum.map((v) => Math.round(Math.min(1, (v / lights.length) * 1.5) * 255));
      setColor(`rgb(${r} ${g} ${b})`);
    }, 400);
    return () => window.clearInterval(t);
  }, [lights]);
  useEffect(() => {
    document.documentElement.style.setProperty("--room", color);
  }, [color]);
  return <span className="room-glow" aria-hidden="true" />;
}
