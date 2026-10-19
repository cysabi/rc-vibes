import { Hono } from "hono";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SKETCH_RESTORE_DAYS, type BoxState, type Me, type Sketch } from "../shared/vibes.ts";
import type { LightsSource } from "./api.ts";
import type { AuthEnv } from "./auth.ts";
import { boxToken, createBoxes, type Boxes } from "./boxes.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig, type Config } from "./env.ts";
import { fakeBoxRunner } from "./fake-box-runner.ts";
import { boxApiRoutes, eraseDeleted, sketchRoutes } from "./sketches.ts";

const RESTORE_MS = SKETCH_RESTORE_DAYS * 24 * 60 * 60_000;

const ada: Me = { id: "rc:1", name: "Ada Lovelace", dev: false };
const grace: Me = { id: "rc:2", name: "Grace", dev: false };
const otherAda: Me = { id: "rc:3", name: "Ada Lovelace", dev: false };

let dir: string;
let config: Config;
let db: Db;
let boxes: Boxes;
const fake = fakeBoxRunner();
let app: Hono<AuthEnv>;
let boxApi: Hono;
let as: Me = ada;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vibes-sketches-test-"));
  config = loadConfig({
    ARCLAMP_BASE_URL: "http://127.0.0.1:1",
    ARCLAMP_KEY: "k",
    SESSION_SECRET: "s".repeat(32),
    VIBES_DEV_LOGIN: "1",
    SKETCHES: "1",
    SKETCHES_DIR: dir,
    BOX_IMAGE: "vibes-box:test",
    BOX_VIBES_URL: "http://vibes.test",
  });
  db = openDb(":memory:");
  boxes = createBoxes(config, config.sketches!, db, fake.runner);
  app = new Hono<AuthEnv>()
    .use("*", async (c, next) => {
      c.set("user", as);
      await next();
    })
    .route("/sketches", sketchRoutes(config.sketches!, db, boxes));
  const lights = { currentLights: async () => ({ lights: [], rails: [], changed: 0 }) } as unknown as LightsSource;
  boxApi = boxApiRoutes(config, config.sketches!, db, lights);
});

afterAll(async () => {
  boxes.stop();
  fake.close();
  await rm(dir, { recursive: true, force: true });
});

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function make(name: string): Promise<Sketch> {
  const res = await app.request("/sketches", json({ name }));
  expect(res.status).toBe(201);
  return (await res.json()) as Sketch;
}

async function open(id: string): Promise<BoxState> {
  for (let i = 0; i < 50; i++) {
    const state = (await (await app.request(`/sketches/${id}/box`, json({}))).json()) as BoxState;
    if (state.state !== "starting") return state;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the box never started");
}

describe("sketches", () => {
  it("are made with a first commit, by whoever made them, and listed", async () => {
    as = ada;
    const s = await make("Warm wave");
    expect(s).toMatchObject({ name: "Warm wave", createdBy: { id: "rc:1", name: "Ada Lovelace" }, updatedBy: "Ada Lovelace" });
    const list = (await (await app.request("/sketches")).json()) as { sketches: Sketch[] };
    expect(list.sketches.map((x) => x.id)).toContain(s.id);
    expect((await app.request(`/sketches/${s.id}`)).status).toBe(200);
    expect((await app.request("/sketches/nope")).status).toBe(404);
  });

  it("need a name", async () => {
    expect((await app.request("/sketches", json({ name: "  " }))).status).toBe(400);
  });

  it("open in each person's own box, on their own branch", async () => {
    as = ada;
    const s = await make("Strobe");
    const mine = await open(s.id);
    expect(mine).toMatchObject({ state: "ready" });
    as = grace;
    const theirs = await open(s.id);
    as = otherAda;
    await open(s.id);
    expect(theirs).not.toEqual(mine);
    expect(db.boxFor(s.id, ada.id)?.branch).toBe("ada-lovelace");
    expect(db.boxFor(s.id, grace.id)?.branch).toBe("grace");
    expect(db.boxFor(s.id, otherAda.id)?.branch).toBe("ada-lovelace-2");
  });
});

describe("deleting a sketch", () => {
  const del = (id: string) => app.request(`/sketches/${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
  const restore = (id: string) => app.request(`/sketches/${id}/restore`, json({}));
  const listed = async (path = "/sketches") => ((await (await app.request(path)).json()) as { sketches: Sketch[] }).sketches.map((s) => s.id);

  it("is anyone's to do, and to undo", async () => {
    as = ada;
    const s = await make("Short-lived");
    as = grace;
    expect((await del(s.id)).status).toBe(200);
    expect(await listed()).not.toContain(s.id);
    expect(await listed("/sketches/deleted")).toContain(s.id);
    const gone = (await (await app.request(`/sketches/${s.id}`)).json()) as Sketch;
    expect(gone.deleted).toMatchObject({ by: "Grace" });
    expect(gone.deleted!.erasedAt - gone.deleted!.at).toBe(RESTORE_MS);
    // Nothing opens it meanwhile.
    expect((await app.request(`/sketches/${s.id}/box`, json({}))).status).toBe(410);

    as = ada;
    expect((await restore(s.id)).status).toBe(200);
    expect(await listed()).toContain(s.id);
    expect(await listed("/sketches/deleted")).not.toContain(s.id);
    expect(await open(s.id)).toMatchObject({ state: "ready" });
  });

  it("removes everyone's boxes for it, and their git with it", async () => {
    as = ada;
    const s = await make("Crowded");
    const mine = await open(s.id);
    as = grace;
    const theirs = await open(s.id);
    const ids = [db.boxFor(s.id, ada.id)!.id, db.boxFor(s.id, grace.id)!.id];
    await del(s.id);
    for (const state of [mine, theirs]) expect(fake.boxes.has((state as { run: string }).run)).toBe(false);
    for (const id of ids) expect(boxes.target(id)).toBeNull();
    const token = boxToken(config.sessionSecret, ids[0]!);
    const basic = { authorization: `Basic ${Buffer.from(`box:${token}`).toString("base64")}` };
    expect((await boxApi.request(`/git/${s.id}.git/info/refs?service=git-upload-pack`, { headers: basic })).status).toBe(404);
  });

  it("erases it all once it can't be restored", async () => {
    as = ada;
    const s = await make("Ephemeral");
    await open(s.id);
    const box = db.boxFor(s.id, ada.id)!.id;
    await del(s.id);
    const deletedAt = db.sketch(s.id)!.deleted_at!;

    await eraseDeleted(config.sketches!, db, fake.runner, deletedAt + RESTORE_MS - 1);
    expect(db.sketch(s.id)).toBeDefined();
    expect(existsSync(path.join(dir, `${s.id}.git`))).toBe(true);

    await eraseDeleted(config.sketches!, db, fake.runner, deletedAt + RESTORE_MS + 1);
    expect(db.sketch(s.id)).toBeUndefined();
    expect(db.box(box)).toBeUndefined();
    expect(fake.homesRemoved.has(box)).toBe(true);
    expect(existsSync(path.join(dir, `${s.id}.git`))).toBe(false);
  });
});

describe("a box's token", () => {
  it("gets the lights' layout, and its own sketch's repo, but no other", async () => {
    as = ada;
    const s = await make("One");
    const other = await make("Two");
    await open(s.id);
    const token = boxToken(config.sessionSecret, db.boxFor(s.id, ada.id)!.id);
    const basic = { authorization: `Basic ${Buffer.from(`box:${token}`).toString("base64")}` };

    expect((await boxApi.request("/box-api/layout", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await boxApi.request("/box-api/layout")).status).toBe(401);
    expect((await boxApi.request("/box-api/layout", { headers: { authorization: "Bearer nonsense" } })).status).toBe(401);

    const refs = (id: string) => `/git/${id}.git/info/refs?service=git-upload-pack`;
    expect((await boxApi.request(refs(s.id), { headers: basic })).status).toBe(200);
    expect((await boxApi.request(refs(other.id), { headers: basic })).status).toBe(401);
    expect((await boxApi.request(refs(s.id))).status).toBe(401);
  });
});
