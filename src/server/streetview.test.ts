import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Me, StreetView } from "../shared/vibes.ts";
import { handleError } from "./api.ts";
import type { AuthEnv } from "./auth.ts";
import { openDb, type Db } from "./db.ts";
import { streetviewRoutes } from "./streetview.ts";

const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const PHOTOS = { floor: 4, mm_x: 1000, mm_y: 2000, yaw: 90, hfov: 70 };
const MADE = "2026-10-23T00:40:00-0400";

let dir: string;
let db: Db;
let app: Hono<AuthEnv>;

function build(id: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, id, "build", name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "roomstage-"));
  db = openDb(":memory:");
  build("30", { "manifest.json": JSON.stringify({ made: MADE }), "view.json": JSON.stringify(PHOTOS), "2040/av1-WW.obu": "frames" });
  // A build with no view.json yet, and a folder that isn't a build.
  build("44", { "manifest.json": "{}" });
  fs.mkdirSync(path.join(dir, "raw-only", "raw"), { recursive: true });
  fs.writeFileSync(path.join(dir, "secret.txt"), "not served");
  app = new Hono<AuthEnv>()
    .use("*", async (c, next) => {
      c.set("user", ada);
      await next();
    })
    .route("/streetview", streetviewRoutes(dir, db));
  app.onError(handleError);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const send = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("streetview", () => {
  it("lists the builds whose photographs say where they were taken", async () => {
    const res = await send("GET", "/streetview");
    expect(await res.json()).toEqual([{ id: "30", ...PHOTOS, by: null }]);
  });

  it("keeps a camera moved in vibes over its photographs, yaw within a turn", async () => {
    expect((await send("PUT", "/streetview/30", { ...PHOTOS, mm_x: 1500, yaw: -30 })).status).toBe(204);
    const [v] = (await (await send("GET", "/streetview")).json()) as StreetView[];
    expect(v).toEqual({ id: "30", ...PHOTOS, mm_x: 1500, yaw: 330, by: { id: ada.id, name: ada.name } });
    expect((await send("PUT", "/streetview/nope", PHOTOS)).status).toBe(404);
    expect((await send("PUT", "/streetview/30", { ...PHOTOS, hfov: 0 })).status).toBe(400);
  });

  it("serves a build's files, revalidated by ETag", async () => {
    const res = await send("GET", "/streetview/30/2040/av1-WW.obu");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("frames");
    const again = await app.request("/streetview/30/2040/av1-WW.obu", { headers: { "if-none-match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  it("keeps a map for good when it's asked for by its build, and checks it otherwise", async () => {
    const cache = async (q: string) => (await send("GET", `/streetview/30/2040/av1-WW.obu${q}`)).headers.get("cache-control");
    expect(await cache(`?v=${encodeURIComponent(MADE)}`)).toBe("private, max-age=31536000, immutable");
    expect(await cache("?v=an-older-build")).toBe("private, no-cache");
    expect(await cache("")).toBe("private, no-cache");
    expect((await send("GET", "/streetview/30/manifest.json")).headers.get("cache-control")).toBe("private, no-cache");
  });

  it("serves nothing outside a build", async () => {
    for (const p of ["/streetview/30/..%2F..%2Fsecret.txt", "/streetview/30/../../secret.txt", "/streetview/30/2040", "/streetview/raw-only/raw"]) {
      expect((await send("GET", p)).status, p).toBe(404);
    }
  });
});
