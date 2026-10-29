// The building from above: the current floor's plan over a measuring grid,
// with each light drawn where it is in the color lemtone says its channels
// make, and the light it casts on the floor simulated (falling off with
// distance, stopped by walls; see lighting.ts). 4×1 panels are drawn at their
// real 1 ft × 4 ft size, and the rails the bulbs hang on as thin tracks.
//
// Getting around works the way each device's own maps do. With a mouse, drag
// to select, ⌘-drag or middle-drag to pan, scroll to zoom, and double-click to
// zoom in (⌥ zooms out). On a trackpad, two fingers pan and a pinch zooms. On a
// touch screen (a wall display as much as a phone), one finger selects and two
// move: two fingers pan and pinch (a flick glides on), a double tap zooms in
// and a two-finger tap zooms out.
//
// Click or tap a light to select it; shift adds to the selection (or takes
// out of it, all of them selected already) and alt (⌥) always takes out of it
// (keyedMode), ⌘-click
// toggles one light, ⌘A selects them all, and double-clicking a light selects
// its whole rail. Dragging out a box, shift and alt can be pressed or let go
// of on the way, the box taking them on as they change; Escape lets go of the
// box (or a drag of lights or a rail) and leaves the selection as it was. On a touch screen, dragging one finger draws a box that adds
// to the selection, straight away; once anything's selected, taps add and
// remove lights (and double taps whole rails) until the selection chip lets
// go. Holding a finger on a light shows what it is, as hovering does.
//
// In Edit lights (admin mode), dragging a light moves it (with the rest of
// the selection, if it's selected); near a rail it hangs on it and slides
// along it. Draw rail draws rails along the tracks. Dragging a rail, or
// either end of it, lines it up with its track, and the lights on it come
// along. Selected lights can be tagged (TagEditor).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { Frame, LightInfo, Rail, RailPoint, RailSpot } from "../../shared/arclamp.ts";
import { baseType, footprintOf, orientationsOf, seenOf } from "../../shared/fixtures.ts";
import { cssColor, lightRgb, lookOf, LUMENS_PER_BRIGHTNESS, swatch, type Vec3 } from "../../shared/lemtone.ts";
import { alongAfterEndMove, clampAlong, hangsOnRails, nearestOnRail, newRailId, railLength, railPoint, settleAngle, type Point, type RailShape } from "../../shared/rails.ts";
import type { Placement, Spot, TagChange, TypeChange } from "../../shared/vibes.ts";
import { useMoveCamera, useStreetViews } from "../api.ts";
import { useChangeLayout, type LayoutChange } from "../scene.ts";
import { FLOORS, planExtent, type Floor } from "../floors.ts";
import { screenGamut, setHdrCanvas, useDisplay } from "../display.ts";
import { CheckIcon, DownloadIcon, FitIcon, LookIcon, MinusIcon, PencilRulerIcon, PlusIcon, RailIcon, TrashIcon, TurnIcon, UndoIcon } from "../icons.tsx";
import { currentRails, layoutLights, placeLights, type PlacedLight } from "../layout.ts";
import { ExactLighting } from "../lighting-exact.ts";
import { HdrLighting } from "../lighting-hdr.ts";
import { Lighting, REACH_MM, type Renderer, type Source } from "../lighting.ts";
import { useFrames } from "../live.ts";
import { setPreviewFolded, useAdminMode, useExactLight, usePreviewFolded } from "../settings.ts";
import { visibility, type Segment } from "../shadows.ts";
import {
  fitView,
  flickOf,
  formatLength,
  gridFor,
  looksLikeTrackpad,
  MAX_SCALE,
  motionAt,
  pinchView,
  scaleBar,
  toPlan,
  zoomAt,
  type Insets,
  type Motion,
  type Sample,
  type View,
} from "../viewport.ts";
import { Drawer } from "./Drawer.tsx";
import { Latency } from "./Latency.tsx";
import { Segmented } from "./Segmented.tsx";
import { cameraAt, Pegman, StreetViewSpots } from "./StreetViewMarks.tsx";
import { TagEditor } from "./TagEditor.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { LightsSummary } from "./LightsSummary.tsx";
import { cssRgb, MINE, ringOf, type Rgb } from "../../shared/presence.ts";
import { keyedMode, RING_DASH, ringStyle, selectionWith, type SelectMode } from "../selection.ts";

// Bulb radius in millimeters (a BR30 is 95 mm across; the old bulbs are A19s).
// A bulb's marker, in millimeters on the plan: every bulb the same, whatever it really is.
const BULB_MM = 48;
// And at least this big (px), zoomed right out.
const MARKER_MIN = 2.5;
const PAD = 36;
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
// Fingers are bigger and less exact than a mouse: for touch, hit areas and
// how far a press goes before it's a drag grow by this much.
const FINGER = 2.5;
// Two taps this close together (ms, px) are a double tap.
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_PX = 30;
// How long the view takes to fly to a new zoom (buttons, fit, double taps).
const FLY_MS = 280;
// Holding a finger still on a light this long (ms) shows what it is.
const LONG_PRESS_MS = 450;
// How far (px) a press goes before it's a box: a finger wobbles more than a mouse.
const BOX_SLOP = 4;
const BOX_SLOP_TOUCH = 10;

/**
 * What a press does to the selection: shift adds (or takes away, all of it
 * selected already), alt (⌥) always takes away (keyedMode); neither,
 * replaces. A finger's presses add.
 */
type PressMode = "replace" | "add" | "remove";
/** A change to the selection a gesture makes: these lights, by this mode. */
interface Change {
  ids: number[];
  mode: SelectMode;
}
/** A change shown before it's made: the lights it's about, and the selection it leaves. */
interface Preview {
  targets: ReadonlySet<number>;
  next: ReadonlySet<number>;
}
const sameChange = (a: Change, b: Change) => a.mode === b.mode && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]);
/** A click on one light: a replace as it is; shift's and alt's as keyedMode has them; ⌘'s toggle. */
const clickChange = (id: number, mode: PressMode | "toggle", selected: ReadonlySet<number>): Change => ({
  ids: [id],
  mode: mode === "replace" || mode === "toggle" ? mode : keyedMode(mode, [id], selected),
});
const pressMode = (e: { shiftKey: boolean; altKey: boolean }, touch = false): PressMode => (e.altKey && !touch ? "remove" : touch || e.shiftKey ? "add" : "replace");


interface Props {
  lights: LightInfo[];
  rails: Rail[];
  floor: number;
  onFloor: (floor: number) => void;
  /** Lights and rails changed in vibes but not yet exported to arclamp. */
  changed: number;
  selected: ReadonlySet<number>;
  onSelect: (ids: number[], mode: SelectMode) => void;
  /** The lights other people have selected, each with their colors (web/presence.ts): their light in its ring. */
  others?: ReadonlyMap<number, Rgb[]>;
  /** Lights pointed out from a panel (a layer's row, an unsaved changes asterisk): hovered, as if under the pointer here. */
  hinted?: ReadonlySet<number>;
  /** Selected lights what's pointed out from a panel would let go of, if it were clicked: about to be let go of. */
  leaving?: ReadonlySet<number>;
  /** Your own rings' color: a warm white, or (editing a domain, or a layer in focus) the focus blue. */
  mine?: Rgb;
  /** What the selection looks like: a card in the map's bottom right, beside the zoom, while its button there is on. */
  look?: ReactNode;
  /** Open streetview from a camera (the figure dropped on it); without it, there's no figure. */
  onStreetView?: (id: string) => void;
  /** The camera streetview's showing, if it's open: the map shows every camera, that one picked out, and another click switches. */
  streetView?: string | null;
}

const NO_CAMERAS: never[] = [];
// How long a click on the figure shows the cameras for.
const POKE_MS = 2500;

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

// `slop`: how far (px) the press goes before it's a drag.
type Drag =
  | { kind: "lights"; grabbed: number; x0: number; y0: number; slop: number; moved: boolean; from: Map<number, PlacedLight>; to: Map<number, Target> }
  | { kind: "rail"; id: string; part: RailPart; x0: number; y0: number; slop: number; moved: boolean; before: Rail; after: Rail }
  | { kind: "draw"; rail: Rail };

// `trail`: the pan's last few positions, to tell how fast it was flicked.
type Press =
  | { kind: "pan"; id: number; x: number; y: number; view: View; hit: PlacedLight | null; panned: boolean; touch: boolean; trail: Sample[] }
  // `stopped`: the press stopped a glide, so it isn't a tap. `peeked`: held on a light, showing what it is.
  | { kind: "box"; x: number; y: number; hit: PlacedLight | null; mode: PressMode; touch: boolean; stopped: boolean; peeked: boolean };

/** Two fingers on the map: where they started, and the view then. */
interface Pinch {
  view: View;
  center: Point;
  distance: number;
  at: number;
  /** Where their midpoint is now. */
  last: Point;
  moved: boolean;
  /** Their midpoint's last few positions, for a flick as they let go. */
  trail: Sample[];
}

/** Safari's trackpad pinch. */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

const NO_OTHERS: ReadonlyMap<number, Rgb[]> = new Map();
const NO_HINTED: ReadonlySet<number> = new Set();

export function RoomMap({
  lights,
  rails,
  floor,
  onFloor,
  changed,
  selected,
  onSelect,
  others = NO_OTHERS,
  hinted = NO_HINTED,
  leaving = NO_HINTED,
  mine = MINE,
  look,
  onStreetView,
  streetView = null,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const planEl = useRef<HTMLDivElement>(null);
  const lightCanvas = useRef<HTMLCanvasElement>(null);
  const gridEl = useRef<HTMLDivElement>(null);
  // The simulated light, if this browser can run it (past white, where the
  // screen and browser show that), with each light's view of the floor
  // (worked out once per spot) and the spots it last drew from.
  // The exact light (lighting-exact.ts), while it's being tried out, is
  // WebGL only, so it takes over from the light past white.
  const exact = useExactLight();
  const display = useDisplay();
  const { gamut } = display;
  const hdr = display.hdr && !exact;
  const lighting = useRef<Renderer | null>(null);
  // While the light past white is being set up: no glows meanwhile, it's moments away.
  const lightPending = useRef(false);
  const fans = useRef(new Map<string, Float32Array>());
  const fanSpots = useRef("");
  const litFloor = useRef<number | null>(null);
  // Where the light comes from: the room, or a sketch's preview.
  const frames = useFrames();
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const frame = useMemo(() => planExtent(), []);
  const [size, setSize] = useState<Size | null>(null);
  const [view, setViewState] = useState<View | null>(null);
  const [hover, setHover] = useState<PlacedLight | null>(null);
  const [moving, setMoving] = useState(false);
  // While moving: whether a drag draws a rail, and the rail being worked on.
  const [drawing, setDrawing] = useState(false);
  const [railSel, setRailSel] = useState<string | null>(null);
  const [railHover, setRailHover] = useState<RailHit | null>(null);
  // ⌘ (or Ctrl) held: the next drag pans. Shown as a grab cursor.
  const [panKey, setPanKey] = useState(false);
  // Shift and alt held: what a click on the light under the pointer would do (hoverLeaving).
  const [heldKeys, setHeldKeys] = useState({ shiftKey: false, altKey: false });
  const [panning, setPanning] = useState(false);
  // While a box is being dragged out: the change letting it go makes (the
  // lights in it, and how), the one thing its rings, its card and the
  // selection itself all go by.
  const [boxing, setBoxing] = useState<Change | null>(null);
  // Streetview: its cameras, the figure while it's dragged (map px), and a
  // click on it showing the cameras for a moment.
  const cameras = useStreetViews().data ?? NO_CAMERAS;
  const moveCamera = useMoveCamera();
  const [peg, setPeg] = useState<{ x: number; y: number } | null>(null);
  const [poked, setPoked] = useState(false);
  useEffect(() => {
    if (!poked) return;
    const t = window.setTimeout(() => setPoked(false), POKE_MS);
    return () => window.clearTimeout(t);
  }, [poked]);
  const change = useChangeLayout();
  const admin = useAdminMode();
  const [undo, setUndo] = useState<LayoutChange[]>([]);
  // Changes shown until the server's copy catches up: where lights are (null
  // = off the map), rails (null = taken away), orientations and tags.
  const [pendingSpot, setPendingSpot] = useState<Map<number, Spot | null>>(new Map());
  const [pendingRails, setPendingRails] = useState<Map<string, RailShape | null>>(new Map());
  const [pendingType, setPendingType] = useState<Map<number, string>>(new Map());
  const [pendingTags, setPendingTags] = useState<Map<number, string[]>>(new Map());
  const dirty = useRef(true);
  const marquee = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const press = useRef<Press | null>(null);
  const drag = useRef<Drag | null>(null);
  // Fingers down on the map (touch only), and the pinch two of them make.
  const fingers = useRef(new Map<number, Point>());
  const pinch = useRef<Pinch | null>(null);
  const motion = useRef<Motion | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const longPress = useRef<number | undefined>(undefined);
  const lastPointer = useRef("mouse");

  // The view lives in a ref, so the plan, grid and canvas all move in the
  // same frame (the draw loop places them together); React hears about it
  // for the scale bar and the hover card.
  const viewRef = useRef<View | null>(null);
  const setView = (next: View) => {
    viewRef.current = next;
    dirty.current = true;
    setViewState(next);
  };
  // Draws now, rather than on the next frame (see the draw loop).
  const paintNow = useRef<(() => void) | null>(null);

  // Everything as it is now, pending changes included.
  const railsNow = useMemo(() => currentRails(rails, pendingRails), [rails, pendingRails]);
  const placed = useMemo(() => placeLights(lights, railsNow, { spots: pendingSpot, types: pendingType }), [lights, railsNow, pendingSpot, pendingType]);
  const layout = useMemo(() => layoutLights(placed, railsNow.values(), floor, frame), [placed, railsNow, floor, frame]);
  const shown = layout.lights;
  const unplaced = useMemo(() => {
    const on = new Set(placed.map((l) => l.id));
    return lights.filter((l) => !on.has(l.id));
  }, [lights, placed]);

  // What the gesture under way would do to the selection, as the change
  // itself (the same one up() makes): a box being dragged out's; else a
  // click on the light under the mouse (clickChange: replace, shift's or
  // alt's, ⌘'s toggle), except while moving lights, where pressing a selected
  // light drags them all. A finger held on a light only shows what it is.
  // The rings show it (Preview), not anything worked out beside it.
  const preview = useMemo((): Preview | null => {
    const change = boxing ?? (hover && !moving && lastPointer.current !== "touch" ? clickChange(hover.id, panKey ? "toggle" : pressMode(heldKeys), selected) : null);
    return change && { targets: new Set(change.ids), next: selectionWith(selected, change.ids, change.mode) };
  }, [boxing, hover, moving, panKey, heldKeys, selected]);

  // Refs for the draw loop and the native wheel listener.
  const live = useRef({ layout, selected, others, hinted, leaving, preview, mine, hover, moving, railSel, railHover });
  live.current = { layout, selected, others, hinted, leaving, preview, mine, hover, moving, railSel, railHover };
  const fitRef = useRef(layout.fit);
  fitRef.current = layout.fit;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    dirty.current = true;
  }, [layout, selected, others, hinted, leaving, preview, mine, hover, moving, railSel, railHover, gamut]);

  // A new floor's plan goes where the view says before it's ever painted.
  useLayoutEffect(() => {
    if (viewRef.current) placeBackdrop(gridEl.current!, planEl.current, layout.plan, viewRef.current);
  }, [layout.plan]);

  useEffect(() => () => window.clearTimeout(longPress.current), []);

  // ⌘A selects every light on this floor; the view stays where it is.
  const everything = useRef({ shown, onSelect });
  everything.current = { shown, onSelect };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "a" || (e.target instanceof Element && e.target.closest("input, textarea, .cm-editor"))) return;
      e.preventDefault();
      everything.current.onSelect(
        everything.current.shown.map((l) => l.id),
        "replace",
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The server's copy has caught up once the lights change; drop the stand-ins.
  useEffect(() => {
    setPendingSpot(new Map());
    setPendingRails(new Map());
    setPendingType(new Map());
    setPendingTags(new Map());
  }, [lights, rails]);

  // A rail on another floor, or one that's gone, can't stay selected.
  useEffect(() => {
    if (railSel && railsNow.get(railSel)?.floor !== floor) setRailSel(null);
  }, [railSel, railsNow, floor]);

  const fitTo = (width: number, height: number) => fitView(fitRef.current, width, height, fitPadding(wrap.current!));
  const minScale = () => {
    const s = sizeRef.current;
    return s ? fitTo(s.width, s.height).scale * 0.5 : 0;
  };

  /** Size the canvases to the map's `width` × `height` CSS pixels. */
  const sizeCanvases = (width: number, height: number) => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    // The light at the screen's resolution, up to 2×: past that it costs more than it shows.
    const lightDpr = Math.min(2, dpr);
    lightCanvas.current!.width = Math.round(width * lightDpr);
    lightCanvas.current!.height = Math.round(height * lightDpr);
  };

  // Size the canvas; fit on first layout (where the view starts), and after
  // that keep the center on resize, never zooming.
  // Resizing a canvas blanks it, and this runs after the frame's drawing but
  // before it's shown, so it draws again at once (else each step of a resize
  // shows a frame without the light).
  useEffect(() => {
    const el = wrap.current!;
    const observer = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const prev = sizeRef.current;
      sizeCanvases(width, height);
      sizeRef.current = { width, height };
      setSize({ width, height });
      const v = viewRef.current;
      motion.current = null;
      setView(v && prev ? { ...v, ox: v.ox + (width - prev.width) / 2, oy: v.oy + (height - prev.height) / 2 } : fitTo(width, height));
      paintNow.current?.();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Wheels and trackpads, native and non-passive so the page itself doesn't
  // scroll. A trackpad's two fingers pan and its pinch (ctrl + wheel, or
  // Safari's gesture events) zooms; a mouse wheel zooms. Zooms keep the
  // point under the pointer still.
  useEffect(() => {
    const el = wrap.current!;
    const onMap = (e: Event) => !(e.target as Element).closest(".drawer, .map-tools, .floor-switch, .map-corner");
    const zoom = (clientX: number, clientY: number, factor: number) => {
      const v = viewRef.current;
      if (!v) return;
      const r = el.getBoundingClientRect();
      motion.current = null;
      setView(zoomAt(v, clientX - r.left, clientY - r.top, factor, minScale(), MAX_SCALE));
    };
    // Whether the wheel events coming in are a trackpad's, decided as each
    // burst starts so one gesture never switches between panning and zooming.
    let burst = { at: -Infinity, trackpad: false };
    // Safari's pinch scale so far, while it's pinching.
    let gesture: number | null = null;

    const onWheel = (e: WheelEvent) => {
      if (!onMap(e)) return;
      e.preventDefault();
      // (deltaMode first: Firefox then reports a mouse wheel in lines.)
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.getBoundingClientRect().height : 1;
      if (e.ctrlKey) {
        if (gesture === null) zoom(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.01));
        return;
      }
      const trackpad = looksLikeTrackpad(e);
      burst = { at: e.timeStamp, trackpad: e.timeStamp - burst.at > 250 ? trackpad : burst.trackpad || trackpad };
      const v = viewRef.current;
      if (!burst.trackpad) zoom(e.clientX, e.clientY, Math.exp(-e.deltaY * unit * 0.002));
      else if (v) {
        motion.current = null;
        setView({ ...v, ox: v.ox - e.deltaX * unit, oy: v.oy - e.deltaY * unit });
      }
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesture = 1;
    };
    // On iOS these come along with the fingers' pointer events, which pinch already.
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      if (gesture !== null && fingers.current.size === 0 && onMap(e)) zoom(g.clientX, g.clientY, g.scale / gesture);
      gesture = g.scale;
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesture = null;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);

  useEffect(() => {
    dirty.current = true;
    return frames.subscribe(() => void (dirty.current = true));
  }, [frames]);

  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      setPanKey(e.metaKey || e.ctrlKey);
      setHeldKeys((k) => (k.shiftKey === e.shiftKey && k.altKey === e.altKey ? k : { shiftKey: e.shiftKey, altKey: e.altKey }));
    };
    const clear = () => {
      setPanKey(false);
      setHeldKeys({ shiftKey: false, altKey: false });
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // A canvas keeps the color space it's first opened in, and the light's is
  // WebGL or WebGPU for good, so each is new when the gamut or HDR changes
  // (they're keyed on them): sized before it's shown, then drawn.
  useLayoutEffect(() => {
    const s = sizeRef.current;
    if (s) sizeCanvases(s.width, s.height);
    dirty.current = true;
  }, [gamut, hdr, exact]);

  useEffect(() => {
    const c = lightCanvas.current!;
    let gone = false;
    fanSpots.current = "";
    litFloor.current = null;
    dirty.current = true;
    if (hdr) {
      lightPending.current = true;
      void HdrLighting.create(c, screenGamut()).then((made) => {
        if (gone) return made?.dispose();
        lightPending.current = false;
        lighting.current = made;
        dirty.current = true;
        // Without it, the map goes back to WebGL, on a new canvas.
        setHdrCanvas(!!made);
      });
    } else {
      lighting.current = (exact ? ExactLighting : Lighting).create(c);
    }
    return () => {
      gone = true;
      lightPending.current = false;
      lighting.current?.dispose();
      lighting.current = null;
    };
  }, [hdr, exact]);

  // Each frame: move the view along if it's gliding or flying, then (if
  // anything changed) place the plan and grid and draw the lights, together.
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      const s = live.current;
      const view = viewRef.current;
      if (view && sizeRef.current) {
        dirty.current = false;
        const lightFrame = framesRef.current.latest();
        placeBackdrop(gridEl.current!, planEl.current, s.layout.plan, view);
        const d = drag.current;
        const lit = lighting.current && !lighting.current.lost ? lighting.current : null;
        if (lit) {
          const plan = s.layout.plan;
          if (plan && plan.id !== litFloor.current) {
            lit.setFloor(plan.walls, plan.viewBox);
            litFloor.current = plan.id;
          }
          const { sources, flux, spots } = lightSources(lightFrame, s.layout.lights, s.layout.plan, (l) => positionOf(l, d), fans.current);
          if (spots !== fanSpots.current) {
            lit.setSources(sources);
            fanSpots.current = spots;
          }
          lit.render(view, sizeRef.current.width, sizeRef.current.height, flux, screenGamut());
        }
        const { rails, measure } = railsAsDrawn(s.layout.rails, s.railSel, d);
        draw(canvas.current!, {
          frame: lightFrame,
          glow: !lit && !lightPending.current,
          size: sizeRef.current,
          view,
          lights: s.layout.lights,
          spacing: s.layout.spacing,
          positionOf: (l) => positionOf(l, d),
          selected: s.selected,
          others: s.others,
          hovered: s.hover?.id ?? null,
          hinted: s.hinted,
          leaving: s.leaving,
          preview: s.preview,
          mine: s.mine,
          box: marquee.current,
          rails,
          railSel: d?.kind === "rail" ? d.id : s.railSel,
          railHover: s.railHover?.id ?? null,
          moving: s.moving,
          measure,
        });
      }
    };
    const tick = (now: number) => {
      const m = motion.current;
      if (m) {
        const { view, done } = motionAt(m, now);
        if (done) motion.current = null;
        setView(view);
      }
      if (dirty.current) paint();
      raf = requestAnimationFrame(tick);
    };
    paintNow.current = paint;
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      paintNow.current = null;
    };
  }, []);

  /** Fly the view somewhere, briefly (or at once, with reduced motion). */
  const flyTo = (to: View) => {
    const from = viewRef.current;
    if (!from) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      motion.current = null;
      setView(to);
      return;
    }
    motion.current = { kind: "fly", from, to, start: performance.now(), ms: FLY_MS };
    dirty.current = true;
  };

  /** Zoom around (x, y), the middle by default: from wherever a flight in progress is headed, so quick presses add up. */
  const zoomBy = (factor: number, x = (sizeRef.current?.width ?? 0) / 2, y = (sizeRef.current?.height ?? 0) / 2) => {
    const m = motion.current;
    const v = m?.kind === "fly" ? m.to : viewRef.current;
    if (v) flyTo(zoomAt(v, x, y, factor, minScale(), MAX_SCALE));
  };
  const fit = () => size && flyTo(fitTo(size.width, size.height));

  /** After a pinch past a zoom limit, spring back to it around (x, y). Whether it had to. */
  const settle = (x: number, y: number) => {
    const v = viewRef.current;
    if (!v) return false;
    const scale = Math.min(MAX_SCALE, Math.max(minScale(), v.scale));
    if (scale === v.scale) return false;
    flyTo(zoomAt(v, x, y, scale / v.scale, 0, Infinity));
    return true;
  };

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** The light under (x, y); `reach` widens the hit area (for fingers). */
  const hitTest = (x: number, y: number, reach = 1): PlacedLight | null => {
    const view = viewRef.current;
    if (!view) return null;
    let best: PlacedLight | null = null;
    let bestD = Infinity;
    const slop = 6 * reach;
    for (const l of shown) {
      const p = positionOf(l, drag.current);
      const dx = view.ox + p.x * view.scale - x;
      const dy = view.oy + p.y * view.scale - y;
      const size = footprintOf(l.type);
      const inside = size
        ? Math.abs(dx) <= (size.width * view.scale) / 2 + slop && Math.abs(dy) <= (size.height * view.scale) / 2 + slop
        : Math.hypot(dx, dy) <= Math.max(10 * reach, MARKER_MIN + slop, BULB_MM * view.scale + slop);
      const d = Math.hypot(dx, dy);
      if (inside && d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  };

  /** The selected rail's end under (x, y), else any rail on this floor. */
  const hitRail = (x: number, y: number, reach = 1): RailHit | null => {
    const view = viewRef.current;
    if (!view) return null;
    const at = toPlan(view, x, y);
    const sel = railSel ? railsNow.get(railSel) : undefined;
    if (sel) {
      for (const part of ["from", "to"] as const) {
        if (Math.hypot(sel[part].mm_x - at.x, sel[part].mm_y - at.y) * view.scale <= END_HIT_PX * reach) return { id: sel.id, part };
      }
    }
    let best: RailHit | null = null;
    let bestD = (RAIL_HIT_PX * reach) / view.scale;
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
    const view = viewRef.current;
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
    const view = viewRef.current;
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

  /** A second finger is down: pinch, dropping whatever the first one started. */
  const startPinch = () => {
    const [a, b] = [...fingers.current.values()];
    const view = viewRef.current;
    if (!a || !b || !view) return;
    window.clearTimeout(longPress.current);
    drag.current = null;
    press.current = null;
    marquee.current = null;
    setBoxing(null);
    dirty.current = true;
    setPanning(false);
    const center = midpoint(a, b);
    setHover(null);
    const at = performance.now();
    pinch.current = { view, center, distance: Math.hypot(a.x - b.x, a.y - b.y), at, last: center, moved: false, trail: [{ t: at, ...center }] };
  };

  /** Every light on a light's rail (or just the light, if it's on none). */
  /** A light's whole rail (or just it, on none), here. */
  const railOf = (l: PlacedLight) => {
    const rail = l.rail?.id;
    return rail ? shown.filter((o) => o.rail?.id === rail).map((o) => o.id) : [l.id];
  };
  const selectRail = (l: PlacedLight, mode: SelectMode) => onSelect(railOf(l), mode);
  /** A press's mode for these lights: shift's and alt's as keyedMode has them; a replace as it is. */
  const keyed = (mode: PressMode, ids: number[]): SelectMode => (mode === "replace" ? "replace" : keyedMode(mode, ids, selected));

  /**
   * A tap on a light selects it. Once anything's selected, taps add and
   * remove lights instead (select mode, as in Photos: the selection chip lets
   * go), and the floor ignores them. Two quick taps select a light's whole
   * rail, or zoom in on the floor.
   */
  const tap = (p: Point, hit: PlacedLight | null, at: number) => {
    const prev = lastTap.current;
    if (prev && at - prev.at < DOUBLE_TAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) < DOUBLE_TAP_PX) {
      lastTap.current = null;
      if (hit) selectRail(hit, "add");
      else zoomBy(2, p.x, p.y);
      return;
    }
    lastTap.current = { at, ...p };
    if (hit) onSelect([hit.id], selected.size > 0 ? "toggle" : "replace");
  };

  // Double-clicking a light selects its whole rail (shift adds it, alt takes
  // it out, as keyedMode has them); the floor, zooms in there (⌥ zooms out), as in Maps.
  const doubleClick = (e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }) => {
    if (lastPointer.current === "touch" || (moving && drawing)) return;
    const p = toLocal(e);
    const hit = hitTest(p.x, p.y);
    if (hit) return selectRail(hit, keyed(pressMode(e), railOf(hit)));
    if (moving && hitRail(p.x, p.y)) return;
    zoomBy(e.altKey ? 0.5 : 2, p.x, p.y);
  };

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    const view = viewRef.current;
    const touch = e.pointerType === "touch";
    const pan = e.button === 1 || (e.button === 0 && (e.metaKey || e.ctrlKey));
    if ((e.button !== 0 && !pan) || !view) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    lastPointer.current = e.pointerType;
    // A touch that stops a glide only stops it; it isn't a tap.
    const stopped = motion.current?.kind === "glide";
    motion.current = null;
    const p = toLocal(e);
    if (touch) {
      fingers.current.set(e.pointerId, p);
      if (fingers.current.size > 1) {
        startPinch();
        return;
      }
    }
    const reach = touch ? FINGER : 1;
    const hit = hitTest(p.x, p.y, reach);
    const panFrom = (): Extract<Press, { kind: "pan" }> => ({ kind: "pan", id: e.pointerId, ...p, view, hit, panned: stopped, touch, trail: [{ t: e.timeStamp, ...p }] });
    if (pan) {
      press.current = panFrom();
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
      const end = hitRail(p.x, p.y, reach);
      const target = end && (end.part !== "body" || !hit) ? end : null;
      if (target) {
        const rail = railsNow.get(target.id)!;
        setRailSel(target.id);
        drag.current = { kind: "rail", id: target.id, part: target.part, x0: p.x, y0: p.y, slop: 4 * reach, moved: false, before: rail, after: rail };
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
          slop: 4 * reach,
          moved: false,
          from: new Map(group.map((l) => [l.id, l])),
          to: new Map(group.map((l) => [l.id, { x: l.x, y: l.y, rail: l.rail }])),
        };
        setRailSel(null);
        setHover(null);
        return;
      }
    }
    // A mouse drags out a box (shift adds to the selection, alt takes out of
    // it: keyedMode). So does a finger, straight away, always adding (as its taps
    // do): two fingers move the map. Held still on a light, a finger shows
    // what it is instead.
    const pr: Extract<Press, { kind: "box" }> = { kind: "box", ...p, hit, mode: pressMode(e, touch), touch, stopped, peeked: false };
    press.current = pr;
    window.clearTimeout(longPress.current);
    if (touch && hit) {
      longPress.current = window.setTimeout(() => {
        if (press.current !== pr || marquee.current) return;
        pr.peeked = true;
        setHover(hit);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    }
  };

  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const view = viewRef.current;
    const p = toLocal(e);
    if (fingers.current.has(e.pointerId)) fingers.current.set(e.pointerId, p);
    const pz = pinch.current;
    if (pz) {
      const [a, b] = [...fingers.current.values()];
      if (!a || !b) return;
      const c = midpoint(a, b);
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (Math.abs(spread - pz.distance) > 10 || Math.hypot(c.x - pz.center.x, c.y - pz.center.y) > 10) pz.moved = true;
      pz.last = c;
      pz.trail.push({ t: e.timeStamp, ...c });
      if (pz.trail.length > 12) pz.trail.shift();
      setView(pinchView(pz.view, pz.center, pz.distance, c, spread, minScale(), MAX_SCALE));
      return;
    }
    const d = drag.current;
    if (d && view) {
      const at = toPlan(view, p.x, p.y);
      if (d.kind === "draw") {
        const from = { x: d.rail.from.mm_x, y: d.rail.from.mm_y };
        d.rail = { ...d.rail, to: toRailPoint(magnet(at, null) ?? settleAngle(from, at, e.shiftKey)) };
        dirty.current = true;
        return;
      }
      if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) <= d.slop) return;
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
    if (pr?.kind === "pan") {
      if (pr.id !== e.pointerId || (!pr.panned && Math.hypot(p.x - pr.x, p.y - pr.y) <= (pr.touch ? 8 : 4))) return;
      if (!pr.panned) {
        setPanning(true);
        window.clearTimeout(longPress.current);
      }
      pr.panned = true;
      pr.trail.push({ t: e.timeStamp, ...p });
      if (pr.trail.length > 12) pr.trail.shift();
      setView({ ...pr.view, ox: pr.view.ox + p.x - pr.x, oy: pr.view.oy + p.y - pr.y });
      if (hover) setHover(null);
      return;
    }
    if (pr?.kind === "box" && view && (marquee.current || Math.hypot(p.x - pr.x, p.y - pr.y) > (pr.touch ? BOX_SLOP_TOUCH : BOX_SLOP))) {
      if (!marquee.current) {
        window.clearTimeout(longPress.current);
        if (pr.peeked) setHover(null);
        pr.peeked = false;
      }
      marquee.current = { x0: pr.x, y0: pr.y, x1: p.x, y1: p.y };
      boxChanged();
      return;
    }
    if (!pr && e.pointerType !== "touch") {
      const hit = hitTest(p.x, p.y);
      if (hit?.id !== hover?.id) setHover(hit);
      const end = moving && !drawing ? hitRail(p.x, p.y) : null;
      const rail = end && (end.part !== "body" || !hit) ? end : null;
      if (rail?.id !== railHover?.id || rail?.part !== railHover?.part) setRailHover(rail);
    }
  };

  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    const view = viewRef.current;
    window.clearTimeout(longPress.current);
    fingers.current.delete(e.pointerId);
    const pz = pinch.current;
    if (pz) {
      pinch.current = null;
      const [rest] = fingers.current;
      // One of three or more fingers lifted: the rest carry on pinching.
      if (fingers.current.size > 1) startPinch();
      // Two fingers tapped together: zoom out, as in Maps.
      else if (!pz.moved && performance.now() - pz.at < 300) zoomBy(0.5, pz.center.x, pz.center.y);
      // A finger still down pans on from where it is, keeping the pinch's
      // pace (its trail, moved over to the finger) so letting go glides.
      else if (rest && view) {
        const [dx, dy] = [rest[1].x - pz.last.x, rest[1].y - pz.last.y];
        const trail = pz.trail.map((s) => ({ t: s.t, x: s.x + dx, y: s.y + dy }));
        press.current = { kind: "pan", id: rest[0], ...rest[1], view, hit: null, panned: true, touch: true, trail };
      } else settle(pz.last.x, pz.last.y);
      return;
    }
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
    if (!pr || (pr.kind === "pan" && pr.id !== e.pointerId)) return;
    press.current = null;
    if (!view) return;
    if (pr.kind === "pan") {
      setPanning(false);
      const p = toLocal(e);
      if (pr.panned) {
        // A finger let go of the map glides on (after springing back from past a zoom limit).
        const flick = pr.touch && !settle(p.x, p.y) ? flickOf(pr.trail, e.timeStamp) : null;
        if (flick) motion.current = { kind: "glide", from: view, ...flick, start: performance.now() };
        return;
      }
      // A tap selects (two zoom in); a ⌘-click toggles the light under it.
      if (pr.touch) tap(p, pr.hit, e.timeStamp);
      else if (pr.hit) onSelect([pr.hit.id], "toggle");
      return;
    }
    const box = marquee.current;
    marquee.current = null;
    setBoxing(null);
    dirty.current = true;
    if (!box && pr.touch) {
      // Held to see what a light is: letting go only puts the card away.
      if (pr.peeked) setHover(null);
      else if (!pr.stopped) tap(toLocal(e), pr.hit, e.timeStamp);
      return;
    }
    if (pr.mode === "replace") setRailSel(null);
    if (!box) {
      // One light: shift or alt toggles it (each, on one light, is just that).
      if (pr.hit) {
        const change = clickChange(pr.hit.id, pr.mode, selected);
        onSelect(change.ids, change.mode);
      } else if (pr.mode === "replace") onSelect([], "replace");
      return;
    }
    const change = boxChange(pr, box, view);
    onSelect(change.ids, change.mode);
  };

  /** A box being dragged out, as it is now (where it reaches, and its press's mode): the change letting it go would make, for its card and the rings. */
  const boxChanged = () => {
    const pr = press.current;
    const box = marquee.current;
    const view = viewRef.current;
    dirty.current = true;
    if (pr?.kind !== "box" || !box || !view) return;
    const next = boxChange(pr, box, view);
    setBoxing((prev) => (prev && sameChange(prev, next) ? prev : next));
  };

  /**
   * Shift or alt pressed or let go while a mouse's box is down: it takes
   * them on from then, as if they'd been held from the start (a press on a
   * light not yet a box, too: its click goes as the keys say when it's let go).
   */
  const keysChanged = (e: { shiftKey: boolean; altKey: boolean }) => {
    const pr = press.current;
    if (pr?.kind !== "box" || pr.touch) return;
    const mode = pressMode(e);
    if (mode === pr.mode) return;
    pr.mode = mode;
    boxChanged();
  };

  /**
   * Escape while dragging: the drag's let go of as if it had never started
   * (a box selects nothing, lights and rails go back where they were, a rail
   * being drawn isn't), and nothing else hears it (not App's, which would
   * let go of the selection). Whether there was one.
   */
  const cancelDrag = (): boolean => {
    const pr = press.current;
    const d = drag.current;
    const boxing = pr?.kind === "box" && marquee.current !== null;
    const dragging = d !== null && (d.kind === "draw" || d.moved);
    if (!boxing && !dragging) return false;
    window.clearTimeout(longPress.current);
    press.current = null;
    marquee.current = null;
    drag.current = null;
    setBoxing(null);
    dirty.current = true;
    return true;
  };
  const dragKeys = useRef({ keysChanged, cancelDrag });
  dragKeys.current = { keysChanged, cancelDrag };
  useEffect(() => {
    // Before anything else hears Escape (window's capture, ahead of every bubbling listener).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragKeys.current.cancelDrag()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Shift" || e.key === "Alt") dragKeys.current.keysChanged(e);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, []);

  /** A box's press, for the lights in it: shift's and alt's as keyedMode has them. A finger's boxes only add. */
  const boxMode = (pr: { mode: PressMode; touch: boolean }, inside: number[]): PressMode =>
    pr.mode === "replace" || pr.touch ? pr.mode : keyedMode(pr.mode, inside, selected);
  /** What letting go of a box makes of the selection: the lights in it, by its press's mode. */
  const boxChange = (pr: { mode: PressMode; touch: boolean }, box: { x0: number; y0: number; x1: number; y1: number }, view: View): Change => {
    const inside = boxed(box, view);
    return { ids: inside, mode: boxMode(pr, inside) };
  };

  /** The lights inside a box on screen. */
  const boxed = (box: { x0: number; y0: number; x1: number; y1: number }, view: View) => {
    const [x0, x1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
    const [y0, y1] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)];
    return shown
      .filter((l) => {
        const x = view.ox + l.x * view.scale;
        const y = view.oy + l.y * view.scale;
        return x >= x0 && x <= x1 && y >= y0 && y <= y1;
      })
      .map((l) => l.id);
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
    if (c.tags) {
      const tags = c.tags;
      setPendingTags((m) => new Map([...m, ...tags.map((t) => [t.id, t.tags] as const)]));
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
    const placements = [...d.to].map(([id, t]): Placement =>
      t.rail ? { id, rail: { id: t.rail.id, mm_along: Math.round(t.rail.mm_along) } } : { id, coords: { mm_x: Math.round(t.x), mm_y: Math.round(t.y), floor } },
    );
    commit({ placements }, { placements: [...d.to.keys()].map(placementNow) });
  };

  const unplace = (ids: number[]) => {
    commit({ placements: ids.map((id) => ({ id, coords: null })) }, { placements: ids.map(placementNow) });
    onSelect([], "replace");
  };

  /** A light dropped from the drawer: place it where it landed (on a rail, if it's near one), if that's on the map. */
  const dropFromDrawer = (id: number, clientX: number, clientY: number) => {
    const view = viewRef.current;
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
    commit({ rails: [{ id, rail: null }] }, { rails: [{ id, rail: shapeOf(rail) }], placements: on.map((l) => ({ id: l.id, rail: l.rail! })) });
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

  // Tags: what each light has now (pending changes included), and on the
  // lights selected for tagging, as one undoable change.
  const tagsOf = (l: LightInfo) => pendingTags.get(l.id) ?? l.tags ?? [];
  const tagging = moving ? lights.filter((l) => selected.has(l.id)).map((l) => ({ id: l.id, tags: tagsOf(l) })) : [];
  const knownTags = [...new Set(lights.flatMap(tagsOf))].sort();
  const retag = (changes: TagChange[]) => {
    const before = new Map(tagging.map((l) => [l.id, l.tags]));
    commit({ tags: changes }, { tags: changes.map((c) => ({ id: c.id, tags: before.get(c.id) ?? [] })) });
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

  // Moving lights is an admin-mode tool: turning admin mode off puts it away.
  useEffect(() => {
    if (!admin) stopMoving();
  }, [admin]);

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

  const cursor = panning ? "panning" : panKey ? "pan-ready" : moving && drawing ? "drawing" : moving && (hover || railHover) ? "grab" : hover ? "pointing" : "";

  const hint = drawing
    ? "Drag along a track to draw its rail. Ends catch on other rails' ends; shift keeps to 45°. Esc when you're done."
    : railSel
      ? "Drag the rail or either end to line it up with its track; the lights on it come along. Delete takes it away."
      : "Select lights to tag them, or drag them to move them; near a rail they hang on it. Drag into the drawer to take them off. R turns panels.";

  // What it looks like: shown while its button in the corner is on (remembered in this browser).
  const showLook = !usePreviewFolded();

  const plan = layout.plan;
  return (
    <div ref={wrap} className="map">
      <canvas key={hdr ? "hdr" : exact ? "exact" : "sdr"} ref={lightCanvas} className={hdr ? "map-light hdr" : "map-light"} aria-hidden="true" />
      <div ref={gridEl} className="map-grid" aria-hidden="true" />
      {/* Placed by the draw loop, in step with the canvas. */}
      {plan && <div key={plan.id} ref={planEl} className="floorplan" aria-hidden="true" dangerouslySetInnerHTML={{ __html: plan.svg }} />}
      <canvas
        key={gamut}
        ref={canvas}
        className={`map-canvas${cursor ? ` ${cursor}` : ""}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={doubleClick}
        onPointerLeave={() => {
          if (press.current || drag.current) return;
          setHover(null);
          setRailHover(null);
        }}
        // Ctrl-drag pans; don't let it open the context menu on a Mac.
        onContextMenu={(e) => e.preventDefault()}
      />
      {view && hover && <LightTooltip light={hover} at={positionOf(hover, drag.current)} view={view} width={size?.width ?? 0} moving={moving} />}
      {view && preview && boxing && preview.next.size > 0 && (
        <SelectionCard lights={shown.filter((l) => preview.next.has(l.id))} at={(l) => positionOf(l, drag.current)} view={view} width={size?.width ?? 0} />
      )}
      {view && onStreetView && cameras.length > 0 && (
        <StreetViewSpots
          cameras={cameras}
          floor={floor}
          view={view}
          peg={peg}
          shown={poked}
          active={streetView}
          editing={moving}
          onPick={onStreetView}
          onMove={(id, v) => moveCamera.mutate({ id, view: v })}
        />
      )}

      <div className="map-top">
        <div className="map-tools">
          {moving && (
            <div className="toolbar">
              <div className="toolbar-row">
                <div className="toolbar-group">
                  <button className="tool" aria-pressed={drawing} onClick={() => setDrawing(!drawing)}>
                    <RailIcon /> Draw rail
                  </button>
                  {railSel && (
                    <button className="tool" onClick={() => deleteRail(railSel)}>
                      <TrashIcon /> Delete rail
                    </button>
                  )}
                  <button className="tool" onClick={turn} disabled={turnable.length === 0}>
                    <TurnIcon /> Turn
                  </button>
                </div>
                <div className="toolbar-group">
                  <button className="tool" onClick={undoLast} disabled={undo.length === 0 || change.isPending}>
                    <UndoIcon /> Undo
                  </button>
                  <a className="tool" href="/api/lights.json" download="lights.json">
                    <DownloadIcon /> lights.json{changed > 0 && <span className="tool-count">{changed}</span>}
                  </a>
                  <button className="primary tool-done" onClick={stopMoving}>
                    <CheckIcon /> Done
                  </button>
                </div>
              </div>
              <p className="toolbar-hint">{hint}</p>
            </div>
          )}
          {tagging.length > 0 && <TagEditor lights={tagging} known={knownTags} onChange={retag} />}
          {change.error && <p className="map-note bad">Couldn't save that: {change.error.message}</p>}
        </div>
      </div>

      <Drawer lights={unplaced} onDrop={dropFromDrawer}>
        {view && (
          <div className="map-corner">
            <ScaleBar scale={view.scale} />
            {/* Beside the zoom, pushing the scale left: what the selection looks like (while its button's on), and in admin mode the map's delay under it. */}
            {((look && showLook) || admin) && (
              <div className="corner-cards">
                {look && showLook && <div className="look-card">{look}</div>}
                {admin && <Latency />}
              </div>
            )}
            <div className="zoom">
              {/* Admin mode's own, at the top: moving lights. */}
              {admin && !moving && (
                <button className="zoom-look zoom-edit" onClick={() => setMoving(true)} aria-label="Edit lights">
                  <PencilRulerIcon />
                </button>
              )}
              {/* Always there, so the corner doesn't shift; the card itself only shows with something to show. */}
              <button className="zoom-look" aria-pressed={showLook} onClick={() => setPreviewFolded(showLook)} aria-label="What the selection looks like">
                <LookIcon />
              </button>
              {onStreetView && cameras.length > 0 && (
                <Pegman
                  map={wrap}
                  onDrag={setPeg}
                  onDrop={(p) => {
                    setPeg(null);
                    const hit = cameraAt(cameras, floor, view, p);
                    if (hit) onStreetView(hit.id);
                  }}
                  onPoke={() => setPoked(true)}
                />
              )}
              {/* Floors stacked as they are in the building, the top one first. */}
              <Segmented
                className="floor-switch"
                vertical
                label="Floor"
                options={FLOORS.map((f) => ({ value: f.id, label: String(f.id) })).reverse()}
                value={floor}
                onChange={onFloor}
              />
              <div className="zoom-group" role="group" aria-label="Zoom">
                <button className="zoom-step" onClick={() => zoomBy(1.5)} aria-label="Zoom in" disabled={view.scale >= MAX_SCALE}>
                  <PlusIcon />
                </button>
                <button className="zoom-step" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out">
                  <MinusIcon />
                </button>
              </div>
              <button className="zoom-fit" onClick={fit} aria-label="Fit">
                <FitIcon />
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/**
 * The room "fit" leaves round the building: PAD, plus whatever the panels
 * floating over the map cover on each side (the map's --inset-* in CSS).
 */
function fitPadding(el: HTMLElement): Insets {
  const css = getComputedStyle(el);
  const inset = (side: string) => PAD + (parseFloat(css.getPropertyValue(`--inset-${side}`)) || 0);
  return { top: inset("top"), right: inset("right"), bottom: inset("bottom"), left: inset("left") };
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

/** Where a light lights the floor from: a bulb from its middle, a 4 ft panel from the middles of its thirds. */
function emittersOf(type: string, at: Point): Point[] {
  const foot = footprintOf(type);
  if (!foot) return [at];
  const third = Math.max(foot.width, foot.height) / 3;
  const along = foot.width > foot.height ? { x: third, y: 0 } : { x: 0, y: third };
  return [-1, 0, 1].map((k) => ({ x: at.x + k * along.x, y: at.y + k * along.y }));
}

/** The floor a light at `o` lights, as a fan from it (closed back on its first edge). */
function fanOf(o: Point, walls: Segment[]): Float32Array {
  const poly = visibility(o, walls, REACH_MM);
  const fan = new Float32Array((poly.length + 2) * 2);
  fan.set([o.x, o.y]);
  poly.forEach((p, i) => fan.set([p.x, p.y], 2 + i * 2));
  fan.set([poly[0]?.x ?? o.x, poly[0]?.y ?? o.y], fan.length - 2);
  return fan;
}

/**
 * The simulated light's sources for this floor's lights where they're drawn
 * now: what each can see (cached by spot, as working it out takes a moment),
 * the light each gives right now, and a key that changes when any moves.
 */
function lightSources(frame: Frame | null, lights: PlacedLight[], plan: Floor | null, at: (l: PlacedLight) => Point, cache: Map<string, Float32Array>) {
  const gamut = screenGamut();
  const sources: Source[] = [];
  const flux: number[] = [];
  const spots: string[] = [];
  if (cache.size > 4000) cache.clear();
  for (const l of lights) {
    const t = seenOf(frame?.lights.get(l.id), l.type);
    const from = emittersOf(l.type, at(l));
    const rgb = t && t.brightness > 0 ? lightRgb(t.a, t.b, gamut) : null;
    const lumens = t ? (t.brightness * LUMENS_PER_BRIGHTNESS) / from.length : 0;
    for (const p of from) {
      const spot = `${plan?.id}:${Math.round(p.x)}:${Math.round(p.y)}`;
      let fan = cache.get(spot);
      if (!fan) cache.set(spot, (fan = fanOf(p, plan?.walls ?? [])));
      sources.push({ x: p.x, y: p.y, fan, bare: baseType(l.type) === "relay" });
      flux.push(...(rgb ? rgb.map((v) => v * lumens) : [0, 0, 0]));
      spots.push(spot);
    }
  }
  return { sources, flux: new Float32Array(flux), spots: spots.join(" ") };
}

/** Put the plan and the grid under it where the view says. */
function placeBackdrop(grid: HTMLElement, el: HTMLElement | null, plan: Floor | null, view: View) {
  Object.assign(grid.style, gridStyle(view));
  if (!el || !plan) return;
  const box = plan.viewBox;
  el.style.left = `${view.ox + box.x * view.scale}px`;
  el.style.top = `${view.oy + box.y * view.scale}px`;
  el.style.width = `${box.width * view.scale}px`;
  el.style.height = `${box.height * view.scale}px`;
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * A grid in plan millimeters under the plan, its spacing following the zoom
 * (it fades out toward the edges of the map: see .map-grid).
 */
function gridStyle(view: View): CSSProperties {
  const { minor, major, minorAlpha } = gridFor(view.scale);
  const line = (alpha: number, dir: string) => `linear-gradient(${dir}, rgb(255 250 240 / ${alpha}) 1px, transparent 1px)`;
  const m = minor * view.scale;
  const M = major * view.scale;
  const at = `${view.ox}px ${view.oy}px`;
  return {
    backgroundImage: [line(0.06, "to right"), line(0.06, "to bottom"), line(0.03 * minorAlpha, "to right"), line(0.03 * minorAlpha, "to bottom")].join(", "),
    backgroundSize: `${M}px ${M}px, ${M}px ${M}px, ${m}px ${m}px, ${m}px ${m}px`,
    backgroundPosition: `${at}, ${at}, ${at}, ${at}`,
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

/** The light under the pointer, as LightsSummary says it (or, moving lights, where it is). */
function LightTooltip({ light, at, view, width, moving }: { light: PlacedLight; at: Point; view: View; width: number; moving: boolean }) {
  const x = view.ox + at.x * view.scale;
  const y = view.oy + at.y * view.scale;
  const flip = x > width - 220;
  const where = light.rail ? `${(light.rail.mm_along / 1000).toFixed(2)} m along its rail` : `${(at.x / 1000).toFixed(2)} m, ${(at.y / 1000).toFixed(2)} m`;
  return (
    <Tooltip x={flip ? x - 16 : x + 16} y={y} side={flip ? "left" : "right"}>
      <LightsSummary lights={[light]} size="small" />
      {moving && <span className="mono tooltip-value">{where}</span>}
    </Tooltip>
  );
}

/** The lights a box being dragged out would select, as LightsSummary says them, over the top of them (under, near the top). */
function SelectionCard({ lights, at, view, width }: { lights: PlacedLight[]; at: (l: PlacedLight) => Point; view: View; width: number }) {
  // Over the middle of them, or under them if that's too near the top.
  const xs = lights.map((l) => view.ox + at(l).x * view.scale);
  const ys = lights.map((l) => view.oy + at(l).y * view.scale);
  const x = Math.min(width - 130, Math.max(130, (Math.min(...xs) + Math.max(...xs)) / 2));
  // Clear of the rings round them (see draw).
  const half = (l: PlacedLight) => {
    const foot = footprintOf(l.type);
    return foot ? (foot.height / 2) * view.scale : Math.max(MARKER_MIN, BULB_MM * view.scale);
  };
  const top = Math.min(...lights.map((l, i) => ys[i]! - half(l))) - 14;
  const bottom = Math.max(...lights.map((l, i) => ys[i]! + half(l))) + 14;
  const above = top > 110;
  const y = above ? top : bottom;
  return (
    <Tooltip x={x} y={y} side={above ? "above" : "below"}>
      <LightsSummary lights={lights} size="small" />
    </Tooltip>
  );
}

interface Scene {
  /** What each light is making now. */
  frame: Frame | null;
  /** Draw each light's glow (where the simulated light can't run). */
  glow: boolean;
  size: Size;
  view: View;
  lights: PlacedLight[];
  spacing: number;
  positionOf: (l: PlacedLight) => Point;
  selected: ReadonlySet<number>;
  /** Other people's selections: each light's colors, added into its ring. */
  others: ReadonlyMap<number, Rgb[]>;
  /** The light under the pointer. */
  hovered: number | null;
  /** Pointed out from a panel: hovered too. */
  hinted: ReadonlySet<number>;
  /** Selected lights what's pointed out from a panel would let go of. */
  leaving: ReadonlySet<number>;
  /** What the gesture under way on the map would do: its rings go by it alone. */
  preview: Preview | null;
  /** Your own rings' color. */
  mine: Rgb;
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
  // In Display P3 where the screen shows it, so saturated lights aren't cut down to sRGB.
  const gamut = screenGamut();
  const ctx = c.getContext("2d", { colorSpace: gamut })!;
  const dpr = c.width / size.width;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Transparent, so the grid and floor plan underneath show through.
  ctx.clearRect(0, 0, size.width, size.height);

  drawRails(ctx, s);

  const { frame } = s;
  const reach = s.spacing * view.scale;
  const items = s.lights.map((l) => {
    const p = s.positionOf(l);
    const t = seenOf(frame?.lights.get(l.id), l.type);
    // How bright it looks (cube root of its light), and its color at full.
    const level = t ? lookOf(t.brightness) : 0;
    const rgb = t && level > 0.01 ? swatch(t.a, t.b, gamut) : null;
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
      r: foot ? 0 : Math.max(MARKER_MIN, BULB_MM * view.scale),
    };
  });

  // Glows add up where they overlap, like light does. Each is kept within
  // about half the gap to its neighbors, so lights read as separate.
  ctx.globalCompositeOperation = "lighter";
  for (const it of items) {
    if (!it.rgb || !s.glow) continue;
    const halo = Math.max(it.r * 2.5, reach * (0.36 + 0.26 * it.level));
    // Panels glow in an ellipse around their footprint.
    const rx = it.w ? it.w / 2 + halo * 0.6 : halo;
    const ry = it.h ? it.h / 2 + halo * 0.6 : halo;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, cssColor(it.rgb, gamut, 0.7 * it.level));
    grad.addColorStop(0.22, cssColor(it.rgb, gamut, 0.32 * it.level));
    grad.addColorStop(0.6, cssColor(it.rgb, gamut, 0.07 * it.level));
    grad.addColorStop(1, cssColor(it.rgb, gamut, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";

  // Each light: a panel as its footprint, a bulb as a disc. Lit, the light's
  // color pushed toward white as it brightens, with a small glow round it in
  // its color (brighter, the brighter it is). Off, just its outline in the
  // rail's color (a little stronger than the rail): the floor shows through,
  // but not the rail, which is cut away under it. Round it, a ring whose line
  // says what it is to your selection (selection.ts: solid selected, dashed
  // hovered, dotted about to be let go of, none otherwise), never faded.
  // Selected by anyone else too, it's still the one ring, in everyone's
  // colors added together, yours among them while it's anything to you
  // (shared/presence.ts: ringOf); just theirs, a solid ring in their color.
  // With a gesture under way, straight from the change it would make: what it
  // takes in that ends up selected is hovered, what's selected and won't be
  // is leaving. Else the light under a finger, and what the panels point out.
  const p = s.preview;
  for (const it of items) {
    const selected = s.selected.has(it.id);
    const hovered = p ? p.targets.has(it.id) && p.next.has(it.id) : s.hovered === it.id;
    const leaving = p ? selected && !p.next.has(it.id) : s.leaving.has(it.id);
    const style = ringStyle(selected, hovered || s.hinted.has(it.id), leaving);
    ctx.beginPath();
    if (it.w) ctx.roundRect(it.x - it.w / 2, it.y - it.h / 2, it.w, it.h, Math.min(3, it.w / 4, it.h / 4));
    else ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
    if (!it.rgb) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "rgba(226,214,192,0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // The glow: drawn twice, a wide soft one and a tighter one, so it reads
      // round the dot without washing the floor out.
      ctx.save();
      const size = it.w ? Math.min(it.w, it.h) : it.r * 2;
      ctx.fillStyle = cssColor(it.rgb.map((v) => v + (1 - v) * (0.25 + 0.5 * it.level)) as Vec3, gamut);
      ctx.shadowColor = cssColor(it.rgb, gamut, 0.45 + 0.45 * it.level);
      ctx.shadowBlur = Math.max(12, Math.min(28, size * 1.1));
      ctx.fill();
      ctx.shadowColor = cssColor(it.rgb, gamut, 0.5 + 0.5 * it.level);
      ctx.shadowBlur = Math.max(6, Math.min(16, size * 0.6));
      ctx.fill();
      ctx.restore();
    }
    const theirs = s.others.get(it.id) ?? [];
    const ring = ringOf(style === "none" ? theirs : [s.mine, ...theirs]);
    if (ring) {
      ctx.beginPath();
      if (it.w) ctx.roundRect(it.x - it.w / 2 - 4, it.y - it.h / 2 - 4, it.w + 8, it.h + 8, 5);
      else ctx.arc(it.x, it.y, it.r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = cssRgb(ring);
      ctx.lineWidth = 1.5;
      ctx.lineCap = style === "dotted" ? "round" : "butt";
      ctx.setLineDash(RING_DASH[style === "none" ? "solid" : style]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = "butt";
    }
  }

  if (s.measure) drawLength(ctx, view, s.measure);

  if (s.box) {
    const { box } = s;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    ctx.fillStyle = "rgba(255,250,242,0.05)";
    ctx.fillRect(x, y, w, h);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(255,250,242,0.55)";
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
    ctx.strokeStyle = `rgba(226,214,192,${alpha})`;
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
        ctx.fillStyle = "#0b0b0c";
        ctx.fill();
        ctx.strokeStyle = "#fffaf2";
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
  ctx.font = '500 11px "Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = nx < -0.7 ? "right" : nx > 0.7 ? "left" : "center";
  ctx.textBaseline = "middle";
  const text = formatLength(railLength(r));
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(6,6,7,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#f4f0e8";
  ctx.fillText(text, x, y);
}
