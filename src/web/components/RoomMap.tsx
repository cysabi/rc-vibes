// The building from above: the current floor's plan over a measuring grid,
// with each light drawn where it is, glowing in the color lemtone says its
// channels make. 4×1 panels are drawn at their real 1 ft × 4 ft size, and the
// rails the bulbs hang on as thin tracks.
//
// Drag to select, ⌘-drag (or middle-drag, or one finger) to pan, scroll or
// pinch to zoom. Click a light to select it; shift adds to the selection and
// ⌘-click toggles one light.
//
// In Move mode, dragging a light moves it (with the rest of the selection, if
// it's selected); near a rail it hangs on it and slides along it. Draw rail
// draws rails along the tracks. Dragging a rail, or either end of it, lines
// it up with its track, and the lights on it come along.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { LightInfo, Rail, RailPoint, RailSpot } from "../../shared/arclamp.ts";
import { baseType, footprintOf, lemtoneOf, orientationsOf } from "../../shared/fixtures.ts";
import { lemtoneCode, lookOf, swatch } from "../../shared/lemtone.ts";
import {
  alongAfterEndMove,
  clampAlong,
  hangsOnRails,
  nearestOnRail,
  newRailId,
  railLength,
  railPoint,
  settleAngle,
  type Point,
  type RailShape,
} from "../../shared/rails.ts";
import type { Placement, Spot, TypeChange } from "../../shared/vibes.ts";
import { useChangeLayout, type LayoutChange } from "../api.ts";
import { FLOORS, planExtent } from "../floors.ts";
import { FitIcon, MinusIcon, PlusIcon } from "../icons.tsx";
import { currentRails, layoutLights, placeLights, type PlacedLight } from "../layout.ts";
import { latestFrame, onFrame } from "../live.ts";
import { fitView, formatLength, gridFor, MAX_SCALE, scaleBar, toPlan, zoomAt, type View } from "../viewport.ts";
import { Drawer } from "./Drawer.tsx";
import { Segmented } from "./Segmented.tsx";

const TYPE_NAMES: Record<string, string> = { br30: "color bulb", "4x1": "4×1 panel", relay: "old bulb" };
// Bulb radius in millimeters (a BR30 is 95 mm across; the old bulbs are A19s).
const BULB_MM: Record<string, number> = { br30: 48, relay: 30 };
const PAD = 56;
// How close (in screen pixels) a dragged light has to come to a rail to hang
// on it, and how far it has to be pulled to come off again.
const SNAP_PX = 14;
const HOLD_PX = 28;
// How close a press has to be to grab a rail, or an end of the selected one.
const RAIL_HIT_PX = 6;
const END_HIT_PX = 9;
// Rail ends being drawn or dragged catch on other rails' ends this close.
const MAGNET_PX = 10;
// Shorter than this, a drawn rail was probably a click.
const MIN_RAIL_MM = 150;

export type SelectMode = "replace" | "add" | "toggle";

interface Props {
  lights: LightInfo[];
  rails: Rail[];
  floor: number;
  onFloor: (floor: number) => void;
  /** Lights and rails changed in vibes but not yet exported to arclamp. */
  changed: number;
  selected: ReadonlySet<number>;
  onSelect: (ids: number[], mode: SelectMode) => void;
}

interface Size {
  width: number;
  height: number;
}

/** Where a dragged light would land: free, or hanging on a rail. */
interface Target extends Point {
  rail: RailSpot | null;
}

type RailPart = "body" | "from" | "to";

interface RailHit {
  id: string;
  part: RailPart;
}

type Drag =
  | { kind: "lights"; grabbed: number; x0: number; y0: number; moved: boolean; from: Map<number, PlacedLight>; to: Map<number, Target> }
  | { kind: "rail"; id: string; part: RailPart; x0: number; y0: number; moved: boolean; before: Rail; after: Rail }
  | { kind: "draw"; rail: Rail };

type Press =
  | { kind: "pan"; x: number; y: number; view: View; hit: PlacedLight | null; panned: boolean; touch: boolean }
  | { kind: "box"; x: number; y: number; hit: PlacedLight | null; add: boolean };

export function RoomMap({ lights, rails, floor, onFloor, changed, selected, onSelect }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useMemo(() => planExtent(), []);
  const [size, setSize] = useState<Size | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [hover, setHover] = useState<PlacedLight | null>(null);
  const [moving, setMoving] = useState(false);
  // While moving: whether a drag draws a rail, and the rail being worked on.
  const [drawing, setDrawing] = useState(false);
  const [railSel, setRailSel] = useState<string | null>(null);
  const [railHover, setRailHover] = useState<RailHit | null>(null);
  // ⌘ (or Ctrl) held: the next drag pans. Shown as a grab cursor.
  const [panKey, setPanKey] = useState(false);
  const [panning, setPanning] = useState(false);
  const change = useChangeLayout();
  const [undo, setUndo] = useState<LayoutChange[]>([]);
  // Changes shown until the server's copy catches up: where lights are (null
  // = off the map), rails (null = taken away) and orientations.
  const [pendingSpot, setPendingSpot] = useState<Map<number, Spot | null>>(new Map());
  const [pendingRails, setPendingRails] = useState<Map<string, RailShape | null>>(new Map());
  const [pendingType, setPendingType] = useState<Map<number, string>>(new Map());
  const dirty = useRef(true);
  const marquee = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const press = useRef<Press | null>(null);
  const drag = useRef<Drag | null>(null);

  // Everything as it is now, pending changes included.
  const railsNow = useMemo(() => currentRails(rails, pendingRails), [rails, pendingRails]);
  const placed = useMemo(
    () => placeLights(lights, railsNow, { spots: pendingSpot, types: pendingType }),
    [lights, railsNow, pendingSpot, pendingType],
  );
  const layout = useMemo(() => layoutLights(placed, railsNow.values(), floor, frame), [placed, railsNow, floor, frame]);
  const shown = layout.lights;
  const unplaced = useMemo(() => {
    const on = new Set(placed.map((l) => l.id));
    return lights.filter((l) => !on.has(l.id));
  }, [lights, placed]);

  // Refs for the draw loop and the native wheel listener.
  const live = useRef({ view, layout, selected, hover, moving, railSel, railHover });
  live.current = { view, layout, selected, hover, moving, railSel, railHover };
  const fitRef = useRef(layout.fit);
  fitRef.current = layout.fit;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    dirty.current = true;
  }, [view, layout, selected, hover, moving, railSel, railHover]);

  // The server's copy has caught up once the lights change; drop the stand-ins.
  useEffect(() => {
    setPendingSpot(new Map());
    setPendingRails(new Map());
    setPendingType(new Map());
  }, [lights, rails]);

  // A rail on another floor, or one that's gone, can't stay selected.
  useEffect(() => {
    if (railSel && railsNow.get(railSel)?.floor !== floor) setRailSel(null);
  }, [railSel, railsNow, floor]);

  const minScale = () => {
    const s = sizeRef.current;
    return s ? fitView(fitRef.current, s.width, s.height, PAD).scale * 0.5 : 0;
  };

  // Size the canvas; fit on first layout, and keep the center on resize.
  useEffect(() => {
    const el = wrap.current!;
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const prev = sizeRef.current;
      const c = canvas.current!;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
      setSize({ width, height });
      setView((v) =>
        v && prev
          ? { ...v, ox: v.ox + (width - prev.width) / 2, oy: v.oy + (height - prev.height) / 2 }
          : fitView(fitRef.current, width, height, PAD),
      );
      dirty.current = true;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Scroll or pinch to zoom around the pointer. Native and non-passive, so the
  // page itself doesn't scroll.
  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(".drawer, .map-tools, .floor-switch, .map-corner")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002));
      const min = minScale();
      setView((v) => v && zoomAt(v, e.clientX - r.left, e.clientY - r.top, factor, min, MAX_SCALE));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => onFrame(() => void (dirty.current = true)), []);

  useEffect(() => {
    const sync = (e: KeyboardEvent) => setPanKey(e.metaKey || e.ctrlKey);
    const clear = () => setPanKey(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = live.current;
      if (dirty.current && s.view && sizeRef.current) {
        dirty.current = false;
        const d = drag.current;
        const { rails, measure } = railsAsDrawn(s.layout.rails, s.railSel, d);
        draw(canvas.current!, {
          size: sizeRef.current,
          view: s.view,
          lights: s.layout.lights,
          spacing: s.layout.spacing,
          positionOf: (l) => positionOf(l, d),
          selected: s.selected,
          hovered: s.hover?.id ?? null,
          box: marquee.current,
          rails,
          railSel: d?.kind === "rail" ? d.id : s.railSel,
          railHover: s.railHover?.id ?? null,
          moving: s.moving,
          measure,
        });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitTest = (x: number, y: number): PlacedLight | null => {
    if (!view) return null;
    let best: PlacedLight | null = null;
    let bestD = Infinity;
    for (const l of shown) {
      const p = positionOf(l, drag.current);
      const dx = view.ox + p.x * view.scale - x;
      const dy = view.oy + p.y * view.scale - y;
      const size = footprintOf(l.type);
      const inside = size
        ? Math.abs(dx) <= (size.width * view.scale) / 2 + 6 && Math.abs(dy) <= (size.height * view.scale) / 2 + 6
        : Math.hypot(dx, dy) <= Math.max(10, (BULB_MM[baseType(l.type)] ?? 40) * view.scale + 6);
      const d = Math.hypot(dx, dy);
      if (inside && d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  };

  /** The selected rail's end under (x, y), else any rail on this floor. */
  const hitRail = (x: number, y: number): RailHit | null => {
    if (!view) return null;
    const at = toPlan(view, x, y);
    const sel = railSel ? railsNow.get(railSel) : undefined;
    if (sel) {
      for (const part of ["from", "to"] as const) {
        if (Math.hypot(sel[part].mm_x - at.x, sel[part].mm_y - at.y) * view.scale <= END_HIT_PX) return { id: sel.id, part };
      }
    }
    let best: RailHit | null = null;
    let bestD = RAIL_HIT_PX / view.scale;
    for (const r of layout.rails) {
      const d = nearestOnRail(r, at.x, at.y).distance;
      if (d <= bestD) {
        best = { id: r.id, part: "body" };
        bestD = d;
      }
    }
    return best;
  };

  /** The nearest rail on this floor within reach of (x, y) in millimeters, and where on it. */
  const snapToRail = (x: number, y: number, holding: string | null): Target | null => {
    if (!view) return null;
    let best: Target | null = null;
    let bestD = Infinity;
    for (const r of layout.rails) {
      const n = nearestOnRail(r, x, y);
      const reach = (r.id === holding ? HOLD_PX : SNAP_PX) / view.scale;
      if (n.distance <= reach && n.distance < bestD) {
        best = { x: n.x, y: n.y, rail: { id: r.id, mm_along: n.along } };
        bestD = n.distance;
      }
    }
    return best;
  };

  /** Another rail's end near (x, y), for rail ends to catch on. */
  const magnet = (p: Point, except: string | null): Point | null => {
    if (!view) return null;
    let best: Point | null = null;
    let bestD = MAGNET_PX / view.scale;
    for (const r of layout.rails) {
      if (r.id === except) continue;
      for (const end of [r.from, r.to]) {
        const d = Math.hypot(end.mm_x - p.x, end.mm_y - p.y);
        if (d <= bestD) {
          best = { x: end.mm_x, y: end.mm_y };
          bestD = d;
        }
      }
    }
    return best;
  };

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    const touch = e.pointerType === "touch";
    const pan = e.button === 1 || (e.button === 0 && (e.metaKey || e.ctrlKey || touch));
    if ((e.button !== 0 && !pan) || !view) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toLocal(e);
    const hit = hitTest(p.x, p.y);
    if (pan) {
      press.current = { kind: "pan", ...p, view, hit, panned: false, touch };
      return;
    }
    if (moving && drawing) {
      const at = toPlan(view, p.x, p.y);
      const start = toRailPoint(magnet(at, null) ?? at);
      drag.current = { kind: "draw", rail: { id: newRailId(), floor, from: start, to: start } };
      setRailSel(null);
      return;
    }
    if (moving && !e.shiftKey) {
      // The selected rail's ends come before lights; lights before rails.
      const end = hitRail(p.x, p.y);
      const target = end && (end.part !== "body" || !hit) ? end : null;
      if (target) {
        const rail = railsNow.get(target.id)!;
        setRailSel(target.id);
        drag.current = { kind: "rail", id: target.id, part: target.part, x0: p.x, y0: p.y, moved: false, before: rail, after: rail };
        setHover(null);
        return;
      }
      if (hit) {
        // Move the whole selection if the grabbed light is in it.
        const group = selected.has(hit.id) ? shown.filter((l) => selected.has(l.id)) : [hit];
        drag.current = {
          kind: "lights",
          grabbed: hit.id,
          x0: p.x,
          y0: p.y,
          moved: false,
          from: new Map(group.map((l) => [l.id, l])),
          to: new Map(group.map((l) => [l.id, { x: l.x, y: l.y, rail: l.rail }])),
        };
        setRailSel(null);
        setHover(null);
        return;
      }
    }
    press.current = { kind: "box", ...p, hit, add: e.shiftKey };
  };

  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = toLocal(e);
    const d = drag.current;
    if (d && view) {
      const at = toPlan(view, p.x, p.y);
      if (d.kind === "draw") {
        const from = { x: d.rail.from.mm_x, y: d.rail.from.mm_y };
        d.rail = { ...d.rail, to: toRailPoint(magnet(at, null) ?? settleAngle(from, at, e.shiftKey)) };
        dirty.current = true;
        return;
      }
      if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) <= 4) return;
      d.moved = true;
      const dx = (p.x - d.x0) / view.scale;
      const dy = (p.y - d.y0) / view.scale;
      if (d.kind === "lights") {
        for (const [id, l] of d.from) {
          const x = l.x + dx;
          const y = l.y + dy;
          d.to.set(id, (hangsOnRails(l.type) && snapToRail(x, y, l.rail?.id ?? null)) || { x, y, rail: null });
        }
      } else if (d.part === "body") {
        const shift = (q: RailPoint) => ({ mm_x: q.mm_x + dx, mm_y: q.mm_y + dy });
        d.after = { ...d.before, from: shift(d.before.from), to: shift(d.before.to) };
      } else {
        const fixed = d.part === "from" ? d.before.to : d.before.from;
        const raw = { x: d.before[d.part].mm_x + dx, y: d.before[d.part].mm_y + dy };
        const end = toRailPoint(magnet(raw, d.id) ?? settleAngle({ x: fixed.mm_x, y: fixed.mm_y }, raw, e.shiftKey));
        d.after = d.part === "from" ? { ...d.before, from: end } : { ...d.before, to: end };
      }
      dirty.current = true;
      return;
    }
    const pr = press.current;
    if (pr?.kind === "pan" && (pr.panned || Math.hypot(p.x - pr.x, p.y - pr.y) > 4)) {
      if (!pr.panned) setPanning(true);
      pr.panned = true;
      setView({ ...pr.view, ox: pr.view.ox + p.x - pr.x, oy: pr.view.oy + p.y - pr.y });
      if (hover) setHover(null);
      return;
    }
    if (pr?.kind === "box" && (marquee.current || Math.hypot(p.x - pr.x, p.y - pr.y) > 4)) {
      marquee.current = { x0: pr.x, y0: pr.y, x1: p.x, y1: p.y };
      dirty.current = true;
      return;
    }
    if (!pr) {
      const hit = hitTest(p.x, p.y);
      if (hit?.id !== hover?.id) setHover(hit);
      const end = moving && !drawing ? hitRail(p.x, p.y) : null;
      const rail = end && (end.part !== "body" || !hit) ? end : null;
      if (rail?.id !== railHover?.id || rail?.part !== railHover?.part) setRailHover(rail);
    }
  };

  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d && view) {
      drag.current = null;
      dirty.current = true;
      if (d.kind === "draw") finishRail(d.rail);
      else if (!d.moved) {
        if (d.kind === "lights") onSelect([d.grabbed], "replace");
      } else if (d.kind === "rail") moveRail(d);
      else if (document.elementFromPoint(e.clientX, e.clientY)?.closest(".drawer")) unplace([...d.from.keys()]);
      else dropLights(d);
      return;
    }
    const pr = press.current;
    press.current = null;
    if (!pr || !view) return;
    if (pr.kind === "pan") {
      setPanning(false);
      // A tap selects; a ⌘-click toggles the light under it.
      if (pr.panned) return;
      if (pr.touch) onSelect(pr.hit ? [pr.hit.id] : [], "replace");
      else if (pr.hit) onSelect([pr.hit.id], "toggle");
      return;
    }
    const box = marquee.current;
    marquee.current = null;
    dirty.current = true;
    if (!pr.add) setRailSel(null);
    if (!box) {
      if (pr.hit) onSelect([pr.hit.id], pr.add ? "toggle" : "replace");
      else if (!pr.add) onSelect([], "replace");
      return;
    }
    const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
    const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
    const ids = shown
      .filter((l) => {
        const x = view.ox + l.x * view.scale;
        const y = view.oy + l.y * view.scale;
        return x >= x0 && x <= x1 && y >= y0 && y <= y1;
      })
      .map((l) => l.id);
    onSelect(ids, pr.add ? "add" : "replace");
  };

  /** Show a change right away, before the server has it. */
  const show = (c: LayoutChange) => {
    if (c.rails) {
      const rails = c.rails;
      setPendingRails((m) => new Map([...m, ...rails.map((r) => [r.id, r.rail] as const)]));
      // Lights on a rail that's taken away stay where they are (as the server does).
      const gone = new Set(rails.filter((r) => !r.rail).map((r) => r.id));
      const stranded = placed.filter((l) => l.rail && gone.has(l.rail.id));
      if (stranded.length > 0) {
        setPendingSpot((m) => new Map([...m, ...stranded.map((l) => [l.id, { coords: coordsOf(l) }] as const)]));
      }
    }
    if (c.placements) {
      const spots = c.placements.map((p): [number, Spot | null] => [p.id, "rail" in p ? { rail: p.rail } : p.coords && { coords: p.coords }]);
      setPendingSpot((m) => new Map([...m, ...spots]));
    }
    if (c.types) {
      const types = c.types;
      setPendingType((m) => new Map([...m, ...types.map((t) => [t.id, t.type] as const)]));
    }
  };

  /** Record a change: show it now, save it, and remember how to undo it. */
  const commit = (after: LayoutChange, before: LayoutChange) => {
    show(after);
    setUndo((u) => [...u, before]);
    change.mutate(after);
  };

  /** How to put a light back where it is now. */
  const placementNow = (id: number): Placement => {
    const l = placed.find((p) => p.id === id);
    if (!l) return { id, coords: null };
    return l.rail ? { id, rail: l.rail } : { id, coords: coordsOf(l) };
  };

  const dropLights = (d: Extract<Drag, { kind: "lights" }>) => {
    const placements = [...d.to].map(
      ([id, t]): Placement =>
        t.rail
          ? { id, rail: { id: t.rail.id, mm_along: Math.round(t.rail.mm_along) } }
          : { id, coords: { mm_x: Math.round(t.x), mm_y: Math.round(t.y), floor } },
    );
    commit({ placements }, { placements: [...d.to.keys()].map(placementNow) });
  };

  const unplace = (ids: number[]) => {
    commit({ placements: ids.map((id) => ({ id, coords: null })) }, { placements: ids.map(placementNow) });
    onSelect([], "replace");
  };

  /** A light dropped from the drawer: place it where it landed (on a rail, if it's near one), if that's on the map. */
  const dropFromDrawer = (id: number, clientX: number, clientY: number) => {
    if (!view || !document.elementFromPoint(clientX, clientY)?.closest(".map-canvas")) return;
    const local = toLocal({ clientX, clientY });
    const p = toPlan(view, local.x, local.y);
    const light = lights.find((l) => l.id === id);
    const onRail = light && hangsOnRails(pendingType.get(id) ?? light.type) ? snapToRail(p.x, p.y, null) : null;
    const placement: Placement = onRail?.rail
      ? { id, rail: { id: onRail.rail.id, mm_along: Math.round(onRail.rail.mm_along) } }
      : { id, coords: { mm_x: Math.round(p.x), mm_y: Math.round(p.y), floor } };
    commit({ placements: [placement] }, { placements: [{ id, coords: null }] });
  };

  const finishRail = (rail: Rail) => {
    if (railLength(rail) < MIN_RAIL_MM) return;
    commit({ rails: [{ id: rail.id, rail: shapeOf(rail) }] }, { rails: [{ id: rail.id, rail: null }] });
    setRailSel(rail.id);
  };

  /** A rail dragged into line: the lights on it come along. */
  const moveRail = (d: Extract<Drag, { kind: "rail" }>) => {
    if (railLength(d.after) < MIN_RAIL_MM) return;
    const after: LayoutChange = { rails: [{ id: d.id, rail: shapeOf(d.after) }] };
    const before: LayoutChange = { rails: [{ id: d.id, rail: shapeOf(d.before) }] };
    // Moving an end can change how far along the rail its lights are.
    const on = d.part === "body" ? [] : placed.filter((l) => l.rail?.id === d.id);
    if (on.length > 0) {
      after.placements = on.map((l) => ({ id: l.id, rail: { id: d.id, mm_along: Math.round(alongOn(d, l.rail!.mm_along)) } }));
      before.placements = on.map((l) => ({ id: l.id, rail: l.rail! }));
    }
    commit(after, before);
  };

  const deleteRail = (id: string) => {
    const rail = railsNow.get(id);
    if (!rail) return;
    const on = placed.filter((l) => l.rail?.id === id);
    commit(
      { rails: [{ id, rail: null }] },
      { rails: [{ id, rail: shapeOf(rail) }], placements: on.map((l) => ({ id: l.id, rail: l.rail! })) },
    );
    setRailSel(null);
  };

  // Selected lights that can be turned to another orientation.
  const turnable = shown.filter((l) => selected.has(l.id) && orientationsOf(l.type).length > 1);
  const turn = () => {
    if (turnable.length === 0) return;
    const types: TypeChange[] = turnable.map((l) => {
      const options = orientationsOf(l.type);
      return { id: l.id, type: options[(options.indexOf(l.type) + 1) % options.length]! };
    });
    commit({ types }, { types: turnable.map((l) => ({ id: l.id, type: l.type })) });
  };

  const undoLast = () => {
    const last = undo[undo.length - 1];
    if (!last) return;
    setUndo((u) => u.slice(0, -1));
    show(last);
    change.mutate(last);
  };

  const stopMoving = () => {
    setMoving(false);
    setDrawing(false);
    setRailSel(null);
    setRailHover(null);
  };

  // While moving: R turns the selected panels, Delete takes the selected rail
  // away, Escape stops drawing (or lets go of the rail).
  const keys = useRef({ turn, deleteRail, railSel, drawing });
  keys.current = { turn, deleteRail, railSel, drawing };
  useEffect(() => {
    if (!moving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || (e.target instanceof Element && e.target.closest("input, textarea, .cm-editor"))) return;
      const k = keys.current;
      if (e.key === "r") k.turn();
      else if ((e.key === "Delete" || e.key === "Backspace") && k.railSel) k.deleteRail(k.railSel);
      else if (e.key === "Escape") {
        if (drag.current?.kind === "draw") {
          drag.current = null;
          dirty.current = true;
        } else if (k.drawing) setDrawing(false);
        else setRailSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moving]);

  const zoomBy = (factor: number) => size && setView((v) => v && zoomAt(v, size.width / 2, size.height / 2, factor, minScale(), MAX_SCALE));
  const fit = () => size && setView(fitView(layout.fit, size.width, size.height, PAD));

  const cursor = panning
    ? "panning"
    : panKey
      ? "pan-ready"
      : moving && drawing
        ? "drawing"
        : moving && (hover || railHover)
          ? "grab"
          : hover
            ? "pointing"
            : "";

  const hint = drawing
    ? "Drag along a track to draw its rail. Ends catch on other rails' ends; shift keeps to 45°. Esc when you're done."
    : railSel
      ? "Drag the rail or either end to line it up with its track; the lights on it come along. Delete takes it away."
      : "Drag lights to move them; near a rail they hang on it. Drag into the drawer to take them off. R turns panels.";

  const plan = layout.plan;
  return (
    <div ref={wrap} className="map" style={view ? gridStyle(view) : undefined}>
      {plan && view && (
        <div
          key={plan.id}
          className="floorplan"
          aria-hidden="true"
          style={{
            left: view.ox + plan.viewBox.x * view.scale,
            top: view.oy + plan.viewBox.y * view.scale,
            width: plan.viewBox.width * view.scale,
            height: plan.viewBox.height * view.scale,
          }}
          dangerouslySetInnerHTML={{ __html: plan.svg }}
        />
      )}
      <canvas
        ref={canvas}
        className={`map-canvas${cursor ? ` ${cursor}` : ""}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => {
          if (press.current || drag.current) return;
          setHover(null);
          setRailHover(null);
        }}
        // Ctrl-drag pans; don't let it open the context menu on a Mac.
        onContextMenu={(e) => e.preventDefault()}
      />
      {view && hover && <HoverCard light={hover} at={positionOf(hover, drag.current)} view={view} width={size?.width ?? 0} moving={moving} />}

      <div className="map-tools">
        {moving ? (
          <>
            <div className="toolbar">
              <div className="toolbar-group">
                <button aria-pressed={drawing} onClick={() => setDrawing(!drawing)} title="Draw rails by dragging along each track">
                  Draw rail
                </button>
                {railSel && (
                  <button onClick={() => deleteRail(railSel)} title="Take the selected rail away; its lights stay where they are (Delete)">
                    Delete rail
                  </button>
                )}
                <button onClick={turn} disabled={turnable.length === 0} title="Switch selected 4×1 panels between vertical and horizontal (R)">
                  Turn
                </button>
              </div>
              <div className="toolbar-group">
                <button onClick={undoLast} disabled={undo.length === 0 || change.isPending}>
                  Undo
                </button>
                <a className="button" href="/api/lights.json" download="lights.json" title="arclamp's lights.json with these changes">
                  Export lights.json{changed > 0 ? ` (${changed} changed)` : ""}
                </a>
                <button className="primary" onClick={stopMoving}>
                  Done
                </button>
              </div>
            </div>
            <p className="hint">{hint}</p>
          </>
        ) : (
          <button onClick={() => setMoving(true)}>Move lights</button>
        )}
        {change.error && <p className="error-text">Couldn't save that: {change.error.message}</p>}
        {shown.length === 0 && !moving && (
          <p className="hint">
            No lights on floor {floor} yet.{unplaced.length > 0 ? " Drag them in from the drawer." : ""}
          </p>
        )}
      </div>

      <Segmented
        className="floor-switch"
        label="Floor"
        options={FLOORS.map((f) => ({ value: f.id, label: f.name }))}
        value={floor}
        onChange={onFloor}
      />

      <Drawer lights={unplaced} onDrop={dropFromDrawer}>
        {view && (
          <div className="map-corner">
            <ScaleBar scale={view.scale} />
            <div className="zoom">
              <div className="zoom-group" role="group" aria-label="Zoom">
                <button className="zoom-step" onClick={() => zoomBy(1.5)} aria-label="Zoom in" title="Zoom in" disabled={view.scale >= MAX_SCALE}>
                  <PlusIcon />
                </button>
                <button className="zoom-step" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out" title="Zoom out">
                  <MinusIcon />
                </button>
              </div>
              <button className="zoom-fit" onClick={fit} aria-label="Fit the building" title="Fit the building">
                <FitIcon />
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

const toRailPoint = (p: Point): RailPoint => ({ mm_x: p.x, mm_y: p.y });
const coordsOf = (l: PlacedLight) => ({ mm_x: Math.round(l.x), mm_y: Math.round(l.y), floor: l.floor });

/** A rail's shape to save, to the whole millimeter. */
function shapeOf(r: Rail): RailShape {
  const round = (p: RailPoint) => ({ mm_x: Math.round(p.mm_x), mm_y: Math.round(p.mm_y) });
  return { floor: r.floor, from: round(r.from), to: round(r.to) };
}

/** How far along a rail being dragged a light on it is now. */
function alongOn(d: Extract<Drag, { kind: "rail" }>, along: number): number {
  return clampAlong(d.after, d.part === "body" ? along : alongAfterEndMove(d.before, d.after, d.part, along));
}

/** Where a light is drawn right now, following any drag in progress. */
function positionOf(l: PlacedLight, d: Drag | null): Point {
  if (d?.kind === "lights" && d.moved) return d.to.get(l.id) ?? l;
  if (d?.kind === "rail" && l.rail?.id === d.id) return railPoint(d.after, alongOn(d, l.rail.mm_along));
  return l;
}

/** This floor's rails as they're drawn right now, and the one to show the length of. */
function railsAsDrawn(rails: Rail[], selected: string | null, d: Drag | null): { rails: Rail[]; measure: Rail | null } {
  if (d?.kind === "draw") return { rails: [...rails, d.rail], measure: d.rail };
  if (d?.kind === "rail") return { rails: rails.map((r) => (r.id === d.id ? d.after : r)), measure: d.after };
  return { rails, measure: rails.find((r) => r.id === selected) ?? null };
}

/** A grid in plan millimeters behind everything, its spacing following the zoom. */
function gridStyle(view: View): CSSProperties {
  const { minor, major, minorAlpha } = gridFor(view.scale);
  const line = (alpha: number, dir: string) => `linear-gradient(${dir}, rgb(237 230 218 / ${alpha}) 1px, transparent 1px)`;
  const m = minor * view.scale;
  const M = major * view.scale;
  return {
    backgroundImage: [line(0.075, "to right"), line(0.075, "to bottom"), line(0.04 * minorAlpha, "to right"), line(0.04 * minorAlpha, "to bottom")].join(", "),
    backgroundSize: `${M}px ${M}px, ${M}px ${M}px, ${m}px ${m}px, ${m}px ${m}px`,
    backgroundPosition: `${view.ox}px ${view.oy}px`,
  };
}

/**
 * A classic dual scale bar: one baseline from a shared start, metric marked
 * above it and imperial below, each ending at a round length.
 */
function ScaleBar({ scale }: { scale: number }) {
  const { metric, imperial } = scaleBar(scale, 120);
  const m = Math.round(metric.px) + 0.5;
  const i = Math.round(imperial.px) + 0.5;
  const width = Math.ceil(Math.max(m, i)) + 1;
  return (
    <svg className="scale" width={width} height={36} role="img" aria-label={`Scale: ${metric.label}, ${imperial.label}`}>
      <path d={`M0.5 18.5H${Math.max(m, i)} M0.5 11V26 M${m} 11V18.5 M${i} 18.5V26`} />
      <text x={m} y={8} textAnchor="end">
        {metric.label}
      </text>
      <text x={i} y={35} textAnchor="end">
        {imperial.label}
      </text>
    </svg>
  );
}

function HoverCard({ light, at, view, width, moving }: { light: PlacedLight; at: Point; view: View; width: number; moving: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, []);
  const channels = latestFrame()?.lights.get(light.id);
  const t = lemtoneOf(channels, light.type);
  const x = view.ox + at.x * view.scale;
  const y = view.oy + at.y * view.scale;
  const flip = x > width - 220;
  const name = TYPE_NAMES[baseType(light.type)] ?? light.type;
  const where = light.rail
    ? `${(light.rail.mm_along / 1000).toFixed(2)} m along its rail`
    : `${(at.x / 1000).toFixed(2)} m, ${(at.y / 1000).toFixed(2)} m`;
  return (
    <div
      className="hover-card"
      style={{ left: flip ? x - 16 : x + 16, top: y, transform: flip ? "translate(-100%, -50%)" : "translateY(-50%)" }}
    >
      <span>
        {light.id} <span className="muted">{light.type === "4x1-horizontal" ? `${name}, horizontal` : name}</span>
      </span>
      <span className="mono">{moving ? where : t ? lemtoneCode(t) : "off"}</span>
    </div>
  );
}

interface Scene {
  size: Size;
  view: View;
  lights: PlacedLight[];
  spacing: number;
  positionOf: (l: PlacedLight) => Point;
  selected: ReadonlySet<number>;
  hovered: number | null;
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  rails: Rail[];
  railSel: string | null;
  railHover: string | null;
  moving: boolean;
  /** A rail to label with its length. */
  measure: Rail | null;
}

function draw(c: HTMLCanvasElement, s: Scene) {
  const { size, view } = s;
  const ctx = c.getContext("2d")!;
  const dpr = c.width / size.width;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Transparent, so the grid and floor plan underneath show through.
  ctx.clearRect(0, 0, size.width, size.height);

  drawRails(ctx, s);

  const frame = latestFrame();
  const reach = s.spacing * view.scale;
  const items = s.lights.map((l) => {
    const p = s.positionOf(l);
    const t = lemtoneOf(frame?.lights.get(l.id), l.type);
    // How bright it looks (cube root of its light), and its color at full.
    const level = t ? lookOf(t.brightness) : 0;
    const rgb = t && level > 0.01 ? (swatch(t.a, t.b).map((v) => Math.round(v * 255)) as [number, number, number]) : null;
    const foot = footprintOf(l.type);
    return {
      id: l.id,
      x: view.ox + p.x * view.scale,
      y: view.oy + p.y * view.scale,
      level,
      rgb,
      // Panels: their footprint in pixels. Bulbs: a radius.
      w: foot ? foot.width * view.scale : 0,
      h: foot ? foot.height * view.scale : 0,
      r: foot ? 0 : Math.max(2.5, (BULB_MM[baseType(l.type)] ?? 40) * view.scale),
    };
  });

  // Glows add up where they overlap, like light does. Each is kept within
  // about half the gap to its neighbors, so lights read as separate.
  ctx.globalCompositeOperation = "lighter";
  for (const it of items) {
    if (!it.rgb) continue;
    const [r, g, b] = it.rgb;
    const halo = Math.max(it.r * 2.5, reach * (0.36 + 0.26 * it.level));
    // Panels glow in an ellipse around their footprint.
    const rx = it.w ? it.w / 2 + halo * 0.6 : halo;
    const ry = it.h ? it.h / 2 + halo * 0.6 : halo;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, `rgba(${r},${g},${b},${0.7 * it.level})`);
    grad.addColorStop(0.22, `rgba(${r},${g},${b},${0.32 * it.level})`);
    grad.addColorStop(0.6, `rgba(${r},${g},${b},${0.07 * it.level})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";

  for (const it of items) {
    ctx.beginPath();
    if (it.w) ctx.roundRect(it.x - it.w / 2, it.y - it.h / 2, it.w, it.h, Math.min(3, it.w / 4, it.h / 4));
    else ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
    if (!it.rgb) {
      // Off: dark, so it covers the rail under it like the real bulb would.
      ctx.fillStyle = "#11100e";
      ctx.fill();
      ctx.strokeStyle = "#4a443d";
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // The emitter: the light's color pushed toward white as it brightens.
      const mix = (v: number) => Math.round(v + (255 - v) * (0.25 + 0.5 * it.level));
      ctx.fillStyle = `rgb(${mix(it.rgb[0])},${mix(it.rgb[1])},${mix(it.rgb[2])})`;
      ctx.fill();
    }
    if (s.selected.has(it.id) || s.hovered === it.id) {
      ctx.beginPath();
      if (it.w) ctx.roundRect(it.x - it.w / 2 - 4, it.y - it.h / 2 - 4, it.w + 8, it.h + 8, 5);
      else ctx.arc(it.x, it.y, it.r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = s.selected.has(it.id) ? "#f1ebe0" : "rgba(241,235,224,0.45)";
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }

  if (s.measure) drawLength(ctx, view, s.measure);

  if (s.box) {
    const { box } = s;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    ctx.fillStyle = "rgba(241,235,224,0.04)";
    ctx.fillRect(x, y, w, h);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(241,235,224,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
  }
}

/**
 * Rails as thin tracks with a stop across each end: faint while just looking,
 * plainer while moving lights, brightest when selected (with handles on its
 * ends to drag).
 */
function drawRails(ctx: CanvasRenderingContext2D, s: Scene) {
  const { view } = s;
  const screen = (p: RailPoint) => ({ x: view.ox + p.mm_x * view.scale, y: view.oy + p.mm_y * view.scale });
  ctx.lineCap = "round";
  for (const r of s.rails) {
    const a = screen(r.from);
    const b = screen(r.to);
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Across the track, for the end stops.
    const nx = (-(b.y - a.y) / length) * 3.5;
    const ny = ((b.x - a.x) / length) * 3.5;
    const sel = r.id === s.railSel;
    const alpha = sel ? 0.95 : r.id === s.railHover ? 0.7 : s.moving ? 0.42 : 0.2;
    ctx.strokeStyle = `rgba(214,198,168,${alpha})`;
    ctx.lineWidth = sel ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    for (const p of [a, b]) {
      ctx.moveTo(p.x - nx, p.y - ny);
      ctx.lineTo(p.x + nx, p.y + ny);
    }
    ctx.stroke();
    if (sel) {
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#11100e";
        ctx.fill();
        ctx.strokeStyle = "#f1ebe0";
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    }
  }
}

/** A rail's length beside its middle: above a level rail, left of a plumb one. */
function drawLength(ctx: CanvasRenderingContext2D, view: View, r: Rail) {
  const ax = view.ox + r.from.mm_x * view.scale;
  const ay = view.oy + r.from.mm_y * view.scale;
  const bx = view.ox + r.to.mm_x * view.scale;
  const by = view.oy + r.to.mm_y * view.scale;
  const length = Math.hypot(bx - ax, by - ay);
  if (length < 24) return;
  // The side of the rail facing up (or left, for a plumb one).
  let nx = (ay - by) / length;
  let ny = (bx - ax) / length;
  if (ny > 0 || (ny === 0 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  const x = (ax + bx) / 2 + nx * 14;
  const y = (ay + by) / 2 + ny * 14;
  ctx.font = '500 11px "Recursive Variable", ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = nx < -0.7 ? "right" : nx > 0.7 ? "left" : "center";
  ctx.textBaseline = "middle";
  const text = formatLength(railLength(r));
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(11,10,9,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#ede6da";
  ctx.fillText(text, x, y);
}
