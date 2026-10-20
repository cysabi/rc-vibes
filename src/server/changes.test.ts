import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changesIn } from "./changes.ts";
import { createRepo, repoPath } from "./git.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
const me = ["-c", "user.name=Ada", "-c", "user.email=ada@x.invalid"];

let dir: string;
let repos: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vibes-changes-test-"));
  repos = path.join(dir, "repos");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A sketch with its repo in vibes', and a home with a clone of it, as a box leaves one. */
async function cloned() {
  const id = `sketch-${++n}`;
  await createRepo(repos, id, { name: "Ada", email: "ada@x.invalid" }, "Start it", { "main.ts": "wave\n", ".gitignore": "node_modules/\n" });
  const home = path.join(dir, `home-${n}`);
  const clone = path.join(home, "sketches", id, "sketch");
  await mkdir(path.dirname(clone), { recursive: true });
  await git(dir, "clone", "--quiet", repoPath(repos, id), clone);
  return { id, home, clone };
}

describe("changes in someone's clone", () => {
  it("are none without a clone, or with one as main has it", async () => {
    expect(await changesIn(path.join(dir, "nobody"), repos, "sketch-x")).toBeNull();
    const { id, home } = await cloned();
    expect(await changesIn(home, repos, id)).toEqual({ files: 0, commits: 0 });
  });

  it("count files changed or new, but not ignored ones, and commits main hasn't got", async () => {
    const { id, home, clone } = await cloned();
    await writeFile(path.join(clone, "main.ts"), "wave faster\n");
    await writeFile(path.join(clone, "notes.md"), "new\n");
    await mkdir(path.join(clone, "node_modules"));
    await writeFile(path.join(clone, "node_modules", "x.js"), "ignored\n");
    expect(await changesIn(home, repos, id)).toEqual({ files: 2, commits: 0 });

    await git(clone, ...me, "commit", "--quiet", "-am", "faster");
    await git(clone, ...me, "add", "notes.md");
    await git(clone, ...me, "commit", "--quiet", "-m", "notes");
    expect(await changesIn(home, repos, id)).toEqual({ files: 0, commits: 2 });

    await git(clone, "push", "--quiet", "origin", "main");
    expect(await changesIn(home, repos, id)).toEqual({ files: 0, commits: 0 });
  });

  it("are read without running anything the clone names", async () => {
    const { id, home, clone } = await cloned();
    const ran = path.join(dir, `ran-${n}`);
    // git would run these: an fsmonitor on status, and hooks.
    await git(clone, "config", "core.fsmonitor", `touch ${ran}`);
    await writeFile(path.join(clone, ".git", "hooks", "post-index-change"), `#!/bin/sh\ntouch ${ran}\n`);
    await chmod(path.join(clone, ".git", "hooks", "post-index-change"), 0o755);
    await writeFile(path.join(clone, "main.ts"), "changed\n");
    expect(await changesIn(home, repos, id)).toEqual({ files: 1, commits: 0 });
    expect(existsSync(ran)).toBe(false);
  });

  it("never follow a link out of the clone", async () => {
    const { id, home, clone } = await cloned();
    const secret = path.join(dir, `secret-${n}`);
    await writeFile(secret, "vibes' own\n");
    // A file that's a link: counted as the link it is, not read through.
    await symlink(secret, path.join(clone, "leak"));
    expect(await changesIn(home, repos, id)).toEqual({ files: 1, commits: 0 });

    // A .git that's a link to someone else's: no clone, as far as vibes reads.
    const other = await cloned();
    await rm(path.join(clone, ".git"), { recursive: true });
    await symlink(path.join(other.clone, ".git"), path.join(clone, ".git"));
    expect(await changesIn(home, repos, id)).toBeNull();

    // A folder on the way to the clone that's a link to someone else's: no clone either.
    const third = await cloned();
    await rm(path.join(third.home, "sketches"), { recursive: true });
    await symlink(path.join(other.home, "sketches"), path.join(third.home, "sketches"));
    expect(await changesIn(third.home, repos, other.id)).toBeNull();
  });
});
