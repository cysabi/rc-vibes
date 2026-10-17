import { describe, expect, it } from "vitest";
import type { LightInfo } from "../shared/arclamp.ts";
import { baseState, mergeOutput, prevOf } from "./sim.ts";

const light = (id: number, channels: string[]): LightInfo => ({ id, type: "br30", tags: null, coords: null, rail: null, channels });
const lights = [light(1, ["a", "b", "brightness", "fidelity"]), light(64, ["on"])];

describe("the preview's room", () => {
  it("starts from room tone, with every channel set", () => {
    const state = baseState(lights, { "1": { a: 0.06, b: 0.13, brightness: 0.7 } });
    expect(state.get(1)).toEqual({ a: 0.06, b: 0.13, brightness: 0.7, fidelity: 0 });
    expect(state.get(64)).toEqual({ on: 0 });
  });

  it("shows shaders the room below them, with each light's metadata", () => {
    const state = baseState(lights, {});
    const prev = prevOf(state, lights, 5);
    expect(prev.initial_time).toBe(5);
    expect(prev.lights[1]).toEqual({ id: 64, channels: { on: 0 }, tags: [], coords: null, rail: null });
  });

  it("merges a shader's output channel by channel, as arclamp does", () => {
    const state = baseState(lights, { "1": { a: 0.06, b: 0.13, brightness: 0.7, fidelity: 1 } });
    const next = mergeOutput(state, lights, {
      lights: [
        { id: 1, channels: { brightness: 1.4, a: null, b: "x", nope: 1 } },
        { id: 64, channels: { on: 1 } },
        { id: 999, channels: { on: 1 } },
      ],
    });
    // Out of range passes through; null, strings and unknown channels and lights don't.
    expect(next.get(1)).toEqual({ a: 0.06, b: 0.13, brightness: 1.4, fidelity: 1 });
    expect(next.get(64)).toEqual({ on: 1 });
    expect(next.has(999)).toBe(false);
    // The state below is left alone.
    expect(state.get(1)!.brightness).toBe(0.7);
  });

  it("ignores output that isn't a list of lights", () => {
    const state = baseState(lights, {});
    expect(mergeOutput(state, lights, { lights: "all" })).toBe(state);
    expect(mergeOutput(state, lights, null)).toBe(state);
  });
});
