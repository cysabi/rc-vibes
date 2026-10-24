// Boxes as Docker containers on this machine, for local development: each a
// container vibes-<name>, answering on a port of 127.0.0.1 Docker picks, with
// everyone's homes in one volume (BOX_HOMES) at /homes, for its agent to take
// the one it's claimed for from. Builds too, each a container from the same
// image, with just what it needs to start Nix's daemon and then the build as
// uid 1000.
//
// A vibes knows its own by their label (vibes.box, vibes.build), and takes
// any others it finds with it for leftovers of its own, to remove. A second
// vibes on the same Docker (BOX_SCOPE) labels and names its own apart
// (vibes.box.<scope>, vibes-<scope>-<name>), so neither ever sees the other's.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BOX_CAPABILITIES, type BoxRunner } from "./boxes.ts";
import { BUILD_CAPABILITIES, type BuildRunner } from "./builds.ts";
import type { SketchesConfig } from "./env.ts";

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();

/** Runs `use` with the env (tokens) in a file only it can read, not on the command line. */
async function withEnvFile<T>(env: Record<string, string>, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "vibes-box-"));
  try {
    const file = path.join(dir, "env");
    await writeFile(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function dockerRunner(sketches: SketchesConfig): BoxRunner & BuildRunner {
  // This vibes' own: its containers' names, and their labels (by key, as Docker filters by them).
  const prefix = sketches.scope ? `vibes-${sketches.scope}-` : "vibes-";
  const container = (name: string) => `${prefix}${name}`;
  const boxLabel = sketches.scope ? `vibes.box.${sketches.scope}` : "vibes.box";
  const buildLabel = sketches.scope ? `vibes.build.${sketches.scope}` : "vibes.build";

  async function removeContainer(name: string) {
    try {
      await docker("rm", "--force", container(name));
    } catch (err) {
      if (!/No such container/i.test(String((err as { stderr?: string }).stderr))) throw err;
    }
  }

  async function find(name: string): Promise<string | null> {
    const running = await docker("inspect", "--format", "{{.State.Running}}", container(name)).catch(() => "");
    if (running !== "true") return null;
    const port = await docker("port", container(name), "3000/tcp").catch(() => "");
    const m = /:(\d+)\s*$/m.exec(port.split("\n")[0] ?? "");
    return m ? `http://127.0.0.1:${m[1]}` : null;
  }

  return {
    find,

    async boot(name, image, env) {
      await withEnvFile(env, (file) =>
        docker(
          "run",
          "--detach",
          "--name",
          container(name),
          "--label",
          `${boxLabel}=1`,
          "--publish",
          "127.0.0.1::3000",
          "--volume",
          `${sketches.homes}:/homes`,
          // Just what its agent needs.
          "--cap-drop",
          "ALL",
          ...BOX_CAPABILITIES.flatMap((c) => ["--cap-add", c]),
          "--security-opt",
          "apparmor=unconfined",
          "--env-file",
          file,
          image,
        ),
      );
      for (let tries = 0; tries < 50; tries++) {
        const target = await find(name);
        if (target) return target;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the container started, but has no port");
    },

    remove: removeContainer,

    async startBuild(name, image, command, env) {
      await withEnvFile(env, (file) =>
        docker(
          "run",
          "--detach",
          "--name",
          container(name),
          "--label",
          `${buildLabel}=1`,
          "--user",
          "0:0",
          "--cap-drop",
          "ALL",
          ...BUILD_CAPABILITIES.flatMap((c) => ["--cap-add", c]),
          "--security-opt",
          "no-new-privileges",
          "--memory",
          "2g",
          "--env-file",
          file,
          "--entrypoint",
          command[0]!,
          image,
          ...command.slice(1),
        ),
      );
    },

    async buildState(name) {
      const status = await docker("inspect", "--format", "{{.State.Status}}", container(name)).catch(() => null);
      return status === null ? "gone" : status === "created" || status === "running" ? "running" : "ended";
    },

    removeBuild: removeContainer,

    async builds() {
      const names = await docker("ps", "--all", "--filter", `label=${buildLabel}`, "--format", "{{.Names}}");
      return names
        .split("\n")
        .filter((n) => n.startsWith(prefix))
        .map((n) => n.slice(prefix.length));
    },

    async list(image) {
      const ids = (await docker("ps", "--quiet", "--filter", `label=${boxLabel}`)).split("\n").filter(Boolean);
      if (!ids.length) return [];
      const want = await docker("image", "inspect", "--format", "{{.Id}}", image);
      const out = await docker("inspect", "--format", "{{.Name}} {{.Image}}", ...ids);
      return out
        .split("\n")
        .map((line) => line.split(" "))
        .filter(([n]) => n!.replace(/^\//, "").startsWith(prefix))
        .map(([n, id]) => ({ name: n!.replace(/^\//, "").slice(prefix.length), current: id === want }));
    },
  };
}
