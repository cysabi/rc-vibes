import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightInfo } from "../shared/arclamp.ts";
import type { Op } from "../shared/live.ts";
import type { ParamSpec } from "../shared/params.ts";
import { ArclampError } from "./arclamp.ts";
import { openDb, type Db } from "./db.ts";
import { createParamLinks, declarationsOf, linkOfToken, linkToken, type ParamLinks, type SeenShader } from "./params.ts";
import { createPools, type Pools } from "./pools.ts";

const SECRET = "s".repeat(32);
const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 7, min: 0, max: 20, step: 0.1 };
const on: ParamSpec = { kind: "toggle", name: "on", label: "On", lights: { kinds: ["switch"] }, default: false };
const light = (id: number, channels: string[]): LightInfo => ({ id, type: "br30", tags: [], coords: null, rail: null, channels });
const LIGHTS = [light(1, ["a", "b", "brightness", "fidelity"]), light(2, ["a", "b", "brightness", "fidelity"]), light(3, ["on"])];

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
  it("says which pool and link it's for, if vibes made it", () => {
    const token = linkToken(SECRET, "p1", 3);
    expect(linkOfToken(SECRET, token)).toEqual({ id: "p1", link: 3 });
    expect(linkOfToken(SECRET, token.replace(".3.", ".4."))).toBeNull();
    expect(linkOfToken("t".repeat(32), token)).toBeNull();
    expect(linkOfToken(SECRET, "p1")).toBeNull();
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

describe("linking shaders to their pools, and the pools' streams", () => {
  const OWNER = "instance:i";
  let db: Db;
  let pools: Pools;
  let links: ParamLinks;
  let clock: number;
  let evals: { id: number; code: string }[];
  let answer: () => Promise<{ ok: boolean; result?: string; error?: string }>;
  let published: Op[];

  beforeEach(() => {
    db = openDb(":memory:");
    published = [];
    pools = createPools({ db, publish: (ops) => published.push(...ops), lights: async () => LIGHTS });
    pools.ensure("p", OWNER);
    clock = 0;
    evals = [];
    answer = async () => ({ ok: true, result: '{"v":1,"params":1}' });
    links = createParamLinks({
      pools,
      arclamp: {
        evalShader: async (id, code) => {
          evals.push({ id, code });
          return answer();
        },
      },
      secret: SECRET,
      url: "https://vibes.test/shader-api/params",
      now: () => clock,
    });
  });
  afterEach(() => {
    links.stop();
    pools.stop();
  });

  const shader = (more: Partial<SeenShader> = {}): SeenShader => ({ instance: "i", pool: "p", shaderId: 5, running: true, respawns: 0, scriptHash: "h", ...more });
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
    expect(evals[0]!.code).toBe(`globalThis.__vibes?.connect(${JSON.stringify({ v: 1, url: "https://vibes.test/shader-api/params", token: linkToken(SECRET, "p", 1) })})`);
    expect(pools.get("p")!.link_epoch).toBe(1);
  });

  it("doesn't link one that isn't running, or one that has its stream", async () => {
    clock = 10_000;
    links.scene([shader({ running: false })]);
    await settle();
    expect(evals).toEqual([]);
    await connect(linkToken(SECRET, "p", pools.relink("p")));
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
    expect(pools.get("p")!.link_epoch).toBe(2);
  });

  it("doesn't link a shader whose pool isn't there", async () => {
    clock = 10_000;
    links.scene([shader({ pool: "gone" })]);
    await settle();
    expect(evals).toEqual([]);
  });

  it("turns down a stream without the pool's last link's token, or in another protocol", async () => {
    pools.relink("p");
    pools.relink("p");
    expect((await connect("nope")).status).toBe(401);
    expect((await connect(linkToken(SECRET, "p", 1))).status).toBe(401);
    expect((await connect(linkToken(SECRET, "gone", 2))).status).toBe(401);
    expect((await connect(linkToken(SECRET, "p", 2), { v: 2, params: [] })).status).toBe(400);
  });

  it("keeps what's declared (as the pool's owner), sends every value first, then each change in order, and ends it when the pool goes", async () => {
    await pools.set("p", "speed", [[1, 9]], OWNER);
    const res = await connect(linkToken(SECRET, "p", pools.relink("p")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(pools.get("p")!.declared).toEqual([speed, on]);
    expect(pools.get("p")!.owner).toBe(OWNER);
    expect(published).toContainEqual(["pools/p/declared", [speed, on]]);
    expect(links.linked("p")).toBe(true);
    const next = events(res);
    expect(await next()).toEqual({ event: "state", data: { v: 1, values: { speed: [[9, [1]]] } } });
    await pools.set("p", "speed", [[2, 3]], "user:u");
    await pools.set("p", "speed", [[1, null]], "user:u");
    expect(await next()).toEqual({ event: "change", data: { name: "speed", set: [[3, [2]]] } });
    expect(await next()).toEqual({ event: "change", data: { name: "speed", set: [[null, [1]]] } });
    links.gone("p");
    expect(await next()).toEqual({ event: "end", data: { reason: "gone" } });
    expect(await next()).toBeNull();
    expect(links.linked("p")).toBe(false);
  });

  it("has one stream a pool: a new one takes over, and the old is told", async () => {
    const token = linkToken(SECRET, "p", pools.relink("p"));
    const first = events(await connect(token));
    await first();
    const second = events(await connect(token));
    expect(await first()).toEqual({ event: "end", data: { reason: "replaced" } });
    expect(await first()).toBeNull();
    await second();
    await pools.set("p", "speed", [[1, 1]], "user:u");
    expect(await second()).toEqual({ event: "change", data: { name: "speed", set: [[1, [1]]] } });
  });

  it("only tells a pool's stream of its own pool's changes", async () => {
    pools.ensure("q", "instance:j");
    const next = events(await connect(linkToken(SECRET, "p", pools.relink("p"))));
    await next();
    await pools.set("q", "speed", [[1, 4]], "user:u");
    await pools.set("p", "speed", [[1, 5]], "user:u");
    expect(await next()).toEqual({ event: "change", data: { name: "speed", set: [[5, [1]]] } });
  });

  it("keeps the values as they are when what's declared changes: saying what it declares can't take any away", async () => {
    await pools.set("p", "speed", [[1, 9], [3, 9]], OWNER);
    await pools.set("p", "on", [[3, true]], OWNER);
    await pools.set("p", "old", [[1, 1]], OWNER);
    const values = structuredClone(pools.get("p")!.values);
    pools.declare("p", [speed, on], OWNER);
    const narrowed: ParamSpec = { ...speed, lights: { kinds: ["color"] } };
    const nowNumber: ParamSpec = { kind: "number", name: "on", label: "On", lights: {}, default: 0, min: 0, max: 1, step: 0.1 };
    await connect(linkToken(SECRET, "p", pools.relink("p")), { v: 1, params: [narrowed, nowNumber] });
    expect(pools.get("p")!.declared).toEqual([narrowed, nowNumber]);
    expect(pools.get("p")!.values).toEqual(values);
  });

  it("gives a stream that isn't a shader's (a preview's) a token of a new link, so older ones stop working", async () => {
    const old = linkToken(SECRET, "p", pools.relink("p"));
    const token = links.token("p");
    expect(token).toBe(linkToken(SECRET, "p", 2));
    expect((await connect(old)).status).toBe(401);
    expect((await connect(token)).status).toBe(200);
  });

  it("links again a shader whose sandbox or script changed and whose stream didn't come back: the one it has is dead", async () => {
    clock = 10_000;
    links.scene([shader()]);
    await settle();
    expect(evals).toHaveLength(1);
    await connect(linkToken(SECRET, "p", 1));
    // A while later its sandbox starts over; the old stream's still open on this end.
    clock += 5_000;
    links.scene([shader({ respawns: 1 })]);
    await settle();
    expect(evals).toHaveLength(1);
    clock += 10_000;
    links.scene([shader({ respawns: 1 })]);
    await settle();
    expect(evals).toHaveLength(2);
  });

  it("doesn't take a stream that came just as the scene said its script changed for a dead one", async () => {
    clock = 10_000;
    const token = linkToken(SECRET, "p", pools.relink("p"));
    await connect(token);
    links.scene([shader()]);
    // The new script's stream, a moment before the scene says the script's new.
    clock += 30_000;
    await connect(token);
    clock += 500;
    links.scene([shader({ scriptHash: "h2" })]);
    clock += 60_000;
    links.scene([shader({ scriptHash: "h2" })]);
    await settle();
    expect(evals).toEqual([]);
  });
});
