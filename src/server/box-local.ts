// Builds as plain processes on this machine, for development without Docker
// (BOX_RUNNER=local): each build is box/builder.ts, run by this node in a
// folder of its own, with the env a build's container would get (where vibes
// is, and its token). Nothing is sandboxed: it's your own machine. There are
// no boxes: a sketch is edited elsewhere (or made by hand), and only built here.
//
// A sketch's packages are installed with pnpm (sketch-plan.ts); here that's
// npm, behind a pnpm of this folder's own, as the pnpm on a machine may not
// be one a build can use (or be there at all).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoxRunner } from "./boxes.ts";
import type { BuildRunner } from "./builds.ts";

const BUILDER = path.join(import.meta.dirname, "../../box/builder.ts");

const PNPM_AS_NPM = `#!/bin/sh
# pnpm, as npm, for a build run as a process on this machine (box-local.ts).
case "$1" in
  install) exec npm install ;;
  *) exec npm "$@" ;;
esac
`;

export function localRunner(): BoxRunner & BuildRunner {
  const running = new Map<string, { child: ChildProcess; dir: string; ended: boolean }>();

  return {
    async boot() {
      throw new Error("there are no boxes with BOX_RUNNER=local; only builds run here");
    },
    async find() {
      return null;
    },
    async remove() {},
    async list() {
      return [];
    },

    async startBuild(name, _image, _command, env) {
      const dir = await mkdtemp(path.join(tmpdir(), "vibes-build-"));
      const work = path.join(dir, "work");
      const bin = path.join(dir, "bin");
      await mkdir(work);
      await mkdir(bin);
      await writeFile(path.join(bin, "pnpm"), PNPM_AS_NPM, { mode: 0o755 });
      const child = spawn(process.execPath, [BUILDER], {
        cwd: work,
        env: { ...process.env, ...env, VIBES_BUILD_DIR: work, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        stdio: ["ignore", "inherit", "inherit"],
      });
      const build = { child, dir, ended: false };
      running.set(name, build);
      child.on("exit", () => {
        build.ended = true;
      });
      child.on("error", (err) => {
        console.error(`build ${name} couldn't run:`, err.message);
        build.ended = true;
      });
    },

    async buildState(name) {
      const build = running.get(name);
      return !build ? "gone" : build.ended ? "ended" : "running";
    },

    async removeBuild(name) {
      const build = running.get(name);
      if (!build) return;
      running.delete(name);
      if (!build.ended) build.child.kill();
      await rm(build.dir, { recursive: true, force: true });
    },

    async builds() {
      return [...running.keys()];
    },
  };
}
