// For tests: a box runner whose boxes are little servers here, each its agent
// until it's claimed (with the claim token it was booted with) and VS Code
// after; or, claimed for a job, answering as the job's agent would (onJob).

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BoxRunner } from "./boxes.ts";

export interface FakeBox {
  image: string;
  target: string;
  server: http.Server;
  /** What it was claimed with. */
  claim?: { box: string; env: Record<string, string>; job?: string };
  /** Whether it's been asked if it's waiting. */
  asked: boolean;
}

export interface JobResult {
  code: number;
  said: string;
  output: string;
}

export function fakeBoxRunner() {
  const boxes = new Map<string, FakeBox>();
  const ended = new Set<string>();
  let job: (claim: NonNullable<FakeBox["claim"]>) => JobResult | Promise<JobResult> = () => ({ code: 0, said: `pushed ${"a".repeat(40)}`, output: "" });

  const end = (name: string) => {
    const b = boxes.get(name);
    b?.server.close();
    b?.server.closeAllConnections();
  };

  const runner: BoxRunner = {
    async boot(name, image, env) {
      const server = http.createServer((req, res) => {
        const b = boxes.get(name)!;
        if (b.claim) return void res.writeHead(200).end("VS Code");
        if (req.url !== "/claim") return void res.writeHead(503).end();
        if (req.method === "GET") {
          b.asked = true;
          return void res.writeHead(204).end();
        }
        if (req.headers.authorization !== `Bearer ${env.VIBES_CLAIM_TOKEN}`) return void res.writeHead(401).end();
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const claim = JSON.parse(Buffer.concat(chunks).toString()) as NonNullable<FakeBox["claim"]>;
          b.claim = claim;
          if (claim.job === undefined) return void res.writeHead(204).end();
          void Promise.resolve(job(claim)).then((r) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(r)));
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      boxes.set(name, { image, target, server, asked: false });
      return target;
    },
    find: async (name) => (boxes.has(name) && !ended.has(name) ? boxes.get(name)!.target : null),
    async remove(name) {
      end(name);
      boxes.delete(name);
    },
    list: async (image) => [...boxes].map(([name, b]) => ({ name, current: b.image === image })),
  };

  return {
    runner,
    boxes,
    /** What a box claimed for a job does, and says. */
    onJob(f: typeof job) {
      job = f;
    },
    /** Ends a box behind vibes' back (it's still listed, but not running). */
    crash(name: string) {
      ended.add(name);
      end(name);
    },
    close() {
      for (const name of boxes.keys()) end(name);
    },
  };
}
