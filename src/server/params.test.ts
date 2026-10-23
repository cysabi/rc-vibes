import dgram from "node:dgram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParamSpec } from "../shared/params.ts";
import { openDb, type Db } from "./db.ts";
import { createParamsSender, specsOf, targetOf, type ParamsSender } from "./params.ts";

const speed: ParamSpec = { name: "speed", default: 7, min: 0, max: 20, step: 0.1, label: "Speed", perLight: true };
const bands: ParamSpec = { name: "bands", default: 3, min: 1, max: 8, step: 1, label: "Bands", perLight: false };

describe("what a builder says a script declares", () => {
  it("keeps the params that read as params, once each, and drops the rest", () => {
    expect(specsOf([speed, { name: "no" }, { ...bands, name: "two words" }, bands, { ...speed, default: 50 }, speed])).toEqual([speed, bands]);
    expect(specsOf("nope")).toEqual([]);
    expect(specsOf(undefined)).toEqual([]);
  });
});

describe("where a shader takes udp", () => {
  it("is its first udp port, on arclamp's host if it's bound on every address", () => {
    expect(targetOf([{ proto: "tcp", host: "10.0.0.5", port: 80 }, { proto: "udp", host: "0.0.0.0", port: 4000 }], "lamp.local")).toEqual({ host: "lamp.local", port: 4000 });
    expect(targetOf([{ proto: "udp4", host: "10.0.0.5", port: 4000 }], "lamp.local")).toEqual({ host: "10.0.0.5", port: 4000 });
    expect(targetOf([{ proto: "udp", host: "[::]", port: 4000 }], "lamp.local")).toEqual({ host: "lamp.local", port: 4000 });
    expect(targetOf([], "lamp.local")).toBeNull();
    expect(targetOf(undefined, "lamp.local")).toBeNull();
  });
});

describe("sending params", () => {
  let db: Db;
  let sender: ParamsSender;
  let socket: dgram.Socket;
  let port: number;
  let got: string[];

  beforeEach(async () => {
    db = openDb(":memory:");
    db.addSketch({ id: "s", name: "Wave", by_id: "u", by_name: "U", at: 0 });
    db.addBuild({ id: "b", sketch_id: "s", commit_sha: "c".repeat(40), builder: "1", by_id: "u", by_name: "U", at: 0 });
    db.finishBuild("b", { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: "function update(p) { return p; }", params: [speed, bands] });
    db.addInstance({ id: "i", sketch_id: "s", build_id: "b", home: [1, 2], by_id: "u", by_name: "U", at: 0 });
    db.updateInstance("i", { shader_id: 5, state: "live", params: { speed: { all: 9, lights: { "2": 4 } } } });
    got = [];
    socket = dgram.createSocket("udp4");
    socket.on("message", (m) => got.push(m.toString()));
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    port = socket.address().port;
    sender = createParamsSender({ db, arclampHost: "127.0.0.1", resendMs: 40 });
  });
  afterEach(async () => {
    sender.stop();
    await new Promise<void>((resolve) => socket.close(resolve));
  });

  const arrived = async (n: number) => {
    for (let i = 0; i < 50 && got.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    return got.map((g) => JSON.parse(g) as Record<string, unknown>);
  };

  it("sends an instance's every param, one packet each, once its shader's port is known, and again as asked", async () => {
    // Learning the port sends at once, so the clock's read first.
    const before = Date.now();
    sender.learn(5, [{ proto: "udp", host: "0.0.0.0", port }]);
    const packets = await arrived(2);
    const seqless = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "seq"));
    expect(packets.map(seqless)).toEqual([
      { vibes: "params", v: 1, name: "speed", all: 9, lights: { "2": 4 } },
      { vibes: "params", v: 1, name: "bands" },
    ]);
    db.updateInstance("i", { params: { speed: { all: 1 } } });
    sender.send("i");
    const later = (await arrived(4)).slice(2);
    expect(later.map(seqless)).toEqual([
      { vibes: "params", v: 1, name: "speed", all: 1 },
      { vibes: "params", v: 1, name: "bands" },
    ]);
    // Seqs only ever go up, and start from the clock, so a vibes started again isn't behind a sketch that's kept running.
    const seqs = [...packets, ...later].map((p) => p.seq as number);
    expect(seqs[0]).toBeGreaterThanOrEqual(before);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
  });

  it("sends again every so often, to a live instance's shader, so a lost packet or a restarted sandbox isn't behind for long", async () => {
    sender.learn(5, [{ proto: "udp", host: "127.0.0.1", port }]);
    const packets = await arrived(6);
    expect(packets.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < packets.length; i++) expect(packets[i]!.seq as number).toBeGreaterThan(packets[i - 1]!.seq as number);
  });

  it("sends nothing to a shader with no udp port, or that isn't an instance's", async () => {
    sender.learn(5, []);
    sender.learn(6, [{ proto: "udp", host: "127.0.0.1", port }]);
    sender.send("i");
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([]);
  });
});
