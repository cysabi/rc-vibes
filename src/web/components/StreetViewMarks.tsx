// Streetview on the map: a little figure in the corner to drag onto one of
// the places the room was photographed from, and those places themselves,
// each a dot with the cone it saw. The places show while the figure's being
// dragged; while lights are being edited they stay out, and each can be
// dragged to where its camera stood and turned by the tip of its cone.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CameraView, StreetView } from "../../shared/vibes.ts";
import type { View } from "../viewport.ts";

interface Point {
  x: number;
  y: number;
}

/** How near (screen px) the figure has to be dropped to a camera to land on it. */
const LAND_PX = 44;
/** How long a camera's cone is drawn (screen px). */
const CONE_PX = 84;
// A press that moves less than this is a click, not a drag.
const CLICK_PX = 4;

const toScreen = (v: View, mm_x: number, mm_y: number): Point => ({ x: v.ox + mm_x * v.scale, y: v.oy + mm_y * v.scale });
const rad = (deg: number) => (deg * Math.PI) / 180;

/** The camera on this floor the figure would land on at `p` (map px), if any. */
export function cameraAt(cameras: readonly StreetView[], floor: number, view: View, p: Point): StreetView | null {
  let best: StreetView | null = null;
  let bestD = LAND_PX;
  for (const c of cameras) {
    if (c.floor !== floor) continue;
    const s = toScreen(view, c.mm_x, c.mm_y);
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}

const Figure = () => (
  <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">
    <circle cx="11" cy="5" r="4" />
    <path d="M5 23v-8.5a6 6 0 0 1 12 0V23h-3v-7h-1v9h-4v-9h-1v7z" />
  </svg>
);

/**
 * The figure to drag. Reports the pointer while it's dragged (in the map's
 * px, from `map`'s corner), then where it was let go; a click just asks for
 * the places to be shown for a moment.
 */
export function Pegman({ map, onDrag, onDrop, onPoke }: { map: React.RefObject<HTMLElement | null>; onDrag: (p: Point) => void; onDrop: (p: Point) => void; onPoke: () => void }) {
  const start = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const at = (e: ReactPointerEvent): Point => {
    const r = map.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <button
      className="pegman"
      title="Drag onto a camera to see the room from there"
      aria-label="Streetview: drag onto a camera"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY, dragging: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        if (!s.dragging && Math.hypot(e.clientX - s.x, e.clientY - s.y) < CLICK_PX) return;
        s.dragging = true;
        onDrag(at(e));
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (s?.dragging) onDrop(at(e));
        else onPoke();
      }}
      onPointerCancel={() => {
        start.current = null;
        onDrop({ x: -1e6, y: -1e6 });
      }}
    >
      <Figure />
    </button>
  );
}

/** The figure following the pointer, and the cameras on this floor to drop it on (or, while editing, to move). */
export function StreetViewSpots({
  cameras,
  floor,
  view,
  peg,
  shown,
  editing,
  onMove,
}: {
  cameras: readonly StreetView[];
  floor: number;
  view: View;
  /** Where the figure is being dragged, in map px. */
  peg: Point | null;
  /** Show the cameras even without a drag (after a click on the figure). */
  shown: boolean;
  editing: boolean;
  onMove: (id: string, v: CameraView) => void;
}) {
  // A camera being moved or turned, shown where it's going until it's let go.
  const [moving, setMovingState] = useState<{ id: string; v: CameraView } | null>(null);
  // The same, for letting go: a quick drag can end before React's drawn its last move.
  const latest = useRef<{ id: string; v: CameraView } | null>(null);
  const setMoving = (m: { id: string; v: CameraView } | null) => {
    latest.current = m;
    setMovingState(m);
  };
  const grab = useRef<{ id: string; part: "body" | "tip"; from: Point; start: CameraView } | null>(null);
  const here = cameras.filter((c) => c.floor === floor);
  const others = cameras.length - here.length;
  if (!peg && !shown && !editing) return null;
  const hot = peg ? cameraAt(cameras, floor, view, peg) : null;

  const press = (c: StreetView, part: "body" | "tip") => (e: ReactPointerEvent) => {
    if (!editing) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { id: c.id, part, from: { x: e.clientX, y: e.clientY }, start: { floor: c.floor, mm_x: c.mm_x, mm_y: c.mm_y, yaw: c.yaw, hfov: c.hfov } };
  };
  const drag = (e: ReactPointerEvent) => {
    const g = grab.current;
    if (!g) return;
    const s = g.start;
    if (g.part === "body") {
      const v = { ...s, mm_x: Math.round(s.mm_x + (e.clientX - g.from.x) / view.scale), mm_y: Math.round(s.mm_y + (e.clientY - g.from.y) / view.scale) };
      setMoving({ id: g.id, v });
    } else {
      const c = toScreen(view, s.mm_x, s.mm_y);
      const r = (e.currentTarget.closest(".streetview-spots") as HTMLElement).getBoundingClientRect();
      const yaw = (Math.atan2(e.clientY - r.top - c.y, e.clientX - r.left - c.x) * 180) / Math.PI;
      setMoving({ id: g.id, v: { ...s, yaw: Math.round(((yaw % 360) + 360) % 360) } });
    }
  };
  const release = () => {
    const g = grab.current;
    const m = latest.current;
    grab.current = null;
    if (g && m?.id === g.id) onMove(g.id, m.v);
    setMoving(null);
  };

  return (
    <div className={editing ? "streetview-spots editing" : "streetview-spots"} aria-hidden={!editing}>
      {here.map((c) => {
        const v = moving?.id === c.id ? moving.v : c;
        const s = toScreen(view, v.mm_x, v.mm_y);
        const a0 = rad(v.yaw - v.hfov / 2);
        const a1 = rad(v.yaw + v.hfov / 2);
        const tip = { x: Math.cos(rad(v.yaw)) * CONE_PX, y: Math.sin(rad(v.yaw)) * CONE_PX };
        const cone = `M0 0 L${Math.cos(a0) * CONE_PX} ${Math.sin(a0) * CONE_PX} A${CONE_PX} ${CONE_PX} 0 0 1 ${Math.cos(a1) * CONE_PX} ${Math.sin(a1) * CONE_PX} Z`;
        return (
          <svg
            key={c.id}
            className={hot?.id === c.id ? "camera hot" : "camera"}
            style={{ left: s.x, top: s.y }}
            width={CONE_PX * 2 + 24}
            height={CONE_PX * 2 + 24}
            viewBox={`${-CONE_PX - 12} ${-CONE_PX - 12} ${CONE_PX * 2 + 24} ${CONE_PX * 2 + 24}`}
          >
            <path className="camera-cone" d={cone} />
            <circle className="camera-dot" r="7" onPointerDown={press(c, "body")} onPointerMove={drag} onPointerUp={release} onPointerCancel={release}>
              <title>Camera {c.id}{editing ? ": drag to move it" : ""}</title>
            </circle>
            {editing && (
              <circle className="camera-tip" cx={tip.x} cy={tip.y} r="6" onPointerDown={press(c, "tip")} onPointerMove={drag} onPointerUp={release} onPointerCancel={release}>
                <title>Drag to turn camera {c.id}</title>
              </circle>
            )}
          </svg>
        );
      })}
      {peg && (
        <div className={hot ? "pegman-ghost over" : "pegman-ghost"} style={{ left: peg.x, top: peg.y }}>
          <Figure />
        </div>
      )}
      {(peg || shown) && here.length === 0 && others > 0 && (
        <p className="map-note streetview-hint">
          The cameras are on floor {[...new Set(cameras.map((c) => c.floor))].join(" and ")}.
        </p>
      )}
      {shown && !peg && here.length > 0 && <p className="map-note streetview-hint">Drag the figure onto a camera to see the room from there.</p>}
    </div>
  );
}
