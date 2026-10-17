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

/** What vibes knows about a shader that arclamp doesn't. */
export interface ShaderMeta {
  name: string;
  createdBy: Person;
  modifiedBy: Person;
  /**
   * arclamp never clears a shader's error, even after a later script runs
   * fine. This is the error that was already showing at the last successful
   * save through vibes, so the UI can hide it.
   */
  seenError: string | null;
}

export interface SceneNode extends ShaderDescriptor {
  /** Null for shaders created outside vibes, and for the roomtone. */
  meta: ShaderMeta | null;
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

export interface Status {
  /** Whether vibes can reach arclamp's API with its key. */
  arclamp: "ok" | "unreachable" | "rejected";
  /** Whether vibes is connected to arclamp's live light stream. */
  stream: boolean;
}

export type ActivityAction =
  | "shader.create"
  | "shader.edit"
  | "shader.rename"
  | "shader.delete"
  | "shader.move"
  | "shader.mute"
  | "shader.unmute"
  | "roomtone.set"
  | "scene.clear"
  | "lights.move"
  | "lights.turn"
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
