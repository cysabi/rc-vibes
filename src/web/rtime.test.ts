import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTime, heard, pageNow, rNow, rOfEvent } from "./rtime.ts";

// The page's clock, held still: it's read more than once in a test.
beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(5000);
});
afterEach(() => {
  forgetTime();
  vi.restoreAllMocks();
});

describe("arclamp's time, in a page", () => {
  it("is the page's own till vibes has answered", () => {
    expect(rNow()).toBe(pageNow());
  });

  it("is what vibes said, less the middle of the round trip; of the last few, the quickest's", () => {
    const at = performance.timeOrigin;
    // arclamp is 55 ms ahead: an answer saying r at the middle of its round trip.
    heard(at + 100, at + 140, at + 120 + 55, 2);
    expect(rNow()).toBeCloseTo(pageNow() + 55, 9);
    // A quicker one, a little off (its say came early in the trip): kept.
    heard(at + 200, at + 210, at + 204 + 55, 2);
    expect(rNow()).toBeCloseTo(pageNow() + 54, 9);
    // A slower one isn't.
    heard(at + 300, at + 380, at + 300 + 55, 2);
    expect(rNow()).toBeCloseTo(pageNow() + 54, 9);
    expect(rOfEvent({ timeStamp: 1234 })).toBeCloseTo(at + 1234 + 54, 9);
  });

  it("forgets an answer once there've been enough since", () => {
    const at = performance.timeOrigin;
    heard(at, at + 2, at + 1 + 10, null);
    for (let i = 1; i <= 8; i++) heard(at + 100 * i, at + 100 * i + 20, at + 100 * i + 10 + 30, null);
    expect(rNow() - pageNow()).toBeCloseTo(30, 9);
  });

  it("passes over an answer that came before it was asked", () => {
    heard(10, 5, 100, null);
    expect(rNow()).toBe(pageNow());
  });
});
