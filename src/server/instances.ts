// Sketches in the room: shaders made from builds (builds.ts). This is the
// only way vibes makes a shader or changes one's script, and what it sends
// rclamp is always a build's own stamped script, looked up here by the
// build's id: never a script from the browser. So vibes never makes a plain
// shader, or turns someone else's into one; and only vibes' own shaders
// (stamped, edited or not) are its to change or remove.

import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Arclamp } from "./arclamp.ts";
import type { AuthEnv } from "./auth.ts";
import type { BuildRow, Db, SketchRow } from "./db.ts";
import type { Config } from "./env.ts";
import { readStamp } from "./stamp.ts";

const fromBuild = z.object({ build: z.string().min(1) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

const refuse = (c: Context, status: 400 | 404 | 409 | 410, error: string, code: string) => c.json({ error, code }, status);

/** Whether a shader is one of vibes' own: its script has vibes' stamp (checked or not). */
const isVibes = (d: ShaderDescriptor) => d.type === "js" && typeof d.script === "string" && readStamp(d.script, null) !== null;

export function instanceRoutes(config: Config, arclamp: Pick<Arclamp, "shader" | "createShader" | "setScript" | "deleteShader">, db: Db) {
  /** A build that can go in the room: built, its sketch not deleted, its stamp good. */
  function usable(c: Context, id: string): { build: BuildRow & { script: string }; sketch: SketchRow } | Response {
    const build = db.build(id);
    if (!build || build.state !== "built" || !build.script) return refuse(c, 404, "no such build, or it didn't build", "no_build");
    const sketch = db.sketch(build.sketch_id);
    if (!sketch || sketch.deleted_at !== null) return refuse(c, 410, "its sketch was deleted", "deleted");
    if (!readStamp(build.script, config.signingKey)?.verified) return refuse(c, 409, "its stamp doesn't check out (was vibes' key changed?): build it again", "bad_stamp");
    return { build: build as BuildRow & { script: string }, sketch };
  }

  const badBody = (r: { success: boolean }, c: Context) => (r.success ? undefined : refuse(c, 400, "say which build", "bad_body"));
  const badId = (r: { success: boolean }, c: Context) => (r.success ? undefined : refuse(c, 404, "no such shader", "not_found"));
  const detail = (b: BuildRow, s: SketchRow) => ({ sketch: s.id, commit: b.commit_sha, build: b.id });

  return (
    new Hono<AuthEnv>()
      // A build, in the room: a new shader, on top.
      .post("/shaders", zValidator("json", fromBuild, badBody), async (c) => {
        const it = usable(c, c.req.valid("json").build);
        if (it instanceof Response) return it;
        const d = await arclamp.createShader(it.build.script);
        db.log({ user: c.get("user"), action: "shader.create", shaderId: d.id, shaderName: it.sketch.name, detail: detail(it.build, it.sketch) });
        return c.json(d, 201);
      })

      // One of vibes' shaders, running another build instead (another commit, or another sketch).
      .put("/shaders/:id/build", zValidator("param", idParam, badId), zValidator("json", fromBuild, badBody), async (c) => {
        const { id } = c.req.valid("param");
        const it = usable(c, c.req.valid("json").build);
        if (it instanceof Response) return it;
        if (!isVibes(await arclamp.shader(id))) return refuse(c, 409, "that shader isn't one vibes made", "not_vibes");
        const d = await arclamp.setScript(id, it.build.script);
        db.log({ user: c.get("user"), action: "shader.edit", shaderId: id, shaderName: it.sketch.name, detail: detail(it.build, it.sketch) });
        return c.json(d);
      })

      // One of vibes' shaders, out of the room.
      .delete("/shaders/:id", zValidator("param", idParam, badId), async (c) => {
        const { id } = c.req.valid("param");
        const d = await arclamp.shader(id);
        if (!isVibes(d)) return refuse(c, 409, "that shader isn't one vibes made", "not_vibes");
        await arclamp.deleteShader(id);
        db.log({ user: c.get("user"), action: "shader.delete", shaderId: id, shaderName: `Shader #${id}` });
        return c.body(null, 204);
      })
  );
}
