// Sketches' canonical repos, with the real git: making one with its first
// commit, reading main's latest commit (or any branch's), and serving them
// over HTTP (git's own http-backend) for boxes to clone from and push to.

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const run = promisify(execFile);

/** No system or user config: only what's asked for here, and in each repo. */
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

export interface Author {
  name: string;
  email: string;
}

async function git(args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run("git", args, { env: { ...GIT_ENV, ...env }, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const authorEnv = (a: Author) => ({
  GIT_AUTHOR_NAME: a.name,
  GIT_AUTHOR_EMAIL: a.email,
  GIT_COMMITTER_NAME: "vibes",
  GIT_COMMITTER_EMAIL: "vibes@vibes.invalid",
});

export const repoPath = (dir: string, id: string) => path.join(dir, `${id}.git`);

/**
 * A new bare repo at <dir>/<id>.git whose main has one commit, by `author`,
 * holding `files` (path → contents). It takes pushes over HTTP, and keeps a
 * log of where each branch has been, so nothing pushed over is lost for good.
 */
export async function createRepo(dir: string, id: string, author: Author, message: string, files: Record<string, string>) {
  const bare = repoPath(dir, id);
  await mkdir(dir, { recursive: true });
  await git(["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  await git(["-C", bare, "config", "http.receivepack", "true"]);
  await git(["-C", bare, "config", "core.logAllRefUpdates", "always"]);
  const work = await mkdtemp(path.join(tmpdir(), "vibes-sketch-"));
  try {
    await git(["init", "--quiet", "--initial-branch=main", work]);
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(work, name)), { recursive: true });
      await writeFile(path.join(work, name), contents);
    }
    await git(["-C", work, "add", "--all"]);
    await git(["-C", work, "commit", "--quiet", "-m", message], authorEnv(author));
    await git(["-C", work, "push", "--quiet", bare, "main"]);
  } catch (err) {
    await rm(bare, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Whether a name is a plain branch name, as vibes takes one: letters, digits
 * and . _ - /, in parts that don't start with a dot. Git allows more; this is
 * enough, and never a path out of the repo or an option.
 */
export const isBranchName = (s: string) =>
  s.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) && !/\.\.|\/\/|\/\.|\.lock$|[/.]$/.test(s);

/** A commit's full hash: a branch's head, or a hash (whole or short) the repo has; null if it hasn't. */
export async function resolveCommit(dir: string, id: string, rev: string): Promise<string | null> {
  const hash = /^[0-9a-f]{4,40}$/.test(rev);
  if (!hash && !isBranchName(rev)) return null;
  try {
    const ref = hash ? rev : `refs/heads/${rev}`;
    return (await git(["-C", repoPath(dir, id), "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * A branch's head right now, read from the repo's own files rather than by
 * running git (it's asked for every look at the scene); null if there's no
 * such branch.
 */
export function branchHead(dir: string, id: string, branch: string): string | null {
  if (!isBranchName(branch)) return null;
  const repo = repoPath(dir, id);
  const sha = (s: string | undefined) => (s && /^[0-9a-f]{40,64}$/.test(s) ? s : null);
  try {
    return sha(readFileSync(path.join(repo, "refs", "heads", branch), "utf8").trim());
  } catch {
    // Not a loose ref: packed, maybe.
  }
  try {
    for (const line of readFileSync(path.join(repo, "packed-refs"), "utf8").split("\n")) {
      const [hash, ref] = line.split(" ");
      if (ref === `refs/heads/${branch}`) return sha(hash);
    }
  } catch {
    // No packed refs either.
  }
  return null;
}

/** Whether a commit is on a branch (its head, or before it); not if the repo hasn't got it. */
export async function isOnBranch(dir: string, id: string, commit: string, branch: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !isBranchName(branch)) return false;
  try {
    await git(["-C", repoPath(dir, id), "merge-base", "--is-ancestor", commit, `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** A commit's files, as a tar, as git makes it. */
export function archive(dir: string, id: string, commit: string): ReadableStream<Uint8Array> {
  const child = spawn("git", ["-C", repoPath(dir, id), "archive", "--format=tar", commit], { env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] });
  return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
}

/** main's latest commit: which (its full hash), when (ms) and by whom. */
export async function headOf(dir: string, id: string): Promise<{ commit: string; at: number; by: string } | null> {
  try {
    const out = await git(["-C", repoPath(dir, id), "log", "-1", "--format=%H%x00%ct%x00%an", "main"]);
    const [commit, at, by] = out.trim().split("\0");
    return { commit: commit ?? "", at: Number(at) * 1000, by: by ?? "" };
  } catch {
    return null;
  }
}

/**
 * Git's smart HTTP for one repo, from git http-backend (a CGI program): the
 * request's body goes in, and its answer comes back as a Response, headers
 * first, then the body as it's made. `rest` is the path after <id>.git, e.g.
 * /info/refs or /git-upload-pack.
 */
export async function serveGit(dir: string, id: string, rest: string, req: Request, user: string): Promise<Response> {
  const url = new URL(req.url);
  const child = spawn("git", ["http-backend"], {
    env: {
      ...GIT_ENV,
      GIT_PROJECT_ROOT: dir,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${id}.git${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers.get("content-type") ?? "",
      HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
      GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
      REMOTE_USER: user,
      REMOTE_ADDR: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (req.body) Readable.fromWeb(req.body as never).pipe(child.stdin);
  else child.stdin.end();

  // The CGI headers, up to the blank line; the rest is the body. One reader
  // for both, which leaves the stream open when the headers are done.
  const chunks = child.stdout.iterator({ destroyOnReturn: false });
  let head = Buffer.alloc(0);
  let end = -1;
  while (end < 0) {
    const next = await chunks.next();
    if (next.done) break;
    head = Buffer.concat([head, next.value as Buffer]);
    end = head.indexOf("\r\n\r\n");
  }
  if (end < 0) return new Response("git http-backend gave no answer", { status: 502 });
  const headers = new Headers();
  let status = 200;
  for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers.append(name, value);
  }
  const first = head.subarray(end + 4);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (first.length) controller.enqueue(first);
      for await (const chunk of chunks) controller.enqueue(chunk as Buffer);
      controller.close();
    },
  });
  return new Response(body, { status, headers });
}
