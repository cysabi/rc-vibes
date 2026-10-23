// Streetview: the room photographed from a few places, one bulb channel at a
// time (roomstage), so a browser can relight each photograph with the lights
// as they are now. Each place's build is a folder, ROOMSTAGE_DIR/<id>/build:
// manifest.json (the encoded maps at each size), look.json (the camera's
// tone curves), view.json (where the camera stood, worked out from the
// photographs) and the encoded maps themselves. On kokuzo that's
// /mnt/tank/roomstage, mounted read-only.
//
// Where a camera stood can be moved in vibes, over its view.json; the db
// keeps that.

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { CameraView, StreetView } from "../shared/vibes.ts";
import type { AuthEnv } from "./auth.ts";
import type { Db } from "./db.ts";

const ID = /^[a-z0-9-]{1,32}$/;
// Paths inside a build: names and slashes, no way back up.
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
// Moves from one person within this window log as one entry.
const LOG_WINDOW_MS = 15_000;

const view = z.object({
  floor: z.number().int(),
  mm_x: z.number().finite(),
  mm_y: z.number().finite(),
  yaw: z.number().finite(),
  hfov: z.number().min(5).max(175),
});

const buildOf = (dir: string, id: string) => path.join(dir, id, "build");

/** Where a build's photographs put its camera (its view.json), or null if it doesn't say. */
function viewFile(dir: string, id: string): CameraView | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(buildOf(dir, id), "view.json"), "utf8")) as Record<string, unknown>;
    const v = view.safeParse({ floor: raw.floor, mm_x: raw.mm_x, mm_y: raw.mm_y, yaw: raw.yaw, hfov: raw.hfov });
    return v.success ? v.data : null;
  } catch {
    return null;
  }
}

/** The cameras with a build, and where each stood: as moved in vibes, else as its photographs say. */
export function streetViews(dir: string, db: Db): StreetView[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(dir).filter((id) => ID.test(id) && fs.existsSync(path.join(buildOf(dir, id), "manifest.json")));
  } catch {
    return [];
  }
  const moved = db.cameraViews();
  const out: StreetView[] = [];
  for (const id of ids.sort()) {
    const m = moved.get(id);
    const v = m?.view ?? viewFile(dir, id);
    if (v) out.push({ id, ...v, by: m?.by ?? null });
  }
  return out;
}

const TYPES: Record<string, string> = { ".json": "application/json" };

/** A build's id (its manifest's "made"), so its maps' URLs can name it; worked out again when the manifest changes. */
const builds = new Map<string, { mtimeMs: number; made: string | null }>();
async function buildIdOf(dir: string, id: string): Promise<string | null> {
  const p = path.join(buildOf(dir, id), "manifest.json");
  try {
    const st = await fs.promises.stat(p);
    const known = builds.get(p);
    if (known && known.mtimeMs === st.mtimeMs) return known.made;
    const made = (JSON.parse(await fs.promises.readFile(p, "utf8")) as { made?: unknown }).made;
    const value = typeof made === "string" ? made : null;
    builds.set(p, { mtimeMs: st.mtimeMs, made: value });
    return value;
  } catch {
    return null;
  }
}

/**
 * One file of a build. Asked for by the build's id (?v=, as the browser does
 * for the maps), it's kept for good: a new build is a new id, so a new URL.
 * Otherwise (the manifest, which says the id) it's checked each time.
 */
async function sendFile(c: Context, dir: string, id: string, file: string) {
  if (!ID.test(id) || !FILE.test(file)) return c.json({ error: "no such file", code: "not_found" }, 404);
  const root = buildOf(dir, id);
  const p = path.resolve(root, file);
  if (!p.startsWith(root + path.sep)) return c.json({ error: "no such file", code: "not_found" }, 404);
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(p);
  } catch {
    return c.json({ error: "no such file", code: "not_found" }, 404);
  }
  if (!st.isFile()) return c.json({ error: "no such file", code: "not_found" }, 404);
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const v = c.req.query("v");
  const current = v !== undefined && v === (await buildIdOf(dir, id));
  const headers = { ETag: etag, "Cache-Control": current ? "private, max-age=31536000, immutable" : "private, no-cache" };
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
  const body = Readable.toWeb(fs.createReadStream(p)) as ReadableStream;
  return new Response(body, {
    headers: { ...headers, "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Content-Length": String(st.size) },
  });
}

export function streetviewRoutes(dir: string, db: Db) {
  return new Hono<AuthEnv>()
    .get("/", (c) => c.json(streetViews(dir, db)))

    .put("/:id", zValidator("json", view), (c) => {
      const id = c.req.param("id");
      if (!streetViews(dir, db).some((v) => v.id === id)) return c.json({ error: `no camera ${id}`, code: "not_found" }, 404);
      const v = c.req.valid("json");
      const user = c.get("user");
      db.setCameraView(id, { ...v, yaw: ((v.yaw % 360) + 360) % 360 }, user);
      db.logCoalesced({ user, action: "streetview.move", detail: { camera: id } }, LOG_WINDOW_MS);
      return c.body(null, 204);
    })

    .get("/:id/*", (c) => {
      const id = c.req.param("id");
      const prefix = `/streetview/${id}/`;
      const at = c.req.path.indexOf(prefix);
      return sendFile(c, dir, id, at < 0 ? "" : decodeURIComponent(c.req.path.slice(at + prefix.length)));
    });
}
