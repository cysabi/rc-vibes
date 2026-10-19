// /api: everything the browser can do. Each route checks the session,
// forwards to arclamp with vibes' key, and records who did it.

import { upgradeWebSocket } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { normalizeLights, type LightsResponse, type ShaderDescriptor } from "../shared/arclamp.ts";
import { orientationsOf } from "../shared/fixtures.ts";
import { clampAlong, hangsOnRails, RAIL_ID, railLength } from "../shared/rails.ts";
import { MAX_TAGS, TAG } from "../shared/tags.ts";
import type { Lights, SceneNode, Spot, Status } from "../shared/vibes.ts";
import { ArclampError, type Arclamp } from "./arclamp.ts";
import { requireUser, type AuthEnv } from "./auth.ts";
import type { Db } from "./db.ts";
import type { Config } from "./env.ts";
import { instanceRoutes, type Instances } from "./instances.ts";
import { applyEdits, lightsFile } from "./lights.ts";
import type { SceneFeedSource } from "./scene-feed.ts";
import { sketchOf } from "./stamp.ts";
import type { StreamRelay } from "./stream.ts";

// A browser this far behind on the light stream skips frames until it
// catches up, rather than queueing them in memory.
const MAX_BUFFERED_BYTES = 256 * 1024;
const LIGHTS_TTL_MS = 60_000;
// Room tone changes (and light and rail moves) from one person within this
// window log as one entry.
const ROOMTONE_LOG_WINDOW_MS = 15_000;

export interface ApiDeps {
  config: Config;
  arclamp: Arclamp;
  db: Db;
  relay: StreamRelay;
  origins: string[];
  lights: LightsSource;
  /** The scene, as pushed to browsers. */
  feed: SceneFeedSource;
  /** Sketches' routes, and their instances in the room, while sketches are on. */
  sketches: Hono<AuthEnv> | null;
  instances?: Instances | null;
}

// An event stream says something at least this often (a ping, if nothing
// else), so a browser can tell one that's gone quiet from one that's dead.
const STREAM_PING_MS = 10_000;

/**
 * The lights as vibes has them: arclamp's (asked for at most once a minute),
 * with the positions, rails, orientations and tags set in vibes applied.
 */
export function createLights(arclamp: Arclamp, db: Db) {
  let cache: { at: number; value: LightsResponse } | null = null;
  async function arclampLights(): Promise<LightsResponse> {
    if (!cache || Date.now() - cache.at > LIGHTS_TTL_MS) {
      cache = { at: Date.now(), value: normalizeLights(await arclamp.lights()) };
    }
    return cache.value;
  }
  async function currentLights(): Promise<Lights> {
    return applyEdits(await arclampLights(), { rails: db.rails(), placements: db.placements(), types: db.types(), tags: db.tags() });
  }
  return { arclampLights, currentLights };
}

export type LightsSource = ReturnType<typeof createLights>;

export const handleError: ErrorHandler = (err, c) => {
  if (err instanceof ArclampError) {
    // arclamp refusing vibes' own key, or being down, is a gateway failure
    // rather than something wrong with the caller's request.
    const caller = err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403;
    return c.json({ error: err.message, code: err.code }, (caller ? err.status : 502) as ContentfulStatusCode);
  }
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "internal error", code: "internal" }, 500);
};

const idParam = z.object({ id: z.coerce.number().int().positive() });
// Any finite number: arclamp keeps values as given, out of range included (rclamp §4.1).
const channelValue = z.number().finite();
const coords = z.object({
  mm_x: z.number().finite(),
  mm_y: z.number().finite(),
  floor: z.number().int(),
});
const railId = z.string().regex(RAIL_ID);
const point = z.object({ mm_x: z.number().finite(), mm_y: z.number().finite() });
const tag = z.string().regex(TAG, "tags are lowercase letters, digits, - and _");
const placement = z.union([
  z.object({ id: z.number().int(), rail: z.object({ id: railId, mm_along: z.number().finite() }) }),
  z.object({ id: z.number().int(), coords: coords.nullable() }),
]);

const noSuchShader = (result: { success: boolean }, c: Context) => {
  if (!result.success) return c.json({ error: "no such shader", code: "not_found" }, 404);
};

const badBody = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (!result.success) {
    const message = result.error instanceof z.ZodError ? z.prettifyError(result.error) : "invalid request";
    return c.json({ error: message, code: "bad_body" }, 400);
  }
};

export function apiRoutes({ config, arclamp, db, relay, origins, lights, feed, sketches, instances = null }: ApiDeps) {
  const api = new Hono<AuthEnv>();
  api.onError(handleError);
  // Browsers already refuse cross-site JSON requests without CORS headers,
  // and the session cookie is SameSite=Lax; this also covers non-browser
  // clients that set a foreign Origin. In development, a page from whatever
  // name reaches this machine (a phone on the network, through Vite) is
  // same-origin too.
  api.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const sameOrigin = !config.production && origin === new URL(c.req.url).origin;
    if (origin && !sameOrigin && !origins.includes(origin)) {
      return c.json({ error: "origin not allowed", code: "forbidden" }, 403);
    }
    await next();
  });
  api.use("*", requireUser(config));
  // Whatever's changed through vibes reaches the scene feed now, not on its next look.
  api.use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.status < 400) feed.poke();
  });

  const { arclampLights, currentLights } = lights;
  if (sketches) {
    api.route("/sketches", sketches);
    // Sketches' builds, in the room.
    api.route("/", instanceRoutes(config, arclamp, db, instances));
  }

  const nameOf = (d: ShaderDescriptor) => `Shader #${d.id}`;

  return api
    .get("/me", (c) => c.json(c.get("user")))

    .get("/status", async (c) => {
      let status: Status["arclamp"] = "ok";
      try {
        await arclamp.health();
      } catch (err) {
        if (!(err instanceof ArclampError)) throw err;
        status = err.status === 401 || err.status === 403 ? "rejected" : "unreachable";
      }
      return c.json<Status>({ arclamp: status, stream: relay.connected(), sketches: sketches !== null });
    })

    .get("/lights", async (c) => c.json(await currentLights()))

    .put("/placements", zValidator("json", z.object({ placements: z.array(placement).min(1).max(500) }), badBody), async (c) => {
      const user = c.get("user");
      const { placements } = c.req.valid("json");
      const now = await currentLights();
      const lights = new Map(now.lights.map((l) => [l.id, l]));
      const rails = new Map(now.rails.map((r) => [r.id, r]));
      const spots: { id: number; spot: Spot | null }[] = [];
      // Whole millimeters: finer than anyone can place a bulb.
      for (const p of placements) {
        const light = lights.get(p.id);
        if (!light) return c.json({ error: `no light ${p.id}`, code: "not_found" }, 404);
        if ("rail" in p) {
          const rail = rails.get(p.rail.id);
          if (!rail) return c.json({ error: `no rail ${p.rail.id}`, code: "not_found" }, 404);
          if (!hangsOnRails(light.type)) return c.json({ error: `light ${p.id} (${light.type}) doesn't hang on rails`, code: "bad_rail" }, 400);
          spots.push({ id: p.id, spot: { rail: { id: rail.id, mm_along: Math.round(clampAlong(rail, p.rail.mm_along)) } } });
        } else {
          const at = p.coords && { mm_x: Math.round(p.coords.mm_x), mm_y: Math.round(p.coords.mm_y), floor: p.coords.floor };
          spots.push({ id: p.id, spot: at && { coords: at } });
        }
      }
      db.setPlacements(spots, user);
      db.logCoalesced({ user, action: "lights.move", detail: { lights: placements.length } }, ROOMTONE_LOG_WINDOW_MS);
      return c.body(null, 204);
    })

    .put(
      "/rails",
      zValidator(
        "json",
        z.object({
          rails: z
            .array(z.object({ id: railId, rail: z.object({ floor: z.number().int(), from: point, to: point }).nullable() }))
            .min(1)
            .max(200),
        }),
        badBody,
      ),
      async (c) => {
        const user = c.get("user");
        const round = (p: { mm_x: number; mm_y: number }) => ({ mm_x: Math.round(p.mm_x), mm_y: Math.round(p.mm_y) });
        const rails = c.req.valid("json").rails.map(({ id, rail }) => ({ id, rail: rail && { floor: rail.floor, from: round(rail.from), to: round(rail.to) } }));
        const short = rails.find((r) => r.rail && railLength(r.rail) < 1);
        if (short) return c.json({ error: `rail ${short.id} has no length`, code: "bad_rail" }, 400);
        // Lights on a rail that's taken away stay where they are.
        const gone = new Set(rails.filter((r) => !r.rail).map((r) => r.id));
        const stranded = (await currentLights()).lights
          .filter((l) => l.rail && gone.has(l.rail.id))
          .map((l) => ({ id: l.id, spot: l.coords && { coords: l.coords } }));
        db.setRails(rails, stranded, user);
        db.logCoalesced({ user, action: "rails.change", detail: { rails: rails.length } }, ROOMTONE_LOG_WINDOW_MS);
        return c.body(null, 204);
      },
    )

    .put(
      "/light-types",
      zValidator(
        "json",
        z.object({ lights: z.array(z.object({ id: z.number().int(), type: z.string().min(1).max(40) })).min(1).max(500) }),
        badBody,
      ),
      async (c) => {
        const user = c.get("user");
        const { lights } = c.req.valid("json");
        const byId = new Map((await arclampLights()).lights.map((l) => [l.id, l]));
        for (const { id, type } of lights) {
          const light = byId.get(id);
          if (!light) return c.json({ error: `no light ${id}`, code: "not_found" }, 404);
          if (!orientationsOf(light.type).includes(type)) {
            return c.json({ error: `light ${id} (${light.type}) can't be turned to ${type}`, code: "bad_type" }, 400);
          }
        }
        db.setTypes(lights, user);
        db.logCoalesced({ user, action: "lights.turn", detail: { lights: lights.length } }, ROOMTONE_LOG_WINDOW_MS);
        return c.body(null, 204);
      },
    )

    // Each light's whole set of tags. The log says which tags went on and off.
    .put(
      "/light-tags",
      zValidator(
        "json",
        z.object({ lights: z.array(z.object({ id: z.number().int(), tags: z.array(tag).max(MAX_TAGS) })).min(1).max(500) }),
        badBody,
      ),
      async (c) => {
        const user = c.get("user");
        const lights = c.req.valid("json").lights.map(({ id, tags }) => ({ id, tags: [...new Set(tags)].sort() }));
        const byId = new Map((await currentLights()).lights.map((l) => [l.id, l]));
        const added = new Set<string>();
        const removed = new Set<string>();
        for (const { id, tags } of lights) {
          const light = byId.get(id);
          if (!light) return c.json({ error: `no light ${id}`, code: "not_found" }, 404);
          const before = new Set(light.tags ?? []);
          for (const t of tags) if (!before.has(t)) added.add(t);
          for (const t of before) if (!tags.includes(t)) removed.add(t);
        }
        db.setTags(lights, user);
        db.log({ user, action: "lights.tag", detail: { lights: lights.length, added: [...added], removed: [...removed] } });
        return c.body(null, 204);
      },
    )

    // arclamp's lights.json, rebuilt from its API with everything changed
    // in vibes filled in (see lightsFile).
    .get("/lights.json", async (c) => {
      c.header("Content-Disposition", 'attachment; filename="lights.json"');
      return c.body(`${JSON.stringify(lightsFile(await currentLights()), null, 2)}\n`, 200, { "Content-Type": "application/json" });
    })

    // With the sketch each was built from, by its stamp.
    .get("/scene", async (c) => {
      const scene: SceneNode[] = (await arclamp.scene()).map((n) => {
        const sketch = n.type === "js" ? sketchOf(n.script, config.signingKey, db) : undefined;
        return sketch ? { ...n, sketch } : n;
      });
      return c.json(scene);
    })

    // The scene feed (scene-feed.ts): as it is, then each time it changes.
    .get("/scene/events", (c) => {
      c.header("Cache-Control", "no-cache");
      // Proxies that buffer (nginx) pass it straight through.
      c.header("X-Accel-Buffering", "no");
      return streamSSE(c, async (stream) => {
        const send = (json: string) => stream.writeSSE({ event: "scene", data: json });
        let unsubscribe = () => {};
        stream.onAbort(() => unsubscribe());
        const now = feed.current() ?? (await feed.refresh(), feed.current());
        if (now) await send(now.json);
        unsubscribe = feed.subscribe((_feed, json) => void send(json).catch(() => {}));
        while (!stream.aborted) {
          await stream.sleep(STREAM_PING_MS);
          if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
        }
        unsubscribe();
      });
    })

    // The scene feed, looked at again now: for a browser that's just changed it.
    .get("/scene/live", async (c) => c.json(await feed.refresh()))

    // Shaders' scripts, by hash (?hashes=a,b), for the preview: the feed leaves them out.
    .get("/scene/scripts", (c) => {
      const all = feed.scripts();
      const wanted = (c.req.query("hashes") ?? "").split(",").filter((h) => all.has(h));
      return c.json(Object.fromEntries(wanted.map((h) => [h, all.get(h)!])));
    })

    .get("/health", async (c) => c.json(await arclamp.health()))

    .get("/activity", (c) => {
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
      return c.json(db.activity(limit));
    })

    .get("/shaders/:id", zValidator("param", idParam, noSuchShader), async (c) => c.json(await arclamp.shader(c.req.valid("param").id)))

    .post(
      "/shaders/:id/position",
      zValidator("param", idParam, noSuchShader),
      zValidator("json", z.object({ position: z.number().int().min(1) }), badBody),
      async (c) => {
        const user = c.get("user");
        const { id } = c.req.valid("param");
        const { position } = c.req.valid("json");
        const d = await arclamp.shader(id);
        await arclamp.moveShader(id, position);
        db.log({ user, action: "shader.move", shaderId: id, shaderName: nameOf(d), detail: { from: d.position, to: position } });
        return c.body(null, 204);
      },
    )

    .post(
      "/shaders/:id/muted",
      zValidator("param", idParam, noSuchShader),
      zValidator("json", z.object({ muted: z.boolean() }), badBody),
      async (c) => {
        const user = c.get("user");
        const { id } = c.req.valid("param");
        const { muted } = c.req.valid("json");
        const d = await arclamp.shader(id);
        await arclamp.setMuted(id, muted);
        db.log({ user, action: muted ? "shader.mute" : "shader.unmute", shaderId: id, shaderName: nameOf(d) });
        return c.body(null, 204);
      },
    )

    // The lights a shader may not change: its whole mask ([] clears it).
    .post(
      "/shaders/:id/mask",
      zValidator("param", idParam, noSuchShader),
      zValidator("json", z.object({ mask: z.array(z.number().int()).max(2000) }), badBody),
      async (c) => {
        const user = c.get("user");
        const { id } = c.req.valid("param");
        const asked = [...new Set(c.req.valid("json").mask)].sort((a, b) => a - b);
        // An instance stays masked off everything outside its home.
        const mask = instances ? await instances.within(id, asked) : asked;
        const d = await arclamp.shader(id);
        await arclamp.setMask(id, mask);
        db.log({ user, action: "shader.mask", shaderId: id, shaderName: nameOf(d), detail: { lights: mask.length } });
        return c.body(null, 204);
      },
    )

    .put(
      "/roomtone",
      zValidator(
        "json",
        z.object({
          lights: z.record(z.string(), z.record(z.string(), channelValue)),
          // For the history only; arclamp just gets channel values.
          code: z.string().max(60).optional(),
          undo: z.boolean().optional(),
        }),
        badBody,
      ),
      async (c) => {
        const user = c.get("user");
        const { lights, code, undo } = c.req.valid("json");
        const d = await arclamp.mergeRoomtone({ lights });
        const ids = Object.keys(lights).map(Number);
        if (ids.length > 0) {
          db.logCoalesced(
            { user, action: "roomtone.set", detail: { lights: ids.length, ...(code ? { code } : {}), ...(undo ? { undo } : {}) } },
            ROOMTONE_LOG_WINDOW_MS,
          );
        }
        return c.json(d);
      },
    )

    .get(
      "/stream",
      upgradeWebSocket(() => {
        let unsubscribe = () => {};
        return {
          onOpen(_evt, ws) {
            unsubscribe = relay.subscribe((frame) => {
              const raw = ws.raw as { bufferedAmount?: number } | undefined;
              if ((raw?.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return;
              ws.send(frame as Uint8Array<ArrayBuffer>);
            });
          },
          onClose() {
            unsubscribe();
          },
        };
      }),
    );
}
