import { serve, type ServerType } from "@hono/node-server";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepo, headOf, serveGit } from "./git.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });

let dir: string;
let server: ServerType;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vibes-git-test-"));
  // Just git's smart HTTP, as vibes serves it at /git/<id>.git.
  server = serve({
    fetch: (req) => {
      const m = /^\/git\/([^/]+)\.git(\/.*)$/.exec(new URL(req.url).pathname)!;
      return serveGit(path.join(dir, "repos"), m[1]!, m[2]!, req, "tester");
    },
    port: 0,
    hostname: "127.0.0.1",
  });
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("sketch repos", () => {
  it("start with one commit on main, by whoever made them", async () => {
    await createRepo(path.join(dir, "repos"), "first", { name: "Ada", email: "ada@x.invalid" }, "Start it", {
      "main.ts": "export const update = (p) => p;\n",
      "lib/notes.md": "hi\n",
    });
    const head = await headOf(path.join(dir, "repos"), "first");
    expect(head?.by).toBe("Ada");
    expect(Date.now() - head!.at).toBeLessThan(60_000);
    expect(await headOf(path.join(dir, "repos"), "missing")).toBeNull();
  });

  it("clone, and take pushes, over HTTP", async () => {
    const repos = path.join(dir, "repos");
    await createRepo(repos, "shared", { name: "Ada", email: "ada@x.invalid" }, "Start it", { "main.ts": "1\n" });
    const work = path.join(dir, "work");
    await git(dir, "clone", "--quiet", `${base}/git/shared.git`, work);
    expect(await readdir(work)).toContain("main.ts");

    await writeFile(path.join(work, "main.ts"), "2\n");
    await git(work, "-c", "user.name=Grace", "-c", "user.email=grace@x.invalid", "commit", "--quiet", "-am", "Two");
    await git(work, "push", "--quiet", "origin", "main");
    expect((await headOf(repos, "shared"))?.by).toBe("Grace");
  });
});
