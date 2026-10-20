// arclamp's health, as it changes (/v1/scene/health/events): what /api/health
// and /api/status answer with, rather than asking arclamp on every request.
// Whether arclamp is reachable, and takes vibes' key, is how following it
// last went: connected, or why not.

import type { HealthResponse } from "../shared/arclamp.ts";
import type { EventHandlers, Following } from "./event-stream.ts";

export type ArclampReach = "ok" | "rejected" | "unreachable";

export function createHealthWatch(follow: (on: EventHandlers) => Following) {
  let latest: HealthResponse | null = null;
  // Null until it's first connected or failed.
  let reach: ArclampReach | null = null;
  const following = follow({
    open: () => (reach = "ok"),
    event(name, data) {
      if (name !== "health") return;
      latest = JSON.parse(data) as HealthResponse;
      reach = "ok";
    },
    failed: (status) => (reach = status === 401 || status === 403 ? "rejected" : "unreachable"),
  });
  return {
    /** The health as arclamp last said, if it has. */
    latest: () => latest,
    /** Whether vibes can reach arclamp, as far as it knows yet (null before it's tried). */
    reach: () => reach,
    stop: () => following.stop(),
  };
}

export type HealthWatch = ReturnType<typeof createHealthWatch>;
