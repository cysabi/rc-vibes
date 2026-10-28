// Some lights, said one way everywhere: a line for each kind (color bulb,
// panel, old bulb), each with the light it's making now. One light, a dot in
// its color, its kind, and its id ("● color bulb #12"); more, a pill of their
// colors, and how many of the kind ("▬ 12 color bulbs"). The map's tooltip (a
// light under the pointer, or a box being dragged out) and each layer's row
// in the layers panel use it.

import { useEffect, useState } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { baseType, seenOf } from "../../shared/fixtures.ts";
import { lemtoneCss } from "../../shared/lemtone.ts";
import { useGamut } from "../display.ts";
import { useFrames } from "../live.ts";

// Each kind's name, in the order they're listed.
const KINDS: [type: string, one: string, many: string][] = [
  ["br30", "color bulb", "color bulbs"],
  ["4x1", "panel", "panels"],
  ["relay", "old bulb", "old bulbs"],
];
// The most lights a pill shows.
const PILL_MAX = 24;
// How often the colors are kept up.
const TICK_MS = 250;

const kindOrder = (type: string) => {
  const i = KINDS.findIndex(([t]) => t === type);
  return i < 0 ? KINDS.length : i;
};

/**
 * A line for each kind of these lights, in their colors now (kept up while
 * it's shown). A pill's slices are each 6px wide, whatever
 * its size; `size` is how tall, for the text beside them: "small" (the map's
 * tooltips) or "large" (a layer's Domain).
 */
export function LightsSummary({ lights, size = "large" }: { lights: readonly Pick<LightInfo, "id" | "type">[]; size?: "small" | "large" }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  const gamut = useGamut();
  const frame = useFrames().latest();
  const color = (l: Pick<LightInfo, "id" | "type">) => lemtoneCss(seenOf(frame?.lights.get(l.id), l.type), gamut);

  const byKind = new Map<string, Pick<LightInfo, "id" | "type">[]>();
  for (const l of lights) {
    const kind = baseType(l.type);
    byKind.set(kind, [...(byKind.get(kind) ?? []), l]);
  }
  const kinds = [...byKind].sort(([a], [b]) => kindOrder(a) - kindOrder(b));
  return (
    <span className={`lights-summary ${size}`}>
      {kinds.map(([kind, ls]) => {
        const [, one, many] = KINDS.find(([t]) => t === kind) ?? [kind, kind, kind];
        return (
          <span key={kind} className="lights-summary-line">
            {ls.length === 1 ? (
              <span className="dot" style={{ background: color(ls[0]!) }} />
            ) : (
              // A slice for each light, 6px each.
              <span className="slivers" aria-hidden="true">
                {ls.slice(0, PILL_MAX).map((l) => (
                  <span key={l.id} style={{ background: color(l) }} />
                ))}
              </span>
            )}
            {ls.length === 1 ? `${one} #${ls[0]!.id}` : `${ls.length} ${many}`}
          </span>
        );
      })}
    </span>
  );
}
