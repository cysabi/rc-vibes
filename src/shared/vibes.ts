// Types for vibes' own API (/api/*), shared by the server and the browser.

import type { Coords, LightsResponse, RailSpot, RoomTemplate, ShaderState } from "./arclamp.ts";
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
  /**
   * Where the API and its sockets are, when it's another of vibes' addresses
   * than this page's (its main one: the quickest way to it); null for this
   * page's own. Reached there with a token from this page's own (/auth/token).
   */
  api: string | null;
}

/** A short-lived token for the API at another of vibes' addresses (LoginOptions.api): as `Authorization: Bearer`, and a socket's first message. */
export interface ApiToken {
  token: string;
  /** When it stops working, in ms. */
  exp: number;
}

/**
 * vibes' key for a shader, the same for its whole life: its instance's id,
 * for one put in from a sketch in vibes (while it builds, as once it's live),
 * or "rclamp-<id>" for one vibes only knows by arclamp's id (put in some
 * other way). Nothing's to be read into it.
 */
export type ShaderKey = string;

/**
 * A shader in the stack, as vibes has it: in the room (live), on its way
 * there (building), or not, and why (failed). The browser knows shaders only
 * this way, never as arclamp does.
 */
export interface Shader {
  key: ShaderKey;
  stage: "building" | "failed" | "live";
  /** Its sketch's name, or for one put in some other way, "Shader #<n>". */
  name: string;
  /** How it's running, once it's live. */
  state: ShaderState | null;
  /** Why it's failing (live), or couldn't go in (failed). */
  error: string | null;
  muted: boolean;
  /** The lights it may not change (there its output is its input), sorted. */
  mask: number[];
  /** The sketch it's built from: by its stamp once it's live, by its instance before. */
  sketch: ShaderSketch | null;
  /** Put in from a sketch in vibes: its home, branch and builds. */
  instance: Instance | null;
  /** Who made it, as arclamp has it (the name of the key it was made with); before it's live, who put it in. */
  by: string;
  /** Every light it's changed since its script last did, before its mask or mute: where its code lights. Learned as it runs. */
  footprint: number[];
  /** Its script's sha256, in hex, for the preview to fetch it by; null until it's live. */
  scriptHash: string | null;
  /** Its params' pool (pools/<pool> in the live tree: shared/live.ts); null for one not put in from a sketch. */
  pool: string | null;
}

/**
 * A sketch put in the room from vibes, on a home: the lights it was put on,
 * which it's masked to. It's a shader in vibes' stack from the moment it's put
 * in (its key is this id), building, then live once its build is.
 */
export interface Instance {
  id: string;
  sketchId: string;
  /** Its sketch's name, or null if vibes has no such sketch. */
  sketchName: string | null;
  /** The commit it runs (or will, once built), and its build. */
  commit: string;
  buildId: string;
  /**
   * The branch it was put in from, and that branch's head right now (null if
   * the branch is gone). While they're its commit, it's shown by the branch's
   * name; once the branch moves on, by its commit.
   */
  branch: string;
  head: string | null;
  /** The lights it was put on, by id: it's masked off every other. */
  home: number[];
  /** Building; couldn't go in (error says why); or in the room. */
  state: "building" | "failed" | "live";
  error: string | null;
  /** A newer commit on its way in, while it builds (or why it couldn't). */
  next: { commit: string; buildId: string; state: "building" | "failed"; error: string | null } | null;
  by: Person;
  /** When it was put in, in ms. */
  at: number;
}

/** The room as the scene feed makes it (scene-feed.ts), for the live state (shared/live.ts): the stack of shaders, top first, and the room tone. */
export interface SceneFeed {
  shaders: Shader[];
  roomtone: RoomTemplate | null;
}

/** What a browser says first over the light stream (/api/stream), on a socket to vibes at another address than the page's. */
export type StreamRequest = { type: "auth"; token: string };

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

/** Where a streetview camera stood on the plan, and which way it looked. */
export interface CameraView {
  floor: number;
  mm_x: number;
  mm_y: number;
  /** The way it looks, in degrees clockwise from the plan's +x (the plan's y runs down, as on screen). */
  yaw: number;
  /** How wide it sees, in degrees. */
  hfov: number;
}

/** A place you can see the room from, photographed one bulb channel at a time. */
export interface StreetView extends CameraView {
  id: string;
  /** Who last moved it in vibes; null while it's where its photographs put it. */
  by: Person | null;
}

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
 * Where a box keeps checkouts of single commits of its sketch, beside the
 * clone; vibes' extension makes one when VS Code opens it.
 */
export const BOX_COMMITS_FOLDER = "/home/workspace/commits";

/**
 * The checkout of one commit: in a folder named for the commit, and itself
 * named "sketch", like the clone, so VS Code shows it by that name, not a hash.
 */
export const boxCommitFolder = (commit: string) => `${BOX_COMMITS_FOLDER}/${commit}/sketch`;

/** A sketch: code made in vibes, kept as a git repo whose `main` is the sketch. */
export interface Sketch {
  id: string;
  name: string;
  createdBy: Person;
  createdAt: number;
  /** The latest commit on main: when, and by whom (the commit's author). */
  updatedAt: number;
  updatedBy: string;
  /** And which (its full hash), if it has one. */
  head: string | null;
  /** If it's been deleted: when, and by whom. Anyone can restore it, always. */
  deleted?: { at: number; by: string };
  /** vibes' own (Tone's): added like any other, but with no code to open, fork or delete. */
  builtIn?: true;
}

/**
 * What your editor has of a sketch that its main hasn't: files changed and not
 * committed, and commits not pushed; or that vibes couldn't tell.
 */
export type SketchChanges = { files: number; commits: number } | { unknown: true };

/** A commit of a sketch, built for the room by vibes' builder: its script is stamped. */
export interface Build {
  id: string;
  sketchId: string;
  /** The commit built (its full hash). */
  commit: string;
  /** The builder's version. */
  builder: string;
  state: "building" | "built" | "failed";
  /** Who asked for it, and when; and when it ended. */
  by: string;
  at: number;
  finishedAt: number | null;
  /** How it was built: "vite main.ts", "package.json: pnpm run build", … */
  plan: string | null;
  error: string | null;
  /** What it printed (with the build only, not in lists). */
  log?: string;
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
  | "shader.home"
  | "shader.param"
  | "roomtone.set"
  | "scene.clear"
  | "lights.move"
  | "lights.turn"
  | "lights.tag"
  | "rails.change"
  | "streetview.move";

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
