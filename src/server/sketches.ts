// Sketches: code made in vibes, each a git repo whose main is the sketch.
// /api/sketches lists them, makes them (with a first commit to start from),
// deletes and restores them, opens your box for one, and builds its commits
// for the room (builds.ts). Boxes, with their
// own token, clone and push over /git/<id>.git, and get the lights' layout for
// their preview from /box-api/layout. A box's preview has a pool for its
// params (pools.ts): /box-api/pools makes it (the box's own) and gives a
// token to follow it by (params.ts, as a shader in the room does), and
// /box-api/pools/<id>/values takes each knob turned in the preview.
//
// Anyone can delete a sketch, and anyone can restore it, always: deleting
// removes everyone's boxes for it, and nothing opens it meanwhile, but its
// repo and their homes (with whatever they hadn't pushed) are kept.

import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { isDefaultSketch } from "../shared/default-sketches.ts";
import { POOL_ID } from "../shared/live.ts";
import { PARAM_NAME } from "../shared/params.ts";
import type { Me, Sketch, SketchChanges } from "../shared/vibes.ts";
import type { LightsSource } from "./api.ts";
import type { ParamLinks } from "./params.ts";
import { anyValue, type LightChanges, type Pools } from "./pools.ts";
import type { AuthEnv } from "./auth.ts";
import { boxOfToken, type Boxes } from "./boxes.ts";
import { view as buildView, type Builds } from "./builds.ts";
import { changesIn } from "./changes.ts";
import type { DefaultSketches } from "./default-sketches.ts";
import type { Db, SketchRow } from "./db.ts";
import type { Config, SketchesConfig } from "./env.ts";
import { createRepo, forkRepo, headOf, serveGit } from "./git.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const badBody = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (!result.success) {
    const message = result.error instanceof z.ZodError ? z.prettifyError(result.error) : "invalid request";
    return c.json({ error: message, code: "bad_body" }, 400);
  }
};

const notFound = (c: Context) => c.json({ error: "no such sketch", code: "not_found" }, 404);

// The commit adding a sketch to the room with your changes makes of them (box/publish.sh).
const PUBLISH_MESSAGE = "Added to the room with these changes";
// What a clone in the middle of something is in the middle of, by what git keeps of it.
const UNDERWAY: Record<string, string> = { "rebase-merge": "rebase", "rebase-apply": "rebase", MERGE_HEAD: "merge", CHERRY_PICK_HEAD: "cherry-pick", REVERT_HEAD: "revert" };

const authorOf = (user: Me) => ({ name: user.name, email: `${user.id.replace(/[^a-z0-9]+/gi, "-")}@users.vibes.invalid` });

/** /api/sketches, for people logged in. `defaults` makes vibes' own sketches' builds (default-sketches.ts): there's no repo of them to build. */
export function sketchRoutes(sketches: SketchesConfig, db: Db, boxes: Boxes, builds: Builds, defaults: Pick<DefaultSketches, "build"> | null = null) {
  // Development's fake changes (VIBES_FAKE_CHANGES) that have been "pushed", by sketch.
  const fakePushed = new Set<string>();
  async function summary(row: SketchRow): Promise<Sketch> {
    const head = await headOf(sketches.dir, row.id);
    return {
      id: row.id,
      name: row.name,
      createdBy: { id: row.by_id, name: row.by_name },
      createdAt: row.at,
      updatedAt: head?.at ?? row.at,
      updatedBy: head?.by ?? row.by_name,
      head: head?.commit ?? null,
      ...(row.deleted_at !== null ? { deleted: { at: row.deleted_at, by: row.deleted_by_name ?? "" } } : {}),
      ...(isDefaultSketch(row.id) ? { builtIn: true } : {}),
    };
  }

  /**
   * vibes' own sketches (shared/default-sketches.ts) are its code: in the
   * list, to add like any other, but with no repo to open, build, publish,
   * fork or delete. Their changes are always none, and building one is its
   * own build, made by vibes.
   */
  const defaultSketchRoute = async (c: Context, next: () => Promise<void>) => {
    const id = c.req.param("id") ?? "";
    if (!isDefaultSketch(id)) return next();
    const tail = c.req.path.slice(c.req.path.indexOf(id) + id.length);
    if (c.req.method === "GET" && tail === "/changes") return c.json({ files: 0, commits: 0 });
    if (c.req.method === "POST" && tail === "/builds") {
      const b = defaults ? db.build(await defaults.build(id)) : undefined;
      return b ? c.json(buildView(b)) : c.json({ error: "it isn't built yet", code: "cant_build" }, 503);
    }
    if (c.req.method === "GET" && (tail === "" || tail.startsWith("/builds"))) return next();
    return notFound(c);
  };

  return new Hono<AuthEnv>()
    .use("/:id/*", defaultSketchRoute)
    .use("/:id", defaultSketchRoute)
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

    /** A fork: a new sketch, yours, whose repo starts as a git clone of this one's (every branch, all its history). */
    .post("/:id/fork", zValidator("json", z.object({ name: z.string().trim().min(1).max(80) }), badBody), async (c) => {
      const from = db.sketch(c.req.param("id"));
      if (!from) return notFound(c);
      if (from.deleted_at !== null) return c.json({ error: "this sketch was deleted", code: "deleted" }, 410);
      const user = c.get("user");
      const id = randomUUID();
      await forkRepo(sketches.dir, from.id, id);
      const row: SketchRow = { id, name: c.req.valid("json").name, by_id: user.id, by_name: user.name, at: Date.now(), deleted_at: null, deleted_by_id: null, deleted_by_name: null };
      db.addSketch(row);
      return c.json(await summary(row), 201);
    })

    /** A new name, for everyone (its repo's id doesn't change). */
    .patch("/:id", zValidator("json", z.object({ name: z.string().trim().min(1).max(80) }), badBody), async (c) => {
      const row = db.sketch(c.req.param("id"));
      if (!row) return notFound(c);
      db.renameSketch(row.id, c.req.valid("json").name);
      return c.json(await summary(db.sketch(row.id)!));
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
    })

    // What your editor has of it that main hasn't (files not committed,
    // commits not pushed), read from your home without waking a box, for
    // adding it to the room to ask about; and those changes pushed to main,
    // for adding it with them.
    .get("/:id/changes", async (c) => {
      const row = db.sketch(c.req.param("id"));
      if (!row) return notFound(c);
      // Development's stand-in for an editor that has changes (VIBES_FAKE_CHANGES), until they're "pushed".
      if (sketches.fakeChanges.includes(row.name) && !fakePushed.has(row.id)) return c.json({ files: 2, commits: 1 } satisfies SketchChanges);
      const box = db.boxFor(row.id, c.get("user").id);
      const none: SketchChanges = { files: 0, commits: 0 };
      if (!box || !sketches.homesMount) return c.json(none);
      try {
        return c.json((await changesIn(path.join(sketches.homesMount, box.id), sketches.dir, row.id)) ?? none);
      } catch (err) {
        console.error(`couldn't read box ${box.id}'s clone of ${row.id}:`, err);
        return c.json({ unknown: true } satisfies SketchChanges);
      }
    })

    .post("/:id/publish", async (c) => {
      const row = db.sketch(c.req.param("id"));
      if (!row) return notFound(c);
      if (row.deleted_at !== null) return c.json({ error: "this sketch was deleted", code: "deleted" }, 410);
      // Development's fake changes: "pushed" (nothing is), so they're gone till vibes starts again.
      if (sketches.fakeChanges.includes(row.name) && !fakePushed.has(row.id)) {
        fakePushed.add(row.id);
        const head = await headOf(sketches.dir, row.id);
        return c.json({ commit: head?.commit ?? null });
      }
      const done = await boxes.publish(row.id, c.get("user"), PUBLISH_MESSAGE);
      if ("pushed" in done) return c.json({ commit: done.pushed });
      if ("failed" in done) return c.json({ error: done.failed, code: "failed" }, 502);
      const why = {
        clash: "your changes clash with what's been pushed to main since",
        busy: `your clone is in the middle of a ${UNDERWAY[done.detail ?? ""] ?? "rebase"}`,
        nothing: "you haven't opened this sketch, so you have no changes to it",
      }[done.refused];
      return c.json({ error: why, code: done.refused }, 409);
    })

    // Its builds, for the room: one started (of main, or a commit), the
    // latest, one with its log, and a built one's stamped script.
    .post("/:id/builds", zValidator("json", z.object({ commit: z.string().optional() }), badBody), async (c) => {
      const row = db.sketch(c.req.param("id"));
      if (!row) return notFound(c);
      if (row.deleted_at !== null) return c.json({ error: "this sketch was deleted", code: "deleted" }, 410);
      const started = await builds.start(row.id, c.req.valid("json").commit ?? "main", c.get("user"));
      if ("refused" in started) return c.json({ error: started.refused, code: "cant_build" }, started.status);
      return c.json(started.build, started.build.state === "building" ? 202 : 200);
    })

    .get("/:id/builds", (c) => c.json({ builds: db.buildsOf(c.req.param("id")).map((b) => buildView(b)) }))

    .get("/:id/builds/:build", (c) => {
      const b = db.build(c.req.param("build"));
      return b && b.sketch_id === c.req.param("id") ? c.json(buildView(b, true)) : c.json({ error: "no such build", code: "not_found" }, 404);
    })

    .get("/:id/builds/:build/script", (c) => {
      const b = db.build(c.req.param("build"));
      if (!b || b.sketch_id !== c.req.param("id") || !b.script) return c.json({ error: "no such script", code: "not_found" }, 404);
      return c.body(b.script, 200, { "content-type": "text/javascript; charset=utf-8" });
    });
}


/** What boxes ask vibes for, with their own token: git, and the lights' layout. */
export function boxApiRoutes(config: Config, sketches: SketchesConfig, db: Db, lights: LightsSource, pools: Pools | null = null, links: ParamLinks | null = null) {
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
    })

    // A pool for the box's preview: made (the box's own) if it isn't yet, and a token to follow it by.
    .post("/box-api/pools", zValidator("json", z.object({ pool: z.string().regex(POOL_ID) })), async (c) => {
      const box = boxOf(c);
      if (!box) return denied(c);
      if (!pools || !links) return c.text("params can't be followed here", 503);
      const { pool } = c.req.valid("json");
      const owner = `box:${box.id}`;
      if (!pools.mayDeclare(pool, owner)) return c.text("that pool isn't this box's", 403);
      pools.ensure(pool, owner);
      return c.json({ token: links.token(pool) });
    })

    // A knob turned in the box's preview: some lights' values of a param (null back to the default).
    .post(
      "/box-api/pools/:id/values",
      zValidator(
        "json",
        z.object({
          name: z.string().regex(PARAM_NAME),
          changes: z.array(z.tuple([z.number().int().positive(), z.unknown()])).max(2000),
        }),
      ),
      async (c) => {
        const box = boxOf(c);
        if (!box) return denied(c);
        const id = c.req.param("id");
        const owner = `box:${box.id}`;
        if (!pools || pools.get(id)?.owner !== owner) return c.text("that pool isn't this box's", 403);
        const { name, changes } = c.req.valid("json");
        const values = changes.flatMap(([light, v]): LightChanges => {
          if (v === null) return [[light, null]];
          const value = anyValue(v);
          return value === null ? [] : [[light, value]];
        });
        await pools.set(id, name, values, owner);
        return c.body(null, 204);
      },
    );
}

/** The standard library a new sketch starts on (packages/vibes, on npm). */
const LIBRARY = "@roobscoob/vibes";
const LIBRARY_VERSION = "^0.3.0";

/** A new sketch's first commit: a gentle wave to start from, on the standard library, and a README. */
function starter(name: string): Record<string, string> {
  return {
    "README.md": `# ${name}

A sketch for the lights at the Recurse Center, made in vibes.

\`main.ts\` says what each light should be making, about a hundred times a
second, with [${LIBRARY}](https://www.npmjs.com/package/${LIBRARY}): colors,
where each light is, and time. The Sketch panel below the code runs it on the
plan as you save, only on your screen; play, pause and restart it from the
panel's title bar.

This is your own copy, on your own branch. Commit, and merge into \`main\` to
share it: \`main\` is the sketch.
`,
    "main.ts": `// ${name}: a slow, warm wave that rolls across the room.
//
// sketch() asks your function about each light, about a hundred times a
// second, and gives it \`here\`: where the light is (x and y, in meters), the
// time (t, in seconds), the light itself, and the whole room. It answers with
// a color, in anything that says one: white(2700, 400), "#f80", "orange · 120 lm".
// Old bulbs only switch on and off, so they have a look of their own.
//
// All the library can do: https://www.npmjs.com/package/${LIBRARY}
import { sketch, wave, white, type Here } from "${LIBRARY}";

/** Seconds for the wave to come round again. */
const PERIOD_S = 8;

// 0 to 1 and back, rolling left to right, a crest every 12 meters.
const swell = ({ x, t }: Here) => wave(t / PERIOD_S - x / 12);

export const update = sketch({
  color: (here) => white(2700, 20 + 250 * swell(here)),
  switch: (here) => swell(here) > 0.5,
});
`,
    "package.json": `${JSON.stringify({ private: true, type: "module", dependencies: { [LIBRARY]: LIBRARY_VERSION } }, null, 2)}\n`,
    ".gitignore": "node_modules/\n",
  };
}
