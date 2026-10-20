// Whether someone's editor has changes to a sketch that main hasn't got, for
// adding it to the room to ask about: files changed and not committed, and
// commits not pushed. vibes reads their home itself (mounted read-only, at
// BOX_HOMES_MOUNT), so asking never wakes a box.
//
// A clone is its person's, and so is everything in it, its .git included.
// git itself would run what that names (hooks, an fsmonitor, filters), so
// vibes never runs git there: isomorphic-git, which runs nothing, reads it
// (changes.worker.ts), in a worker of its own, so a malformed index or pack
// can at worst stop that worker (at TIME_MS, or past MEMORY_MB). Whether a
// commit of theirs is on main is asked of vibes' own repo, with real git.

import path from "node:path";
import { Worker } from "node:worker_threads";
import { cloneInHome } from "./boxes.ts";
import type { Ask, Read } from "./changes.worker.ts";
import { isOnBranch } from "./git.ts";

export interface Changes {
  /** Files changed (or new, or gone) and not committed. */
  files: number;
  /** Commits not on main. */
  commits: number;
}

const TIME_MS = 10_000;
const MEMORY_MB = 256;
// How far back from theirs main's latest is looked for; a clone further from it than that says this many.
const DEPTH = 100;

/** What the clone of sketch `id` in `home` has that main (in `sketches`, vibes' repos) hasn't; null if there's no clone. Throws if it can't be read. */
export async function changesIn(home: string, sketches: string, id: string): Promise<Changes | null> {
  const read = await inWorker({ home, clone: path.join(home, cloneInHome(id)), depth: DEPTH });
  if ("error" in read) throw new Error(read.error);
  if (!read.clone) return null;
  let commits = 0;
  for (const commit of read.commits) {
    if (await isOnBranch(sketches, id, commit, "main")) break;
    commits++;
  }
  return { files: read.files, commits };
}

function inWorker(ask: Ask): Promise<Read> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./changes.worker.ts", import.meta.url), { workerData: ask, resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("reading the clone took too long"));
    }, TIME_MS);
    worker.once("message", (r: Read) => {
      clearTimeout(timer);
      resolve(r);
      void worker.terminate();
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`reading the clone stopped (${code})`));
    });
  });
}
