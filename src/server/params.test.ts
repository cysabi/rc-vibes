import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightInfo } from "../shared/arclamp.ts";
import type { ParamSpec } from "../shared/params.ts";
import { ArclampError } from "./arclamp.ts";
import { openDb, type Db } from "./db.ts";
import { createParamLinks, declarationsOf, linkOfToken, linkToken, type ParamLinks, type SeenShader } from "./params.ts";

const SECRET = "s".repeat(32);
const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 7, min: 0, max: 20, step: 0.1 };
const on: ParamSpec = { kind: "toggle", name: "on", label: "On", lights: { kinds: ["switch"] }, default: false };
// 1 and 2 take colors; 3 is an old bulb.
const LIGHTS: LightInfo[] = [1, 2, 3].map((id) => ({ id, type: id === 3 ? "relay" : "br30", tags: [], coords: null, rail: null, channels: [] }));

describe("what a shader says its sketch declares", () => {
  it("keeps the params that read as params, once each, and says why it dropped the rest", () => {
    const { specs, dropped } = declarationsOf([speed, { name: "no" }, { ...speed, name: "two words" }, on, { ...speed, default: 50 }, speed]);
    expect(specs).toEqual([speed, on]);
    expect(dropped).toEqual([
      'param no: its kind is "number", "color" or "toggle", not undefined',
      'a param\'s name is a word (letters, digits, _ or -), not "two words"',
      "param speed: its default should be a number from its min to its max",
      "param speed is declared twice",
    ]);
    expect(declarationsOf("nope")).toEqual({ specs: [], dropped: ["its params aren't a list"] });
  });

  it("makes a color for color lights, whatever it says", () => {
    const tint = { kind: "color", name: "tint", label: "Tint", default: { a: 0, b: 0, lm: 300, fidelity: 1 } };
    expect(declarationsOf([tint]).specs[0]!.lights).toEqual({ kinds: ["color"] });
    expect(declarationsOf([{ ...tint, lights: { kinds: ["switch"] } }]).dropped[0]).toMatch(/a color is for color lights/);
  });
});

describe("a link's token", () => {
  it("says which instance and link it's for, if vibes made it", () => {
    const token = linkToken(SECRET, "i1", 3);
    expect(linkOfToken(SECRET, token)).toEqual({ id: "i1", link: 3 });
    expect(linkOfToken(SECRET, token.replace(".3.", ".4."))).toBeNull();
    expect(linkOfToken("t".repeat(32), token)).toBeNull();
    expect(linkOfToken(SECRET, "i1")).toBeNull();
  });
});

/** An event stream's events, as they come: read one at a time. */
function events(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return async function next(): Promise<{ event: string; data: unknown } | null> {
    for (;;) {
      const at = text.indexOf("\n\n");
      if (at >= 0) {
        const block = text.slice(0, at);
        text = text.slice(at + 2);
        if (block.startsWith(":")) continue;
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(block)?.[1];
        return { event, data: data === undefined ? null : JSON.parse(data) };
      }
      const { done, value } = await reader.read();
      if (done) return null;
      text += decoder.decode(value, { stream: true });
    }
  };
}

describe("linking shaders, and their streams", () => {
  let db: Db;
  let links: ParamLinks;
  let clock: number;
  let evals: { id: number; code: string }[];
  let answer: () => Promise<{ ok: boolean; result?: string; error?: string }>;
  let changed: number;

  beforeEach(() => {
    db = openDb(":memory:");
    db.addSketch({ id: "s", name: "Wave", by_id: "u", by_name: "U", at: 0 });
    db.addBuild({ id: "b", sketch_id: "s", commit_sha: "c".repeat(40), builder: "1", by_id: "u", by_name: "U", at: 0 });
    db.addInstance({ id: "i", sketch_id: "s", build_id: "b", home: [1, 2, 3], by_id: "u", by_name: "U", at: 0 });
    db.updateInstance("i", { shader_id: 5, state: "live" });
    clock = 0;
    evals = [];
    changed = 0;
    answer = async () => ({ ok: true, result: '{"v":1,"params":1}' });
    links = createParamLinks({
      db,
      arclamp: {
        evalShader: async (id, code) => {
          evals.push({ id, code });
          return answer();
        },
      },
      secret: SECRET,
      url: "https://vibes.test/shader-api/params",
      lights: async () => LIGHTS,
      changed: () => changed++,
      now: () => clock,
    });
  });
  afterEach(() => links.stop());

  const shader = (more: Partial<SeenShader> = {}): SeenShader => ({ instance: "i", shaderId: 5, running: true, respawns: 0, scriptHash: "h", ...more });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const connect = (token: string, body: unknown = { v: 1, params: [speed, on] }) =>
    links.routes().request("/shader-api/params", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("links a running shader once vibes has been up long enough for linked ones to come back by themselves", async () => {
    links.scene([shader()]);
    await settle();
    expect(evals).toEqual([]);
    clock = 10_000;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(1);
    expect(evals[0]!.id).toBe(5);
    expect(evals[0]!.code).toBe(`globalThis.__vibes?.connect(${JSON.stringify({ v: 1, url: "https://vibes.test/shader-api/params", token: linkToken(SECRET, "i", 1) })})`);
    expect(db.instance("i")!.link_epoch).toBe(1);
  });

  it("doesn't link one that isn't running, or one that has its stream", async () => {
    clock = 10_000;
    links.scene([shader({ running: false })]);
    await settle();
    expect(evals).toEqual([]);
    db.updateInstance("i", { link_epoch: 1 });
    await connect(linkToken(SECRET, "i", 1));
    links.scene([shader()]);
    await settle();
    expect(evals).toEqual([]);
  });

  it("tries again later, waiting longer each time, and not at all for a sandbox with no library to link", async () => {
    clock = 10_000;
    answer = async () => {
      throw new ArclampError(503, "busy", "sandbox eval queue full");
    };
    links.scene([shader()]);
    await settle();
    clock += 1999;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(1);
    clock += 1;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(2);
    clock += 3999;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(2);
    clock += 1;
    answer = async () => ({ ok: true, result: "undefined" });
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(3);
    clock += 3_600_000;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(3);
    // A new sandbox (or script) might have one: tried at once.
    links.scene([shader({ respawns: 1 })]);
    await settle();
    expect(evals).toHaveLength(4);
  });

  it("links again if no stream comes within 10 s of linking", async () => {
    clock = 10_000;
    links.scene([shader()]);
    await settle();
    clock += 9_999;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(1);
    clock += 1;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(2);
    expect(db.instance("i")!.link_epoch).toBe(2);
  });

  it("turns down a stream without the instance's last link's token, or in another protocol", async () => {
    db.updateInstance("i", { link_epoch: 2 });
    expect((await connect("nope")).status).toBe(401);
    expect((await connect(linkToken(SECRET, "i", 1))).status).toBe(401);
    expect((await connect(linkToken(SECRET, "gone", 2))).status).toBe(401);
    expect((await connect(linkToken(SECRET, "i", 2), { v: 2, params: [] })).status).toBe(400);
  });

  it("keeps what's declared, sends every value first, then each change in order, and ends it when the instance goes", async () => {
    db.updateInstance("i", { link_epoch: 1, params: { speed: [[9, [1]]] } });
    const res = await connect(linkToken(SECRET, "i", 1));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(db.instance("i")!.declared).toEqual([speed, on]);
    expect(changed).toBe(1);
    expect(links.linked("i")).toBe(true);
    const next = events(res);
    expect(await next()).toEqual({ event: "state", data: { v: 1, values: { speed: [[9, [1]]] } } });
    links.send("i", "speed", [[3, [2]]]);
    links.send("i", "speed", [[null, [1]]]);
    expect(await next()).toEqual({ event: "change", data: { name: "speed", set: [[3, [2]]] } });
    expect(await next()).toEqual({ event: "change", data: { name: "speed", set: [[null, [1]]] } });
    links.gone("i");
    expect(await next()).toEqual({ event: "end", data: { reason: "gone" } });
    expect(await next()).toBeNull();
    expect(links.linked("i")).toBe(false);
  });

  it("has one stream an instance: a new one takes over, and the old is told", async () => {
    db.updateInstance("i", { link_epoch: 1 });
    const first = events(await connect(linkToken(SECRET, "i", 1)));
    await first();
    const second = events(await connect(linkToken(SECRET, "i", 1)));
    expect(await first()).toEqual({ event: "end", data: { reason: "replaced" } });
    expect(await first()).toBeNull();
    await second();
    links.send("i", "speed", [[1, [1]]]);
    expect(await second()).toEqual({ event: "change", data: { name: "speed", set: [[1, [1]]] } });
  });

  it("lets go of values that can't be any more: another kind now, or lights the param's no longer for", async () => {
    db.updateInstance("i", { link_epoch: 1, declared: [speed, on], params: { speed: [[9, [1, 3]]], on: [[true, [3]]], old: [[1, [1]]] } });
    const narrowed: ParamSpec = { ...speed, lights: { kinds: ["color"] } };
    const nowNumber: ParamSpec = { kind: "number", name: "on", label: "On", lights: {}, default: 0, min: 0, max: 1, step: 0.1 };
    await connect(linkToken(SECRET, "i", 1), { v: 1, params: [narrowed, nowNumber] });
    // A param it doesn't declare now keeps its values, for a script that brings it back.
    expect(db.instance("i")!.params).toEqual({ speed: [[9, [1]]], old: [[1, [1]]] });
    expect(db.instance("i")!.declared).toEqual([narrowed, nowNumber]);
  });
});
