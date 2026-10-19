// Here: one light, now. Everything a sketch is made of (its functions, its
// fields, and their parameters) takes a `here` and gives back what that
// light should do. A field's transforms (rotate, kaleid, delay, ...) change
// where and when it looks (x, y, t), never which light it is (light).
//
// Positions are in meters from the building's top-left wall corner (floors
// share one frame), and u, v run 0 to 1 across the room the lights fill.
//
// What arclamp sends is read leniently: a light with no channels, coords that
// aren't coords (older arclamps sent ""), or tags that aren't a list is taken
// as having none.

import { Color, off } from "./color.ts";
import type { Coords, Prev, PrevLight } from "./arclamp.ts";
import { LUMENS_PER_BRIGHTNESS } from "./lemtone.ts";
import { hash } from "./shape.ts";

/** Where a light hangs on its rail. */
export interface RailSpot {
  id: string;
  /** Meters from the rail's start. */
  along: number;
  /** 0 at the rail's start, 1 at its last light. */
  t: number;
  /** Its place on the rail, from 0 at the start. */
  index: number;
  /** How many lights hang on the rail. */
  count: number;
}

/** A rail, as the lights on it tell it (arclamp doesn't give sketches the rails themselves). */
export interface Rail {
  id: string;
  /** Its lights, from its start. */
  lights: readonly Light[];
  /** Meters from its start to its last light. */
  length: number;
}

export class Light {
  readonly id: number;
  /** "color" for color bulbs and panels; "switch" for old bulbs, which only go on and off. */
  readonly kind: "color" | "switch";
  readonly tags: readonly string[];
  /** Whether it's on the plan; one that isn't sits at the room's center. */
  readonly placed: boolean;
  readonly floor: number | null;
  /** Meters from the building's left wall. */
  readonly x: number;
  /** Meters from the building's top wall. */
  readonly y: number;
  /** The rail it hangs on, or null. */
  rail: RailSpot | null = null;
  /** A number from 0 to 1 of its own, the same every time: for giving each light its own beat or shade. */
  readonly random: number;
  /** What the layers below this sketch are making it do. */
  below: Color = off;
  /** Whether the layers below have it on (for an old bulb), or lit at all (for a color light). */
  belowOn = false;
  /** Its own memory, kept from one tick to the next. */
  state: Record<string, any> = {};

  constructor(p: PrevLight, x: number, y: number) {
    const coords = coordsOf(p);
    this.id = p.id;
    this.kind = isSwitch(p) ? "switch" : "color";
    this.tags = Object.freeze([...tagsOf(p)]);
    this.placed = !!coords;
    this.floor = coords?.floor ?? null;
    this.x = x;
    this.y = y;
    this.random = hash(p.id, 0x5eed);
  }

  has(tag: string): boolean {
    return this.tags.includes(tag);
  }
}

export class Room {
  /** Every light, in arclamp's order. */
  readonly lights: readonly Light[];
  readonly rails: readonly Rail[];
  /** The left and top edges of the room the lights fill, in meters. */
  readonly x0: number;
  readonly y0: number;
  /** How wide (left to right) and deep (top to bottom) that room is, in meters. */
  readonly width: number;
  readonly depth: number;
  readonly center: { readonly x: number; readonly y: number };
  private readonly byId: Map<number, Light>;
  private readonly railsById: Map<string, Rail>;

  constructor(lights: Light[], rails: Rail[], bounds: { x0: number; y0: number; width: number; depth: number }) {
    this.lights = lights;
    this.rails = rails;
    this.x0 = bounds.x0;
    this.y0 = bounds.y0;
    this.width = bounds.width;
    this.depth = bounds.depth;
    this.center = Object.freeze({ x: bounds.x0 + bounds.width / 2, y: bounds.y0 + bounds.depth / 2 });
    this.byId = new Map(lights.map((l) => [l.id, l]));
    this.railsById = new Map(rails.map((r) => [r.id, r]));
  }

  light(id: number): Light | undefined {
    return this.byId.get(id);
  }

  rail(id: string): Rail | undefined {
    return this.railsById.get(id);
  }

  /** The lights with this tag. */
  tagged(tag: string): Light[] {
    return this.lights.filter((l) => l.has(tag));
  }
}

export class Here {
  /** Where it's looking, in meters (the light's own place, unless a transform moved it). */
  readonly x: number;
  readonly y: number;
  /** Seconds since the sketch started (unless a transform moved it), by the frames' own time. */
  readonly t: number;
  /** Seconds since the last tick: about 0.01 in the room, 0.03 in the preview. */
  readonly dt: number;
  /** The frame's time, in milliseconds since 1970 (the same for every layer of it): for things that follow the time of day. */
  readonly now: number;
  readonly light: Light;
  readonly room: Room;

  constructor(x: number, y: number, t: number, dt: number, now: number, light: Light, room: Room) {
    this.x = x;
    this.y = y;
    this.t = t;
    this.dt = dt;
    this.now = now;
    this.light = light;
    this.room = room;
  }

  /** 0 at the room's left edge, 1 at its right. */
  get u(): number {
    return (this.x - this.room.x0) / this.room.width;
  }

  /** 0 at the room's top edge, 1 at its bottom. */
  get v(): number {
    return (this.y - this.room.y0) / this.room.depth;
  }

  /** The same light, looking from somewhere else, or at another time. */
  at(p: { x?: number; y?: number; t?: number }): Here {
    return new Here(p.x ?? this.x, p.y ?? this.y, p.t ?? this.t, this.dt, this.now, this.light, this.room);
  }
}

// ---- reading arclamp's lights -------------------------------------------------------

const NO_TAGS: readonly string[] = Object.freeze([]);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A light's coords, if they are some. */
function coordsOf(p: PrevLight): Coords | null {
  const c = p.coords as Partial<Coords> | null | undefined;
  return c && typeof c === "object" && finite(c.mm_x) && finite(c.mm_y) ? (c as Coords) : null;
}

/** A light's rail, if it has one. */
function railOf(p: PrevLight): { id: string; mm_along: number } | null {
  const r = p.rail as { id?: unknown; mm_along?: unknown } | null | undefined;
  return r && typeof r === "object" && (typeof r.id === "string" || typeof r.id === "number") && finite(r.mm_along)
    ? { id: String(r.id), mm_along: r.mm_along }
    : null;
}

function tagsOf(p: PrevLight): readonly string[] {
  return Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : NO_TAGS;
}

const channelsOf = (p: PrevLight): Record<string, number> => (p.channels && typeof p.channels === "object" ? p.channels : {});

const isSwitch = (p: PrevLight) => "on" in channelsOf(p);

// The layout each room was made from, to tell when arclamp's has changed.
const layouts = new WeakMap<Room, Snapshot[]>();

interface Snapshot {
  id: number;
  switch: boolean;
  coords: Coords | null;
  rail: { id: string; mm_along: number } | null;
  tags: readonly string[];
}

const snapshot = (p: PrevLight): Snapshot => {
  const c = coordsOf(p);
  return { id: p.id, switch: isSwitch(p), coords: c && { ...c }, rail: railOf(p), tags: [...tagsOf(p)] };
};

/** The room in `prev`, keeping each light's memory from `before` (lights move, and come and go). */
export function roomOf(prev: Prev, before?: Room | null): Room {
  const list = Array.isArray(prev?.lights) ? prev.lights : [];
  const placed = list.map(coordsOf).filter((c): c is Coords => !!c);
  const xs = placed.map((c) => c.mm_x / 1000);
  const ys = placed.map((c) => c.mm_y / 1000);
  const x0 = xs.length ? Math.min(...xs) : 0;
  const y0 = ys.length ? Math.min(...ys) : 0;
  const width = Math.max(1, xs.length ? Math.max(...xs) - x0 : 0);
  const depth = Math.max(1, ys.length ? Math.max(...ys) - y0 : 0);
  const cx = x0 + width / 2;
  const cy = y0 + depth / 2;

  const lights = list.map((p) => {
    const c = coordsOf(p);
    const light = new Light(p, c ? c.mm_x / 1000 : cx, c ? c.mm_y / 1000 : cy);
    const old = before?.light(p.id);
    if (old) light.state = old.state;
    return light;
  });

  const onRails = new Map<string, { light: Light; along: number }[]>();
  list.forEach((p, i) => {
    const rail = railOf(p);
    if (!rail) return;
    const entries = onRails.get(rail.id) ?? [];
    entries.push({ light: lights[i]!, along: rail.mm_along / 1000 });
    onRails.set(rail.id, entries);
  });
  const rails: Rail[] = [];
  for (const [id, entries] of onRails) {
    entries.sort((a, b) => a.along - b.along);
    const length = entries[entries.length - 1]!.along;
    entries.forEach(({ light, along }, index) => {
      light.rail = { id, along, t: length > 0 ? along / length : 0, index, count: entries.length };
    });
    rails.push({ id, lights: entries.map((e) => e.light), length });
  }

  const room = new Room(lights, rails, { x0, y0, width, depth });
  layouts.set(room, list.map(snapshot));
  return room;
}

/** Whether `prev`'s lights are the ones `room` was made from, in the same places. */
export function sameLayout(prev: Prev, room: Room): boolean {
  const known = layouts.get(room);
  const list = Array.isArray(prev?.lights) ? prev.lights : [];
  if (!known || known.length !== list.length) return false;
  for (let i = 0; i < known.length; i++) {
    const a = known[i]!;
    const p = list[i]!;
    if (a.id !== p.id || a.switch !== isSwitch(p)) return false;
    const c = coordsOf(p);
    if (!(a.coords === c || (a.coords && c && a.coords.mm_x === c.mm_x && a.coords.mm_y === c.mm_y && a.coords.floor === c.floor))) return false;
    const r = railOf(p);
    if (!(a.rail === r || (a.rail && r && a.rail.id === r.id && a.rail.mm_along === r.mm_along))) return false;
    const tags = tagsOf(p);
    if (a.tags.length !== tags.length || a.tags.some((t, k) => t !== tags[k])) return false;
  }
  return true;
}

/** What a light's channels say it's making, as a color: an old bulb that's on is a warm 800 lm. */
export function colorOf(p: PrevLight, kind: Light["kind"]): Color {
  const ch = channelsOf(p);
  const n = (k: string, d: number) => (finite(ch[k]) ? ch[k] : d);
  if (kind === "switch") return Color.from({ on: n("on", 0) });
  return new Color(n("a", 0), n("b", 0), n("brightness", 0) * LUMENS_PER_BRIGHTNESS, n("fidelity", 1));
}
