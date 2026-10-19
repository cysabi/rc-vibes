// For tests: a box runner whose boxes are little servers here, each its agent
// until it's claimed (with the claim token it was booted with) and VS Code
// after.

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BoxRunner } from "./boxes.ts";

export interface FakeBox {
  image: string;
  target: string;
  server: http.Server;
  /** What it was claimed with. */
  claim?: { box: string; env: Record<string, string> };
  /** Whether it's been asked if it's waiting. */
  asked: boolean;
}

export function fakeBoxRunner() {
  const boxes = new Map<string, FakeBox>();
  const ended = new Set<string>();
  const homesRemoved = new Set<string>();

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
          b.claim = JSON.parse(Buffer.concat(chunks).toString()) as FakeBox["claim"];
          res.writeHead(204).end();
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
    async removeHomes(ids) {
      for (const id of ids) homesRemoved.add(id);
    },
  };

  return {
    runner,
    boxes,
    /** The homes it's been asked to erase. */
    homesRemoved,
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
