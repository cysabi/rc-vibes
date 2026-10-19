// Types for vibes' own API (/api/*), shared by the server and the browser.

import type { Coords, LightsResponse, RailSpot, ShaderDescriptor } from "./arclamp.ts";
import type { RailShape } from "./rails.ts";

export interface Person {
  id: string;
  name: string;
}

export interface Me extends Person {
  /** Logged in through VIBES_DEV_LOGIN rather than RC. */
  dev: boolean;
}

export interface LoginOptions {
  rc: boolean;
  dev: boolean;
}

/**
 * A shader in the scene, as vibes passes it on from arclamp, with the sketch
 * it was built from, if its script has vibes' stamp.
 */
export type SceneNode = ShaderDescriptor & { sketch?: ShaderSketch };

/** The sketch a shader was built from, as its stamp says. */
export interface ShaderSketch {
  id: string;
  /** Its name, or null if vibes has no such sketch. */
  name: string | null;
  /** The commit it was built from (its full hash). */
  commit: string;
  /** Changed since it was built, or stamped with a key vibes can't check: not what the stamp says. */
  edited: boolean;
  /** Its sketch has been deleted (and can be restored). */
  deleted: boolean;
}

/** arclamp's lights and rails, with positions, rails and orientations changed in vibes applied. */
export interface Lights extends LightsResponse {
  /** How many lights and rails differ from arclamp's lights.json (not yet exported and deployed). */
  changed: number;
}

/** Where a light is: free on a floor, or hanging on a rail (its coords follow from the rail). */
export type Spot = { coords: Coords } | { rail: RailSpot };

/** A light put somewhere. Coords null takes it off the map. */
export type Placement = { id: number; coords: Coords | null } | { id: number; rail: RailSpot };

/** A rail drawn or moved, or (null) taken away. Lights on a rail taken away stay where they are. */
export interface RailChange {
  id: string;
  rail: RailShape | null;
}

/** A light turned to another orientation, which is another arclamp type (e.g. "4x1-horizontal"). */
export interface TypeChange {
  id: number;
  type: string;
}

/** A light's whole set of tags, as it should be now. */
export interface TagChange {
  id: number;
  tags: string[];
}

export interface Status {
  /** Whether vibes can reach arclamp's API with its key. */
  arclamp: "ok" | "unreachable" | "rejected";
  /** Whether vibes is connected to arclamp's live light stream. */
  stream: boolean;
  /** Whether sketches are on here (SKETCHES=1). */
  sketches: boolean;
}

/**
 * Where a box keeps checkouts of single commits of its sketch, each at
 * <folder>/<commit> beside the clone; vibes' extension makes one when VS Code
 * opens it.
 */
export const BOX_COMMITS_FOLDER = "/home/workspace/commits";

/** A sketch: code made in vibes, kept as a git repo whose `main` is the sketch. */
export interface Sketch {
  id: string;
  name: string;
  createdBy: Person;
  createdAt: number;
  /** The latest commit on main: when, and by whom (the commit's author). */
  updatedAt: number;
  updatedBy: string;
  /** If it's been deleted: when, and by whom. Anyone can restore it, always. */
  deleted?: { at: number; by: string };
}

/**
 * Your box for a sketch: your own VS Code with your own clone of it. `url` is
 * where to open it, once it's ready, and `run` which run of it that is: a box
 * started again is a new run, whose VS Code a page has to load afresh.
 */
export type BoxState =
  | { state: "starting" }
  | { state: "ready"; url: string; run: string }
  | { state: "failed"; error: string };

export type ActivityAction =
  | "shader.create"
  | "shader.edit"
  | "shader.rename"
  | "shader.delete"
  | "shader.move"
  | "shader.mute"
  | "shader.unmute"
  | "shader.mask"
  | "roomtone.set"
  | "scene.clear"
  | "lights.move"
  | "lights.turn"
  | "lights.tag"
  | "rails.change";

export interface ActivityEntry {
  id: number;
  ts: string;
  user: Person;
  action: ActivityAction;
  shaderId: number | null;
  shaderName: string | null;
  detail: Record<string, unknown> | null;
}

export interface ApiError {
  error: string;
  code: string;
}
