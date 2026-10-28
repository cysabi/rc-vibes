import { useState, type PointerEvent } from "react";
import { useOthers, type Other } from "../presence.ts";
import { Avatar } from "./Avatar.tsx";
import { Tooltip } from "./Tooltip.tsx";

// More than this, and the rest are a count.
const SHOWN = 5;

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** What someone's up to, under their name. */
function doing(o: Other): string {
  if (o.floors.length === 0) return "not at the map";
  const floors = o.floors.length === 1 ? `floor ${o.floors[0]}` : `floors ${[...o.floors].sort((a, b) => a - b).join(", ")}`;
  return o.selected.size > 0 ? `${count(o.selected.size, "light")} selected, ${floors}` : `on ${floors}`;
}

/** Everyone else here, as a row of avatars each ringed in their color (as their selections are on the map); hovered, who and what they're up to. */
export function OthersHere() {
  const others = useOthers();
  const [tip, setTip] = useState<{ x: number; y: number; others: Other[] } | null>(null);
  if (others.length === 0) return null;
  const shown = others.length > SHOWN + 1 ? others.slice(0, SHOWN) : others;
  const rest = others.slice(shown.length);
  const hover = (list: Other[]) => (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.bottom + 8, others: list });
  };
  return (
    <span className="others" aria-label={`Also here: ${others.map((o) => o.person.name).join(", ")}`} onPointerLeave={() => setTip(null)}>
      {shown.map((o) => (
        <span key={o.person.id} className="other" onPointerEnter={hover([o])}>
          <Avatar name={o.person.name} color={o.color} />
        </span>
      ))}
      {rest.length > 0 && (
        <span className="other" onPointerEnter={hover(rest)}>
          <span className="avatar others-more" aria-hidden="true">
            +{rest.length}
          </span>
        </span>
      )}
      {tip && (
        <Tooltip x={tip.x} y={tip.y} side="below" fixed className="others-tip">
          {tip.others.map((o) => (
            <span key={o.person.id} className="others-tip-row">
              <span className="others-tip-dot" style={{ background: o.color }} />
              <span className="tooltip-title">{o.person.name}</span>
              <span className="others-tip-doing">{doing(o)}</span>
            </span>
          ))}
        </Tooltip>
      )}
    </span>
  );
}
