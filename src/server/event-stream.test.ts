import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { followEvents, type Following } from "./event-stream.ts";

// arclamp, as far as one event stream goes: each connection handed to `serve`.
let server: http.Server;
let url: string;
let serve: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void;
let connections: http.IncomingMessage[];
let following: Following | null;

beforeEach(async () => {
  connections = [];
  following = null;
  server = http.createServer((req, res) => {
    connections.push(req);
    serve(req, res, connections.length);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/scene/events`;
});

afterEach(async () => {
  following?.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const open = (res: http.ServerResponse) => res.writeHead(200, { "Content-Type": "text/event-stream" });
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};

describe("following an event stream", () => {
  it("hears each event, however its lines are split, with its key", async () => {
    serve = (_req, res) => {
      open(res);
      // In pieces, mid-line and mid-\r\n, with a ping between.
      for (const piece of ["id: 1\nevent: snap", "shot\ndata: [1]\n\n: ping\n\n", "data: a\r", "\ndata: b\r\n\r\n"]) res.write(piece);
    };
    const heard: [string, string, string | null][] = [];
    following = followEvents(url, "the-key", { event: (...e) => heard.push(e) });
    await until(() => heard.length === 2);
    expect(heard).toEqual([
      ["snapshot", "[1]", "1"],
      ["message", "a\nb", null],
    ]);
    expect(connections[0]!.headers.authorization).toBe("Bearer the-key");
  });

  it("opens it again when it ends, just after the last event heard", async () => {
    serve = (_req, res, n) => {
      open(res);
      if (n === 1) res.end("id: 7\nevent: shader\ndata: {}\n\n");
      else res.write("id: 8\nevent: shader\ndata: {}\n\n");
    };
    const ids: (string | null)[] = [];
    let opened = 0;
    following = followEvents(url, "k", { event: (_n, _d, id) => ids.push(id), open: () => opened++ }, { firstRetryMs: 10 });
    await until(() => ids.length === 2);
    expect(ids).toEqual(["7", "8"]);
    expect(connections[0]!.headers["last-event-id"]).toBeUndefined();
    expect(connections[1]!.headers["last-event-id"]).toBe("7");
    expect(opened).toBe(2);
  });

  it("says why it couldn't connect, and keeps trying", async () => {
    serve = (_req, res, n) => {
      if (n === 1) {
        res.writeHead(401).end('{"error":"no"}');
        return;
      }
      open(res);
      res.write("event: health\ndata: {}\n\n");
    };
    const failures: number[] = [];
    const heard: string[] = [];
    following = followEvents(url, "k", { event: (name) => heard.push(name), failed: (status) => failures.push(status) }, { firstRetryMs: 10 });
    await until(() => heard.length === 1);
    expect(failures).toEqual([401]);
  });

  it("gives up on one gone quiet, and opens it again", async () => {
    serve = (_req, res) => open(res);
    const failures: string[] = [];
    following = followEvents(url, "k", { event: () => {}, failed: (_s, message) => failures.push(message) }, { silentMs: 100, firstRetryMs: 10 });
    await until(() => connections.length >= 2);
    expect(failures[0]).toMatch(/silent/);
  });
});
