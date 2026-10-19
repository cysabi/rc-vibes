import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createStreamRelay, type StreamRelay } from "./stream.ts";

/** A frame as arclamp packs it: stamp, light count, format_rev, then the lights. */
function frame(stamp: number, lights: number[]) {
  const b = Buffer.alloc(12 + lights.length);
  b.writeBigUInt64LE(BigInt(stamp), 0);
  b.writeUInt16LE(lights.length, 8);
  b.writeUInt16LE(1, 10);
  lights.forEach((v, i) => b.writeUInt8(v, 12 + i));
  return b;
}

const stampOf = (f: Uint8Array) => Number(Buffer.from(f).readBigUInt64LE(0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for arclamp's stream; `onConnect` drives each connection. */
async function fakeArclamp(onConnect: (ws: WebSocket, n: number) => void, opts: { autoPong?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0, autoPong: opts.autoPong ?? true });
  await new Promise((r) => wss.once("listening", r));
  let n = 0;
  wss.on("connection", (ws) => onConnect(ws, ++n));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/scene/ws`;
  return { url, connections: () => n, close: () => new Promise((r) => wss.close(r)) };
}

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function relayTo(url: string, timing: Parameters<typeof createStreamRelay>[2]): StreamRelay {
  const relay = createStreamRelay(url, "key", timing);
  cleanup.push(() => relay.stop());
  return relay;
}

describe("createStreamRelay", () => {
  it("passes changes on at once and repeats only as heartbeats", async () => {
    const arclamp = await fakeArclamp((ws) => {
      // A still room for 200 ms, then one change, then still again.
      let stamp = 0;
      const t = setInterval(() => {
        stamp += 10;
        ws.send(frame(stamp, stamp < 200 ? [1, 2] : [9, 2]));
      }, 10);
      ws.on("close", () => clearInterval(t));
    });
    cleanup.push(arclamp.close);
    const relay = relayTo(arclamp.url, { heartbeatMs: 120 });
    const got: number[] = [];
    relay.subscribe((f) => got.push(stampOf(f)));
    await wait(400);
    // The first frame, a heartbeat or so while still, the change the moment
    // it came (stamp 200), then heartbeats again: never a run of repeats.
    expect(got).toContain(200);
    expect(got.length).toBeGreaterThanOrEqual(3);
    expect(got.length).toBeLessThanOrEqual(7);
  });

  it("redials a connection that goes quiet without closing", async () => {
    const arclamp = await fakeArclamp(
      (ws, n) => {
        // The first connection sends a little, then nothing, ever, and never
        // answers a ping; later ones keep sending.
        let stamp = 0;
        const t = setInterval(() => {
          stamp += 10;
          if (n > 1 || stamp <= 50) ws.send(frame(stamp, [n]));
        }, 10);
        ws.on("close", () => clearInterval(t));
      },
      { autoPong: false },
    );
    cleanup.push(arclamp.close);
    const relay = relayTo(arclamp.url, { pingMs: 20, silentMs: 100 });
    const got: number[] = [];
    relay.subscribe((f) => got.push(Buffer.from(f)[12]!));
    await wait(1_000);
    expect(arclamp.connections()).toBe(2);
    expect(got.at(-1)).toBe(2); // frames are flowing from the new connection
    expect(relay.connected()).toBe(true);
  });

  it("keeps a connection that sends nothing but still answers pings", async () => {
    const arclamp = await fakeArclamp((ws) => ws.send(frame(10, [1])));
    cleanup.push(arclamp.close);
    const relay = relayTo(arclamp.url, { pingMs: 20, silentMs: 100 });
    await wait(500);
    expect(arclamp.connections()).toBe(1);
    expect(relay.connected()).toBe(true);
  });
});
