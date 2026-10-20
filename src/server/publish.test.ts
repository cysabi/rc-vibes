// box/publish.sh, as a box's agent runs it: against real git, a sketch's repo
// as vibes keeps it, and a clone as a box leaves one.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepo, headOf, repoPath } from "./git.ts";

const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dirname, "../../box/publish.sh");
const env = (home: string) => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
const git = (home: string, cwd: string, ...args: string[]) => run("git", args, { cwd, env: env(home) });

let dir: string;
let repos: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vibes-publish-test-"));
  repos = path.join(dir, "repos");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A sketch, a home with a clone of it, and someone else's clone, to push to main meanwhile. */
async function sketch() {
  const id = `sketch-${++n}`;
  await createRepo(repos, id, { name: "Ada", email: "ada@x.invalid" }, "Start it", { "main.ts": "wave\n", "README.md": "hi\n", ".gitignore": "node_modules/\n" });
  const home = path.join(dir, `home-${n}`);
  const clone = path.join(home, "sketches", id, "sketch");
  await mkdir(path.dirname(clone), { recursive: true });
  await git(home, dir, "clone", "--quiet", repoPath(repos, id), clone);
  const other = path.join(dir, `other-${n}`);
  await git(home, dir, "clone", "--quiet", repoPath(repos, id), other);
  /** Someone else's commit, pushed to main. */
  const elsewhere = async (file: string, text: string) => {
    await writeFile(path.join(other, file), text);
    await git(home, other, "-c", "user.name=Grace", "-c", "user.email=g@x.invalid", "commit", "--quiet", "-am", `${file}, elsewhere`);
    await git(home, other, "push", "--quiet", "origin", "main");
  };
  /** box/publish.sh, run in their box: how it ended, and what it said last. */
  const publish = async () => {
    try {
      const { stdout } = await run("bash", ["-euo", "pipefail", SCRIPT], {
        env: {
          ...env(home),
          VIBES_FOLDER: clone,
          VIBES_USER_NAME: "Rose",
          VIBES_USER_EMAIL: "rose@x.invalid",
          VIBES_BOX_TOKEN: "token",
          VIBES_GIT_URL: repoPath(repos, id),
          VIBES_COMMIT_MESSAGE: "Added to the room with these changes",
        },
      });
      return { code: 0, said: stdout.trim().split("\n").at(-1) };
    } catch (err) {
      const e = err as { code: number; stdout: string };
      return { code: e.code, said: e.stdout.trim().split("\n").at(-1) };
    }
  };
  const main = async () => (await headOf(repos, id))!.commit;
  const show = async (file: string) => (await git(home, dir, "-C", repoPath(repos, id), "show", `main:${file}`)).stdout;
  return { id, home, clone, elsewhere, publish, main, show };
}

describe("publishing someone's changes", () => {
  it("commits what isn't committed and pushes it to main, ignored files aside", async () => {
    const s = await sketch();
    await writeFile(path.join(s.clone, "main.ts"), "wave faster\n");
    await writeFile(path.join(s.clone, "notes.md"), "new\n");
    await mkdir(path.join(s.clone, "node_modules"));
    await writeFile(path.join(s.clone, "node_modules", "x.js"), "ignored\n");
    expect(await s.publish()).toEqual({ code: 0, said: `pushed ${await s.main()}` });
    expect(await s.show("main.ts")).toBe("wave faster\n");
    expect(await s.show("notes.md")).toBe("new\n");
    await expect(s.show("node_modules/x.js")).rejects.toThrow();
    // Their clone is just as if they'd synced.
    expect((await git(s.home, s.clone, "status", "--porcelain")).stdout).toBe("");
    expect((await git(s.home, s.clone, "rev-parse", "HEAD", "origin/main")).stdout.split("\n").slice(0, 2)).toEqual([await s.main(), await s.main()]);
    expect((await git(s.home, s.clone, "log", "-1", "--format=%an %s")).stdout.trim()).toBe("Rose Added to the room with these changes");
  });

  it("puts their commits on top of what's been pushed since, in one line", async () => {
    const s = await sketch();
    await writeFile(path.join(s.clone, "main.ts"), "wave faster\n");
    await git(s.home, s.clone, "-c", "user.name=Rose", "-c", "user.email=r@x.invalid", "commit", "--quiet", "-am", "faster");
    await writeFile(path.join(s.clone, "notes.md"), "new\n");
    await s.elsewhere("README.md", "hello\n");
    expect((await s.publish()).code).toBe(0);
    expect(await s.show("README.md")).toBe("hello\n");
    expect(await s.show("main.ts")).toBe("wave faster\n");
    expect((await git(s.home, s.clone, "rev-list", "--merges", "main")).stdout).toBe("");
    const log = (await git(s.home, s.clone, "log", "--format=%s", "main")).stdout.trim().split("\n");
    expect(log).toEqual(["Added to the room with these changes", "faster", "README.md, elsewhere", "Start it"]);
  });

  it("pushes nothing when their changes clash with main's, and leaves their commit and clone as they were", async () => {
    const s = await sketch();
    const before = await s.main();
    await writeFile(path.join(s.clone, "main.ts"), "mine\n");
    await s.elsewhere("main.ts", "theirs\n");
    const pushedElsewhere = await s.main();
    expect(await s.publish()).toEqual({ code: 3, said: "clash" });
    expect(await s.main()).toBe(pushedElsewhere);
    expect(pushedElsewhere).not.toBe(before);
    expect(await readFile(path.join(s.clone, "main.ts"), "utf8")).toBe("mine\n");
    expect(existsSync(path.join(s.clone, ".git", "rebase-merge"))).toBe(false);
    expect((await git(s.home, s.clone, "status", "--porcelain")).stdout).toBe("");
    expect((await git(s.home, s.clone, "log", "-1", "--format=%s")).stdout.trim()).toBe("Added to the room with these changes");
  });

  it("leaves a clone in the middle of a rebase alone", async () => {
    const s = await sketch();
    await mkdir(path.join(s.clone, ".git", "rebase-merge"));
    await writeFile(path.join(s.clone, "main.ts"), "mine\n");
    const before = await s.main();
    expect(await s.publish()).toEqual({ code: 4, said: "busy: rebase-merge" });
    expect(await s.main()).toBe(before);
  });

  it("pushes to main from a clone still on a branch of its person's own", async () => {
    const s = await sketch();
    await git(s.home, s.clone, "switch", "--quiet", "--create", "rose-kodsi-hall");
    await writeFile(path.join(s.clone, "main.ts"), "from my branch\n");
    expect((await s.publish()).code).toBe(0);
    expect(await s.show("main.ts")).toBe("from my branch\n");
  });
});
