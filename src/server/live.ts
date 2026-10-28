// The live state, as vibes holds it (shared/live.ts says what it is): the
// tree, how many changes it's been through (rev), and the latest of them,
// for a page that reconnects to catch up on. Each part of it is made
// elsewhere and handed in here: the scene (room tone, the shaders and their
// order) by the scene feed, each time it's made (scene); the layout from the
// lights (layout); the pools by pools.ts, change by change (publish). Every
// change goes to every page at once, as one delta: with its lights set to one
// value as fans, to each page that reads them.

import { randomUUID } from "node:crypto";
import { diff, EMPTY_TREE, fanOps, same, valueAt, withOps, type Layout, type LiveTree, type Op, type Path } from "../shared/live.ts";
import type { Lights, SceneFeed } from "../shared/vibes.ts";

// How many changes are kept for pages catching up; further behind, a page gets the whole tree.
const KEEP = 4000;

/** The scene, as parts of the tree. */
export function sceneParts(feed: SceneFeed): [Path, unknown][] {
  return [
    ["roomtone", feed.roomtone?.lights ?? {}],
    ["shaders", Object.fromEntries(feed.shaders.map((s) => [s.key, s]))],
    ["stack", feed.shaders.map((s) => s.key)],
  ];
}

/** The lights, as the tree has them: keyed, with their order kept beside. */
export function layoutOf(lights: Lights): Layout {
  return {
    id_width: lights.id_width,
    order: lights.lights.map((l) => l.id),
    lights: Object.fromEntries(lights.lights.map((l) => [String(l.id), l])),
    railOrder: lights.rails.map((r) => r.id),
    rails: Object.fromEntries(lights.rails.map((r) => [r.id, r])),
    changed: lights.changed,
  };
}

export function createLiveState(initial: LiveTree = EMPTY_TREE) {
  let tree = initial;
  let rev = 0;
  // This run of vibes: its changes count from 0 again when it starts again.
  const epoch = randomUUID();
  const log: { rev: number; ops: Op[] }[] = [];
  // Each page's, and whether it reads fans.
  const listeners = new Map<(json: string) => void, boolean>();
  const deltaOf = (d: { rev: number; ops: Op[] }, fans: boolean) => JSON.stringify({ type: "delta", rev: d.rev, ops: fans ? fanOps(d.ops) : d.ops });

  /** Changes made, and sent to every page as one delta: only what actually changes. */
  function publish(ops: readonly Op[]) {
    const changing = ops.filter((op) => (op.length === 1 ? valueAt(tree, op[0]) !== undefined : !same(valueAt(tree, op[0]), op[1])));
    if (changing.length === 0) return;
    tree = withOps(tree, changing);
    rev += 1;
    const d = { rev, ops: changing };
    log.push(d);
    if (log.length > KEEP) log.splice(0, log.length - KEEP);
    let plain: string | null = null;
    let fanned: string | null = null;
    for (const [l, fans] of listeners) l(fans ? (fanned ??= deltaOf(d, true)) : (plain ??= deltaOf(d, false)));
  }

  /** Parts of the tree as they are now, each at its path: what changed, as one delta. */
  function replace(parts: [Path, unknown][]) {
    publish(parts.flatMap(([path, value]) => diff(valueAt(tree, path), value, path)));
  }

  return {
    tree: () => tree,
    rev: () => rev,
    publish,
    replace,

    /** The scene, as it's just been made. */
    scene: (feed: SceneFeed) => replace(sceneParts(feed)),

    /** The lights, as they are now. */
    layout: (lights: Lights) => replace([["layout", layoutOf(lights)]]),

    /** What a page that had change `since` of run `of` hasn't: the deltas after it, as messages (with fans, for one that reads them); null if they're not all kept, or are another run's (it gets the tree). */
    since(since: number, of: string | undefined, fans = false): string[] | null {
      if (of !== epoch || since > rev || since < 0) return null;
      if (since === rev) return [];
      const first = log.findIndex((d) => d.rev === since + 1);
      if (first < 0) return null;
      return log.slice(first).map((d) => deltaOf(d, fans));
    },

    /** The whole tree, as a message. */
    state: () => JSON.stringify({ type: "state", rev, epoch, tree }),

    /** Told each delta, as a message (with fans, for one that reads them), as it's made; returns a way to stop. */
    subscribe(listener: (json: string) => void, fans = false) {
      listeners.set(listener, fans);
      return () => void listeners.delete(listener);
    },
  };
}

export type LiveState = ReturnType<typeof createLiveState>;
