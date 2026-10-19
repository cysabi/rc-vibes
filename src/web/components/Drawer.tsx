// The map's bottom edge: lights that aren't on the map yet, and whatever sits
// in the bottom-right corner (the floors, scale and zoom). A small card in the
// bottom-left corner opens and closes a sheet of the lights, which grows up
// from the bottom edge with the card and corner riding above it. Drag a light
// onto the plan to place it; in Edit lights, drag a light from the map onto the
// drawer to take it off. Hidden when every light is placed.

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { LightInfo } from "../../shared/arclamp.ts";
import { baseType, seenOf } from "../../shared/fixtures.ts";
import { lemtoneCss } from "../../shared/lemtone.ts";
import { screenGamut } from "../gamut.ts";
import { ChevronUpIcon } from "../icons.tsx";
import { useFrames } from "../live.ts";

// More than this and the drawer starts closed, so it doesn't cover the map.
const OPEN_UP_TO = 12;

const GROUPS = [
  { base: "br30", title: "Color bulbs" },
  { base: "4x1", title: "4×1 panels" },
  { base: "relay", title: "Old bulbs" },
];

interface Props {
  lights: LightInfo[];
  /** A light was let go at this screen point (the map decides whether it's on the plan). */
  onDrop: (id: number, clientX: number, clientY: number) => void;
  /** The bottom-right corner's contents. */
  children?: ReactNode;
  /** In the bottom-left corner, after the drawer's own card. */
  lead?: ReactNode;
}

export function Drawer({ lights, onDrop, children, lead }: Props) {
  // Until someone opens or closes it, open only if it's short.
  const [chosen, setOpen] = useState<boolean | null>(null);
  const open = chosen ?? lights.length <= OPEN_UP_TO;
  const [ghost, setGhost] = useState<{ id: number; x: number; y: number; color: string } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // Keep the swatches roughly in step with the lights.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [open]);
  const frame = useFrames().latest();
  const colorOf = (l: LightInfo) => lemtoneCss(seenOf(frame?.lights.get(l.id), l.type), screenGamut());
  const groups = [
    ...GROUPS,
    ...[...new Set(lights.map((l) => baseType(l.type)))].filter((b) => !GROUPS.some((g) => g.base === b)).map((b) => ({ base: b, title: b })),
  ]
    .map((g) => ({ ...g, lights: lights.filter((l) => baseType(l.type) === g.base) }))
    .filter((g) => g.lights.length > 0);

  const handlers = (l: LightInfo) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, y: e.clientY };
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && (ghost || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 4)) {
        setGhost({ id: l.id, x: e.clientX, y: e.clientY, color: colorOf(l) });
      }
    },
    onPointerUp: (e: PointerEvent) => {
      start.current = null;
      if (ghost) onDrop(l.id, e.clientX, e.clientY);
      setGhost(null);
    },
    onPointerCancel: () => {
      start.current = null;
      setGhost(null);
    },
  });


  return (
    <div className="map-bottom">
      <div className="map-bottom-row">
        {lights.length > 0 && (
          <button
            className={open ? "drawer drawer-tab open" : "drawer drawer-tab"}
            aria-expanded={open}
            aria-controls="drawer-sheet"
            aria-label={`${lights.length} ${lights.length === 1 ? "light isn't" : "lights aren't"} on the map`}
            onClick={() => setOpen(!open)}
          >
            <span className="drawer-tab-count mono">{lights.length}</span>
            <span>not on the map</span>
            <span className="drawer-tab-action" aria-hidden="true">
              <ChevronUpIcon />
            </span>
          </button>
        )}
        {lead}
        <span className="spacer" />
        {children}
      </div>
      {lights.length > 0 && (
        // Always rendered, so opening and closing can animate; inert while closed.
        <div id="drawer-sheet" className={open ? "drawer drawer-sheet open" : "drawer drawer-sheet"} inert={!open}>
          <div className="drawer-sheet-inner">
            <div className="drawer-body">
              <p className="hint">Drag a light onto the plan to place it.</p>
              {groups.map((g) => (
                <section key={g.base}>
                  <h3 className="label">{g.title}</h3>
                  <div className="drawer-lights">
                    {g.lights.map((l) => (
                      <button key={l.id} className="drawer-light mono" title={`Light ${l.id}`} {...handlers(l)}>
                        <span className="dot" style={{ background: colorOf(l) }} />
                        {l.id}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
      {ghost && (
        <div className="drag-ghost mono" style={{ left: ghost.x, top: ghost.y }}>
          <span className="dot" style={{ background: ghost.color }} />
          {ghost.id}
        </div>
      )}
    </div>
  );
}
