// Sketches: code made in vibes, each a git repo whose main is the sketch.
// /api/sketches lists them, makes them (with a first commit to start from),
// deletes and restores them, and opens your box for one. Boxes, with their
// own token, clone and push over /git/<id>.git, and get the lights' layout for
// their preview from /box-api/layout.
//
// Anyone can delete a sketch, and anyone can restore it for
// SKETCH_RESTORE_DAYS after: deleting removes everyone's boxes for it, but keeps its repo and
// their homes (with whatever they hadn't pushed). Only then is it all erased.

import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SKETCH_RESTORE_DAYS, type Me, type Sketch } from "../shared/vibes.ts";
import type { LightsSource } from "./api.ts";
import type { AuthEnv } from "./auth.ts";
import { boxOfToken, removeHomes, type BoxRunner, type Boxes } from "./boxes.ts";
import type { Db, SketchRow } from "./db.ts";
import type { Config, SketchesConfig } from "./env.ts";
import { createRepo, headOf, removeRepo, serveGit } from "./git.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RESTORE_MS = SKETCH_RESTORE_DAYS * 24 * 60 * 60_000;

const badBody = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (!result.success) {
    const message = result.error instanceof z.ZodError ? z.prettifyError(result.error) : "invalid request";
    return c.json({ error: message, code: "bad_body" }, 400);
  }
};

const notFound = (c: Context) => c.json({ error: "no such sketch", code: "not_found" }, 404);

const authorOf = (user: Me) => ({ name: user.name, email: `${user.id.replace(/[^a-z0-9]+/gi, "-")}@users.vibes.invalid` });

/** /api/sketches, for people logged in. */
export function sketchRoutes(sketches: SketchesConfig, db: Db, boxes: Boxes) {
  async function summary(row: SketchRow): Promise<Sketch> {
    const head = await headOf(sketches.dir, row.id);
    return {
      id: row.id,
      name: row.name,
      createdBy: { id: row.by_id, name: row.by_name },
      createdAt: row.at,
      updatedAt: head?.at ?? row.at,
      updatedBy: head?.by ?? row.by_name,
      ...(row.deleted_at !== null ? { deleted: { at: row.deleted_at, by: row.deleted_by_name ?? "", erasedAt: row.deleted_at + RESTORE_MS } } : {}),
    };
  }

  return new Hono<AuthEnv>()
    .get("/", async (c) => {
      const list = await Promise.all(db.sketches().map(summary));
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      return c.json({ sketches: list });
    })

    /** The deleted ones not erased yet, to restore. */
    .get("/deleted", async (c) => c.json({ sketches: await Promise.all(db.deletedSketches().map(summary)) }))

    .post("/", zValidator("json", z.object({ name: z.string().trim().min(1).max(80) }), badBody), async (c) => {
      const user = c.get("user");
      const { name } = c.req.valid("json");
      const id = randomUUID();
      await createRepo(sketches.dir, id, authorOf(user), `Start ${name}`, starter(name));
      const row: SketchRow = { id, name, by_id: user.id, by_name: user.name, at: Date.now(), deleted_at: null, deleted_by_id: null, deleted_by_name: null };
      db.addSketch(row);
      return c.json(await summary(row), 201);
    })

    .get("/:id", async (c) => {
      const row = db.sketch(c.req.param("id"));
      return row ? c.json(await summary(row)) : notFound(c);
    })

    .delete("/:id", async (c) => {
      const row = db.sketch(c.req.param("id"));
      if (!row) return notFound(c);
      if (row.deleted_at === null) {
        db.deleteSketch(row.id, c.get("user"), Date.now());
        boxes.closeSketch(row.id);
      }
      return c.json(await summary(db.sketch(row.id)!));
    })

    .post("/:id/restore", async (c) => {
      const row = db.sketch(c.req.param("id"));
      if (!row) return notFound(c);
      db.restoreSketch(row.id);
      return c.json(await summary(db.sketch(row.id)!));
    })

    .post("/:id/box", async (c) => {
      const row = db.sketch(c.req.param("id"));
      if (!row) return notFound(c);
      if (row.deleted_at !== null) return c.json({ error: "this sketch was deleted", code: "deleted" }, 410);
      return c.json(await boxes.ensure(row.id, c.get("user")));
    });
}

/** Erases the sketches deleted more than SKETCH_RESTORE_DAYS ago: their repos, everyone's homes for them, and their rows. */
export async function eraseDeleted(sketches: SketchesConfig, db: Db, runner: BoxRunner, now = Date.now()) {
  for (const row of db.deletedSketches()) {
    if (row.deleted_at! + RESTORE_MS > now) continue;
    await removeHomes(runner, db.boxesOf(row.id).map((b) => b.id));
    await removeRepo(sketches.dir, row.id);
    db.eraseSketch(row.id);
    console.log(`erased sketch ${row.id} (${row.name}), deleted by ${row.deleted_by_name} on ${new Date(row.deleted_at!).toISOString()}`);
  }
}

/** What boxes ask vibes for, with their own token: git, and the lights' layout. */
export function boxApiRoutes(config: Config, sketches: SketchesConfig, db: Db, lights: LightsSource) {
  /** The box a request's token is for (Basic for git, Bearer for the rest). */
  const boxOf = (c: Context) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, value = ""] = header.split(" ");
    let token = "";
    if (scheme?.toLowerCase() === "bearer") token = value;
    else if (scheme?.toLowerCase() === "basic") token = Buffer.from(value, "base64").toString().split(":").slice(1).join(":");
    const id = token ? boxOfToken(config.sessionSecret, token) : null;
    return id ? (db.box(id) ?? null) : null;
  };

  const denied = (c: Context) => c.text("a box's token, please", 401, { "WWW-Authenticate": 'Basic realm="vibes"' });

  return new Hono()
    .all("/git/:repo/*", async (c) => {
      const repo = /^(.+)\.git$/.exec(c.req.param("repo"))?.[1] ?? "";
      const sketch = UUID.test(repo) ? db.sketch(repo) : undefined;
      if (!sketch || sketch.deleted_at !== null) return c.text("no such sketch", 404);
      const box = boxOf(c);
      // A box may use its own sketch's repo, and only that.
      if (!box || box.sketch_id !== repo) return denied(c);
      const rest = new URL(c.req.url).pathname.slice(`/git/${repo}.git`.length);
      return serveGit(sketches.dir, repo, rest, c.req.raw, box.user_name);
    })

    .get("/box-api/layout", async (c) => {
      if (!boxOf(c)) return denied(c);
      return c.json(await lights.currentLights());
    });
}

/** A new sketch's first commit: a gentle wave to start from, its types, and a README. */
function starter(name: string): Record<string, string> {
  return {
    "README.md": `# ${name}

A sketch for the lights at the Recurse Center, made in vibes.

\`update()\` in \`main.ts\` runs about a hundred times a second, with every
light, and says what each should be making now. The Sketch panel below the
code runs it on the plan as you save, only on your screen; play, pause and
restart it from the panel's title bar.

This is your own copy, on your own branch. Commit, and merge into \`main\` to
share it: \`main\` is the sketch.
`,
    "main.ts": `// ${name}: a slow, warm wave that rolls across the room.
//
// Colors are lemtones: a and b are OKLab's a and b at full lightness (0, 0 is
// white), and brightness is in thousands of lumens. Old bulbs only go on and
// off, with \`on\`.
import type { Out, Prev } from "./vibes";

const PERIOD_S = 8;

export function update(prev: Prev, nowMs: number, initialMs: number): Out {
  const t = (nowMs - initialMs) / 1000;
  return {
    lights: prev.lights.map((light) => {
      const x = (light.coords?.mm_x ?? 0) / 1000;
      const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / PERIOD_S - x / 2);
      return {
        id: light.id,
        channels: { a: 0.03, b: 0.07, brightness: 0.02 + 0.25 * wave, on: wave > 0.5 ? 1 : 0 },
      };
    }),
  };
}
`,
    "vibes.ts": `// What update() is given, and gives back: arclamp's shader contract.

export interface Light {
  id: number;
  /** A color bulb's or panel's a, b, brightness and fidelity, or an old bulb's on. */
  channels: Record<string, number>;
  tags: string[];
  /** Where it is, in millimeters from the building's top-left corner. */
  coords?: { mm_x: number; mm_y: number; floor: number };
  /** The rail it hangs on, and how far along it. */
  rail?: { id: string; mm_along: number };
}

export interface Prev {
  initial_time: number;
  lights: Light[];
}

/** The lights to change, and their channels; anything left out keeps its value. */
export interface Out {
  lights: { id: number; channels: Record<string, number> }[];
}
`,
  };
}
