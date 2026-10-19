// Boxes as Docker containers on this machine, for local development: each a
// container vibes-<name>, answering on a port of 127.0.0.1 Docker picks, with
// everyone's homes in one volume (BOX_HOMES) at /homes, for its agent to take
// the one it's claimed for from.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BoxRunner } from "./boxes.ts";
import type { SketchesConfig } from "./env.ts";

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();
const container = (name: string) => `vibes-${name}`;

export function dockerRunner(sketches: SketchesConfig): BoxRunner {
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
      // The env (its claim token) in a file, not on the command line.
      const dir = await mkdtemp(path.join(tmpdir(), "vibes-box-"));
      try {
        const file = path.join(dir, "env");
        await writeFile(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
        await docker(
          "run",
          "--detach",
          "--name",
          container(name),
          "--label",
          "vibes.box=1",
          "--publish",
          "127.0.0.1::3000",
          "--volume",
          `${sketches.homes}:/homes`,
          // Just what its agent needs: to move a home in, and start VS Code as its person.
          "--cap-drop",
          "ALL",
          ...["SYS_ADMIN", "CHOWN", "SETUID", "SETGID", "KILL"].flatMap((c) => ["--cap-add", c]),
          "--security-opt",
          "apparmor=unconfined",
          "--env-file",
          file,
          image,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      for (let tries = 0; tries < 50; tries++) {
        const target = await find(name);
        if (target) return target;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the container started, but has no port");
    },

    async remove(name) {
      try {
        await docker("rm", "--force", container(name));
      } catch (err) {
        if (!/No such container/i.test(String((err as { stderr?: string }).stderr))) throw err;
      }
    },

    async removeHomes(ids) {
      await docker("run", "--rm", "--entrypoint", "rm", "--volume", `${sketches.homes}:/homes`, sketches.image, "-rf", ...ids.map((id) => `/homes/${id}`));
    },

    async list(image) {
      const ids = (await docker("ps", "--quiet", "--filter", "label=vibes.box")).split("\n").filter(Boolean);
      if (!ids.length) return [];
      const want = await docker("image", "inspect", "--format", "{{.Id}}", image);
      const out = await docker("inspect", "--format", "{{.Name}} {{.Image}}", ...ids);
      return out
        .split("\n")
        .map((line) => line.split(" "))
        .map(([n, id]) => ({ name: n!.replace(/^\/(vibes-)?/, ""), current: id === want }));
    },
  };
}
