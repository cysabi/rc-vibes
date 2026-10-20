import { Hono } from "hono";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoxState, Me, Sketch } from "../shared/vibes.ts";
import type { LightsSource } from "./api.ts";
import type { AuthEnv } from "./auth.ts";
import { boxToken, createBoxes, type Boxes } from "./boxes.ts";
import type { Builds } from "./builds.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig, type Config } from "./env.ts";
import { fakeBoxRunner } from "./fake-box-runner.ts";
import { repoPath } from "./git.ts";
import { boxApiRoutes, sketchRoutes } from "./sketches.ts";

const ada: Me = { id: "rc:1", name: "Ada Lovelace", dev: false };
const grace: Me = { id: "rc:2", name: "Grace", dev: false };

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
    .route("/sketches", sketchRoutes(config.sketches!, db, boxes, {} as Builds));
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

  it("open in each person's own box", async () => {
    as = ada;
    const s = await make("Strobe");
    const mine = await open(s.id);
    expect(mine).toMatchObject({ state: "ready" });
    as = grace;
    const theirs = await open(s.id);
    expect(theirs).not.toEqual(mine);
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

  it("keeps its repo, to restore", async () => {
    as = ada;
    const s = await make("Kept");
    await del(s.id);
    expect(existsSync(path.join(dir, `${s.id}.git`))).toBe(true);
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

describe("your changes to a sketch", () => {
  const homes = () => path.join(dir, "homes");
  // vibes, able to read the homes (as BOX_HOMES_MOUNT gives it them).
  const reading = () =>
    new Hono<AuthEnv>()
      .use("*", async (c, next) => {
        c.set("user", as);
        await next();
      })
      .route("/sketches", sketchRoutes({ ...config.sketches!, homesMount: homes() }, db, boxes, {} as Builds));
  const claimed = () => [...fake.boxes.values()].filter((b) => b.claim).length;
  const settled = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("are read from your home, without waking a box", async () => {
    as = ada;
    const s = await make("Changed");
    await open(s.id);
    const box = db.boxFor(s.id, ada.id)!;
    const clone = path.join(homes(), box.id, "sketches", s.id, "sketch");
    await mkdir(path.dirname(clone), { recursive: true });
    await promisify(execFile)("git", ["clone", "--quiet", repoPath(dir, s.id), clone]);
    await writeFile(path.join(clone, "main.ts"), "changed\n");
    const before = claimed();
    expect(await (await reading().request(`/sketches/${s.id}/changes`)).json()).toEqual({ files: 1, commits: 0 });
    expect(claimed()).toBe(before);
    // Without the homes to read, it can't tell, so says nothing.
    expect(await (await app.request(`/sketches/${s.id}/changes`)).json()).toEqual({ files: 0, commits: 0 });
    // Someone who's never opened it has none.
    as = grace;
    expect(await (await reading().request(`/sketches/${s.id}/changes`)).json()).toEqual({ files: 0, commits: 0 });
  });

  it("are pushed in a box claimed for only that, once however often it's asked, then let go", async () => {
    as = ada;
    const s = await make("Pushed");
    await open(s.id);
    const box = db.boxFor(s.id, ada.id)!;
    const jobs: { box: string; env: Record<string, string> }[] = [];
    fake.onJob(async (claim) => {
      jobs.push(claim);
      await new Promise((r) => setTimeout(r, 30));
      return { code: 0, said: `pushed ${"b".repeat(40)}`, output: "" };
    });
    const [one, two] = await Promise.all([app.request(`/sketches/${s.id}/publish`, json({})), app.request(`/sketches/${s.id}/publish`, json({}))]);
    expect(await one.json()).toEqual({ commit: "b".repeat(40) });
    expect(await two.json()).toEqual({ commit: "b".repeat(40) });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ box: box.id, env: { VIBES_COMMIT_MESSAGE: "Added to the room with these changes", VIBES_FOLDER: `/home/workspace/sketches/${s.id}/sketch` } });
    const done = () => ![...fake.boxes.values()].some((b) => b.claim?.job);
    await settled(done);
    expect(done()).toBe(true);
  });

  it("say why they weren't pushed", async () => {
    as = ada;
    const s = await make("Refused");
    await open(s.id);
    const publish = async () => {
      const res = await app.request(`/sketches/${s.id}/publish`, json({}));
      return { status: res.status, ...((await res.json()) as { code: string; error: string }) };
    };
    fake.onJob(() => ({ code: 3, said: "clash", output: "" }));
    expect(await publish()).toMatchObject({ status: 409, code: "clash" });
    fake.onJob(() => ({ code: 4, said: "busy: rebase-merge", output: "" }));
    expect(await publish()).toMatchObject({ status: 409, code: "busy", error: "your clone is in the middle of a rebase" });
    fake.onJob(() => ({ code: 128, said: "", output: "fatal: it went wrong\n" }));
    expect(await publish()).toMatchObject({ status: 502, code: "failed", error: "fatal: it went wrong" });
    as = grace;
    expect(await publish()).toMatchObject({ status: 409, code: "nothing" });
  });
});
