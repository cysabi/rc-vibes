// Types for arclamp's HTTP API (rclamp backend/docs/api-reference.md) and the
// decoder for its packed binary light stream. Shared by the server and the
// browser.

/** Channel name → value. Lemtone lights: a, b, brightness (1.0 = 1000 lm), fidelity; old bulbs: brightness. */
export type Channels = Record<string, number>;

export interface RoomTemplate {
  lights: Record<string, Channels>;
}

export interface PortInfo {
  proto: string;
  host: string;
  port: number;
  multicast?: string[];
}

export type ShaderState = "running" | "error" | "restarting";

export interface ShaderDescriptor {
  id: number;
  type: "roomtone" | "js";
  position: number;
  script?: string;
  template?: RoomTemplate;
  state: ShaderState;
  muted: boolean;
  /** Lights this shader may not change (there its output is its input). Omitted when none. */
  mask?: number[];
  /**
   * Lights this shader is trying to change: where its output differed from its input within the
   * last second, before its mask or mute (take those off for what it actually changes). Omitted
   * when none, and by arclamp before it reported this.
   */
  changing?: number[];
  error?: string;
  ports?: PortInfo[];
  /** Omitted when zero; -1 on the roomtone. */
  respawns?: number;
  created_by: string;
  created_at?: string;
  modified_by: string;
  modified_at?: string;
}

/** Where a light is: millimeters on its floor's plan (origin at the building's top-left wall corner). */
export interface Coords {
  mm_x: number;
  mm_y: number;
  floor: number;
}

/** A point on a floor's plan, in millimeters. */
export interface RailPoint {
  mm_x: number;
  mm_y: number;
}

/** A straight run of track on one floor, which lights hang on. */
export interface Rail {
  id: string;
  floor: number;
  from: RailPoint;
  to: RailPoint;
}

/** Where a light hangs: this far along a rail from its `from` end. */
export interface RailSpot {
  id: string;
  mm_along: number;
}

export interface LightInfo {
  id: number;
  type: string;
  tags: string[] | null;
  /** Null until the light has been placed. (arclamp before rclamp#2 sends "".) */
  coords: Coords | null;
  /** The rail the light hangs on, if any; its coords follow from it. (arclamp before rclamp#3 leaves this out.) */
  rail: RailSpot | null;
  /** Channel names, in the order the stream packs them. */
  channels: string[];
}

export interface LightsResponse {
  id_width: 1 | 2;
  /** (arclamp before rclamp#3 leaves this out.) */
  rails: Rail[];
  lights: LightInfo[];
}

/** A light's coords from arclamp, or null for anything that isn't a placement. */
export function normalizeCoords(raw: unknown): Coords | null {
  if (!raw || typeof raw !== "object") return null;
  const { mm_x, mm_y, floor } = raw as Record<string, unknown>;
  return typeof mm_x === "number" && typeof mm_y === "number" && typeof floor === "number" ? { mm_x, mm_y, floor } : null;
}

export const sameCoords = (a: Coords | null, b: Coords | null) =>
  a === b || (!!a && !!b && a.mm_x === b.mm_x && a.mm_y === b.mm_y && a.floor === b.floor);

export function normalizeRailSpot(raw: unknown): RailSpot | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, mm_along } = raw as Record<string, unknown>;
  return typeof id === "string" && typeof mm_along === "number" ? { id, mm_along } : null;
}

export const sameRailSpot = (a: RailSpot | null, b: RailSpot | null) =>
  a === b || (!!a && !!b && a.id === b.id && a.mm_along === b.mm_along);

/** GET /v1/lights, filled out the same way whichever arclamp sent it. */
export function normalizeLights(raw: LightsResponse): LightsResponse {
  return {
    id_width: raw.id_width,
    rails: Array.isArray(raw.rails) ? raw.rails : [],
    lights: raw.lights.map((l) => ({ ...l, coords: normalizeCoords(l.coords), rail: normalizeRailSpot(l.rail) })),
  };
}

export interface HealthNode {
  id: number;
  state: ShaderState;
  muted: boolean;
  error?: string;
  uptime_s?: number;
  respawns?: number;
}

export interface RadioHealth {
  name: string;
  connected: boolean;
  port?: string;
  channel: number;
  rate: number;
  pps: number;
  dropped: number;
  tx_err: number;
  tx_fail: number;
  lat_avg_us: number;
  lat_max_us: number;
}

export interface HealthResponse {
  nodes: HealthNode[];
  radios: RadioHealth[];
  dry_run: boolean;
}

/** A light's state in one frame: channel name → value. */
export interface Frame {
  initialTime: number;
  lights: Map<number, Channels>;
}

const HEADER_BYTES = 12;
const FORMAT_REV = 1;

/**
 * Decode one binary frame from arclamp's live stream (format_rev 1):
 *
 *   u64 LE initial_time, u16 LE light_count, u16 LE format_rev,
 *   then per light: id (u8 or u16 LE by id_width), u8 channel mask, and one
 *   f32 LE per set mask bit, lowest ordinal first. Ordinals follow the
 *   channel order from GET /v1/lights.
 */
export function decodeFrame(data: ArrayBuffer | Uint8Array, layout: LightsResponse): Frame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER_BYTES) throw new Error("frame shorter than header");
  const initialTime = Number(view.getBigUint64(0, true));
  const count = view.getUint16(8, true);
  const rev = view.getUint16(10, true);
  if (rev !== FORMAT_REV) throw new Error(`unsupported frame format_rev ${rev}`);

  const names = channelNames(layout);
  const lights = new Map<number, Channels>();
  let at = HEADER_BYTES;
  const need = (n: number) => {
    if (at + n > bytes.byteLength) throw new Error("truncated frame");
  };
  for (let i = 0; i < count; i++) {
    need(layout.id_width + 1);
    const id = layout.id_width === 2 ? view.getUint16(at, true) : view.getUint8(at);
    at += layout.id_width;
    const mask = view.getUint8(at++);
    const ordinals = names.get(id) ?? [];
    const channels: Channels = {};
    for (let bit = 0; bit < 8; bit++) {
      if (!(mask & (1 << bit))) continue;
      need(4);
      const value = view.getFloat32(at, true);
      at += 4;
      const name = ordinals[bit];
      if (name !== undefined) channels[name] = value;
    }
    lights.set(id, channels);
  }
  return { initialTime, lights };
}

const namesCache = new WeakMap<LightsResponse, Map<number, string[]>>();

function channelNames(layout: LightsResponse): Map<number, string[]> {
  let names = namesCache.get(layout);
  if (!names) {
    names = new Map(layout.lights.map((l) => [l.id, l.channels]));
    namesCache.set(layout, names);
  }
  return names;
}
