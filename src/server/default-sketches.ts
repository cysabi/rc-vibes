// vibes' own sketches in the library (shared/default-sketches.ts): each one's
// sketch, and a build of it that's its script (stamped as a build of that
// sketch, by vibes), made as vibes starts. vibes with other code for one (or
// another key) makes another build of it; what's put in from then on runs
// that. The sketches API answers a request to build one with its build, and
// instances.ts puts one in on it.

import { createHash } from "node:crypto";
import { DEFAULT_SKETCHES, defaultSketch, type DefaultSketch } from "../shared/default-sketches.ts";
import type { Person } from "../shared/vibes.ts";
import type { Db } from "./db.ts";
import { stamp } from "./stamp.ts";

/** Who vibes is, in the history, for what it does itself. */
export const VIBES: Person = { id: "vibes", name: "vibes" };

// Their builds are vibes' own, not the builder's.
const BUILDER = "vibes";

const sha = (algo: string, s: string) => createHash(algo).update(s).digest("hex");

export interface DefaultSketchesDeps {
  signingKey: string;
  db: Db;
  /** A default sketch's script, built (base-color-script.ts). */
  script: (s: DefaultSketch) => Promise<string>;
}

export function createDefaultSketches({ signingKey, db, script }: DefaultSketchesDeps) {
  // Each one's build, once made; and while it's being made, so it's made once.
  const made = new Map<string, Promise<string>>();

  /** Its sketch, and a build of it that's its script: made, if they aren't. Its build's id. */
  async function make(s: DefaultSketch): Promise<string> {
    const body = await script(s);
    const stamped = stamp(body, { sketch: s.id, commit: sha("sha1", body), builder: BUILDER }, signingKey);
    const row = db.sketch(s.id);
    if (!row) db.addSketch({ id: s.id, name: s.name, by_id: VIBES.id, by_name: VIBES.name, at: Date.now() });
    else if (row.deleted_at !== null) db.restoreSketch(s.id);
    // Made when it was called something else (Tone was Base Color): its name now.
    if (row && row.name !== s.name) db.renameSketch(s.id, s.name);
    // A build for each script and key.
    const id = `${s.entry}-${sha("sha256", stamped).slice(0, 16)}`;
    if (!db.build(id)) {
      db.addBuild({ id, sketch_id: s.id, commit_sha: sha("sha1", body), builder: BUILDER, by_id: VIBES.id, by_name: VIBES.name, at: Date.now() });
      db.finishBuild(id, { state: "built", finished_at: Date.now(), plan: `vibes' own (src/default-sketches/${s.entry}.ts)`, error: null, log: "", script: stamped });
    }
    return id;
  }

  /** A default sketch's build (made, if it isn't yet): its id. */
  function build(id: string): Promise<string> {
    const s = defaultSketch(id);
    if (!s) return Promise.reject(new Error(`${id} isn't one of vibes' own sketches`));
    let p = made.get(id);
    if (!p) {
      p = make(s);
      made.set(id, p);
      // Couldn't (its script wouldn't build): tried again next time it's asked for.
      p.catch(() => made.delete(id));
    }
    return p;
  }

  return {
    build,

    /** Every one made: as vibes starts. */
    async start() {
      for (const s of DEFAULT_SKETCHES) {
        await build(s.id).catch((err: Error) => console.warn(`${s.name}: couldn't build it: ${err.message}`));
      }
    },
  };
}

export type DefaultSketches = ReturnType<typeof createDefaultSketches>;
