// Boxes as Docker containers on this machine, for local development: each a
// container named vibes-box-<id>, with a volume of the same name for its
// files, answering on a port of 127.0.0.1 Docker picks.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BoxRunner } from "./boxes.ts";

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args)).stdout.trim();
const name = (id: string) => `vibes-box-${id}`;

/** The container's image, and whether it's running, or null if there's none. */
async function inspect(id: string): Promise<{ image: string; running: boolean } | null> {
  try {
    const [image, running] = (await docker("inspect", "--format", "{{.Image}} {{.State.Running}}", name(id))).split(" ");
    return { image: image!, running: running === "true" };
  } catch {
    return null;
  }
}

export function dockerRunner(): BoxRunner {
  async function find(id: string): Promise<string | null> {
    const c = await inspect(id);
    if (!c?.running) return null;
    const port = await docker("port", name(id), "3000/tcp").catch(() => "");
    const m = /:(\d+)\s*$/m.exec(port.split("\n")[0] ?? "");
    return m ? `http://127.0.0.1:${m[1]}` : null;
  }

  return {
    find,

    async start(id, image, env) {
      let c = await inspect(id);
      // A box made from an older image is made again (its files are in its volume).
      const want = await docker("image", "inspect", "--format", "{{.Id}}", image);
      if (c && c.image !== want) {
        await docker("rm", "--force", name(id));
        c = null;
      }
      if (!c) {
        // The env (the box's tokens) in a file, not on the command line.
        const dir = await mkdtemp(path.join(tmpdir(), "vibes-box-"));
        try {
          const file = path.join(dir, "env");
          await writeFile(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
          await docker("create", "--name", name(id), "--label", `vibes.box=${id}`, "--publish", "127.0.0.1::3000", "--volume", `${name(id)}:/home/workspace`, "--env-file", file, image);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      if (!c?.running) await docker("start", name(id));
      for (let tries = 0; tries < 50; tries++) {
        const target = await find(id);
        if (target) return target;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the container started, but has no port");
    },

    async stop(id) {
      await docker("stop", "--time", "5", name(id));
    },

    async running() {
      const out = await docker("ps", "--filter", "label=vibes.box", "--format", '{{.Label "vibes.box"}}');
      return out.split("\n").filter(Boolean);
    },
  };
}
