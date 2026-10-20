// Reads one person's clone of a sketch from their home, for changes.ts, in a
// worker of its own: what's changed from its last commit (statusMatrix), and
// the commits up to that one, latest first. The clone is theirs, and so is
// everything in it, so it's read through a view that never follows a symlink
// (each folder on the way must be a real one, and a file is opened only if it
// isn't a link), never leaves the clone, never reads a file past MAX_BYTES,
// and never writes (isomorphic-git would, to keep the index's file times up
// to date; here that does nothing).

import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import git from "isomorphic-git";

export interface Ask {
  /** Their home, and the clone in it, as vibes sees them. */
  home: string;
  clone: string;
  /** How many commits back to list, at most. */
  depth: number;
}

export type Read = { clone: false } | { clone: true; files: number; commits: string[] } | { error: string };

// Larger than any sketch's own files; past it, the clone can't be read.
const MAX_BYTES = 32 * 1024 * 1024;

const missing = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: "ENOENT" });

/** A read-only view of `root` and what's under it, as isomorphic-git asks for files (fs.promises). */
export function confined(root: string) {
  /** `p`, made absolute, if it's `root` or under it, every folder on the way from `root` a real one (`p` itself may be anything). */
  async function within(p: string): Promise<string> {
    const at = path.resolve(p);
    const rel = path.relative(root, at);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw missing(p);
    let dir = root;
    for (const part of rel ? rel.split(path.sep).slice(0, -1) : []) {
      dir = path.join(dir, part);
      const s = await lstat(dir).catch(() => null);
      if (!s?.isDirectory()) throw missing(p);
    }
    return at;
  }
  const nothing = async () => undefined;
  return {
    async readFile(p: string, opts?: { encoding?: BufferEncoding } | BufferEncoding) {
      // Opened only if it's a file itself, not a link to one.
      const file = await open(await within(p), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
        throw missing(p);
      });
      try {
        const s = await file.stat();
        if (!s.isFile()) throw missing(p);
        if (s.size > MAX_BYTES) throw new Error(`${path.relative(root, p)} is too big to read`);
        const data = await file.readFile();
        const encoding = typeof opts === "string" ? opts : opts?.encoding;
        return encoding ? data.toString(encoding) : data;
      } finally {
        await file.close();
      }
    },
    // What's at a path, never what a link there points to.
    lstat: async (p: string): Promise<Stats> => lstat(await within(p)),
    stat: async (p: string): Promise<Stats> => lstat(await within(p)),
    async readdir(p: string) {
      const at = await within(p);
      if (!(await lstat(at)).isDirectory()) throw missing(p);
      return readdir(at);
    },
    readlink: async (p: string, opts?: { encoding?: BufferEncoding | "buffer" }) => readlink(await within(p), opts as never),
    writeFile: nothing,
    mkdir: nothing,
    rmdir: nothing,
    unlink: nothing,
    symlink: nothing,
  };
}

async function read({ home, clone, depth }: Ask): Promise<Read> {
  const fs = { promises: confined(clone) };
  const gitdir = path.join(clone, ".git");
  // No clone (or nothing committed in it): nothing to say. Each folder on the
  // way to it is theirs too, so must be a real one.
  try {
    await confined(home).readdir(clone);
  } catch {
    return { clone: false };
  }
  let head: string;
  try {
    head = await git.resolveRef({ fs, gitdir, ref: "HEAD" });
  } catch {
    return { clone: false };
  }
  // Every file that's anything but the same as its last commit: changed, new (and not ignored), gone, or only staged.
  const rows = await git.statusMatrix({ fs, dir: clone, gitdir });
  const files = rows.filter(([, inHead, inDir, staged]) => !(inHead === 1 && inDir === 1 && staged === 1)).length;
  const log = await git.log({ fs, gitdir, ref: head, depth });
  return { clone: true, files, commits: log.map((c) => c.oid) };
}

read(workerData as Ask).then(
  (r) => parentPort!.postMessage(r),
  (err: unknown) => parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) } satisfies Read),
);
