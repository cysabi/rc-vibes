import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Build, Me, Sketch } from "../shared/vibes.ts";
import type { AuthEnv } from "./auth.ts";
import { createBoxes } from "./boxes.ts";
import { buildApiRoutes, buildToken, checkScript, createBuilds, SCRIPT_LIMIT, type Builds, type BuildRunner } from "./builds.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig, type Config } from "./env.ts";
import { fakeBoxRunner } from "./fake-box-runner.ts";
import { headOf } from "./git.ts";
import { sketchRoutes } from "./sketches.ts";
import { readStamp } from "./stamp.ts";

const KEY = "k".repeat(32);
const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const GOOD = "var __sketch = { update: (p) => p };\nfunction update(prev, nowMs, initialMs) { return __sketch.update(prev, nowMs, initialMs); }\n";

let dir: string;
let config: Config;
let db: Db;
let builds: Builds;
let app: Hono<AuthEnv>;
let buildApi: Hono;
const boxRunner = fakeBoxRunner();

// What the next build's "pod" does: fetches its source and sends back
// `result` (a function of what it fetched). null: it ends without sending
// anything; "hang": it never ends.
type Result = { ok: boolean; script?: string; error?: string; log?: string; plan?: string };
let result: (source: string) => Result | null | "hang" = () => ({ ok: true, script: GOOD, log: "built it", plan: "vite main.ts" });
const pods = new Map<string, "running" | "ended">();
const runner: BuildRunner = {
  async startBuild(name, _image, _command, env) {
    pods.set(name, "running");
    void (async () => {
      const auth = { authorization: `Bearer ${env.VIBES_BUILD_TOKEN}` };
      const res = await buildApi.request("/build-api/source", { headers: auth });
      const source = res.ok ? Buffer.from(await res.arrayBuffer()).toString("latin1") : "";
      const r = result(source);
      if (r === "hang") return;
      if (r) await buildApi.request("/build-api/result", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(r) });
      pods.set(name, "ended");
    })();
  },
  buildState: async (name) => pods.get(name) ?? "gone",
  removeBuild: async (name) => void pods.delete(name),
  builds: async () => [...pods.keys()],
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "vibes-builds-test-"));
  config = loadConfig({
    ARCLAMP_BASE_URL: "http://127.0.0.1:1",
    ARCLAMP_KEY: "k",
    SESSION_SECRET: "s".repeat(32),
    VIBES_SIGNING_KEY: KEY,
    VIBES_DEV_LOGIN: "1",
    SKETCHES: "1",
    SKETCHES_DIR: dir,
    BOX_IMAGE: "vibes-box:test",
    BOX_VIBES_URL: "http://vibes.test",
    BOX_POOL: "0",
  });
  db = openDb(":memory:");
  builds = createBuilds(config, config.sketches!, db, runner, { checkMs: 20, graceMs: 50 });
  buildApi = buildApiRoutes(config, builds);
  const boxes = createBoxes(config, config.sketches!, db, boxRunner.runner);
  app = new Hono<AuthEnv>()
    .use("*", async (c, next) => {
      c.set("user", ada);
      await next();
    })
    .route("/sketches", sketchRoutes(config.sketches!, db, boxes, builds));
});

afterAll(async () => {
  builds.stop();
  boxRunner.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function make(name: string): Promise<Sketch> {
  return (await (await app.request("/sketches", post({ name }))).json()) as Sketch;
}

/** A build of the sketch's main, asked for, then waited on until it's ended. */
async function built(sketch: string, body: unknown = {}): Promise<Build> {
  const started = await app.request(`/sketches/${sketch}/builds`, post(body));
  expect([200, 202]).toContain(started.status);
  const { id } = (await started.json()) as Build;
  for (let i = 0; i < 100; i++) {
    const b = (await (await app.request(`/sketches/${sketch}/builds/${id}`)).json()) as Build;
    if (b.state !== "building") return b;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("it never ended");
}

describe("a build", () => {
  it("gets its commit's files, and its script is stamped with that commit", async () => {
    const s = await make("Built");
    let source = "";
    result = (src) => ((source = src), { ok: true, script: GOOD, log: "built it", plan: "vite main.ts" });
    const b = await built(s.id);
    expect(b).toMatchObject({ state: "built", by: "Ada", plan: "vite main.ts", log: "built it", error: null });
    // A tar of the commit, with the starter's files in it.
    expect(source).toContain("main.ts");
    expect(source).toContain("export const update = sketch(");
    const head = await headOf(dir, s.id);
    expect(head).not.toBeNull();
    const script = await (await app.request(`/sketches/${s.id}/builds/${b.id}/script`)).text();
    const read = readStamp(script, KEY);
    expect(read).toMatchObject({ verified: true, stamp: { sketch: s.id, commit: b.commit, builder: "1" } });
    expect(script.endsWith(GOOD)).toBe(true);
    expect(((await (await app.request(`/sketches/${s.id}/builds`)).json()) as { builds: Build[] }).builds.map((x) => x.id)).toContain(b.id);
  });

  it("of a commit already built is that build", async () => {
    const s = await make("Again");
    const first = await built(s.id);
    const again = await app.request(`/sketches/${s.id}/builds`, post({ commit: first.commit.slice(0, 7) }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as Build).id).toBe(first.id);
  });

  it("can't be of a commit the sketch hasn't got, or a deleted sketch", async () => {
    const s = await make("Missing");
    expect((await app.request(`/sketches/${s.id}/builds`, post({ commit: "deadbeef" }))).status).toBe(404);
    expect((await app.request(`/sketches/${s.id}/builds`, post({ commit: "--upload-pack=x" }))).status).toBe(404);
    await app.request(`/sketches/${s.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await app.request(`/sketches/${s.id}/builds`, post({}))).status).toBe(410);
  });

  it("fails, with its log, when the builder fails", async () => {
    const s = await make("Broken");
    result = () => ({ ok: false, error: "installing its packages failed (exit 1)", log: "npm ERR! nope", plan: "vite main.ts" });
    expect(await built(s.id)).toMatchObject({ state: "failed", error: "installing its packages failed (exit 1)", log: "npm ERR! nope" });
  });

  it("fails when what it built isn't a script vibes will use", async () => {
    for (const [script, why] of [
      ["var x = 1;", "update()"],
      ["function update( {", "isn't a script"],
      ["export function update() {}", "isn't a script"],
      [`function update(p) { return p; }\n//${"x".repeat(SCRIPT_LIMIT)}`, "KB"],
    ] as const) {
      const s = await make(`Bad ${why}`);
      result = () => ({ ok: true, script, log: "", plan: "vite main.ts" });
      const b = await built(s.id);
      expect(b.state).toBe("failed");
      expect(b.error).toContain(why);
    }
  });

  it("fails when its pod stops without sending a result", async () => {
    const s = await make("Silent");
    result = () => null;
    expect(await built(s.id)).toMatchObject({ state: "failed", error: "the build stopped without sending a result" });
  });

  it("sends its result with its own token, once", async () => {
    const s = await make("Once");
    result = () => ({ ok: true, script: GOOD, log: "", plan: "vite main.ts" });
    const b = await built(s.id);
    const send = (token: string) =>
      buildApi.request("/build-api/result", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ok: true, script: GOOD }) });
    expect((await send(buildToken(config.sessionSecret, b.id))).status).toBe(409);
    expect((await send(`${b.id}.forged`)).status).toBe(401);
    expect((await buildApi.request("/build-api/source", { headers: { authorization: `Bearer ${buildToken(config.sessionSecret, b.id)}` } })).status).toBe(401);
  });

  it("going when vibes restarts has failed", async () => {
    const s = await make("Interrupted");
    result = () => "hang";
    const started = (await (await app.request(`/sketches/${s.id}/builds`, post({}))).json()) as Build;
    expect(started.state).toBe("building");
    // A new vibes, over the same database.
    const again = createBuilds(config, config.sketches!, db, runner, { checkMs: 60_000, graceMs: 60_000 });
    again.stop();
    expect(db.build(started.id)).toMatchObject({ state: "failed", error: "vibes restarted while it was building" });
  });
});

describe("a built script", () => {
  it("is one rclamp can run, defining update(), within its size", () => {
    expect(checkScript(GOOD)).toBeNull();
    expect(checkScript("var update = function (p) { return p; };")).toBeNull();
    expect(checkScript("globalThis.update = (p) => p;")).toBeNull();
    expect(checkScript("var x = { update: 1 };")).toContain("update()");
  });
});
