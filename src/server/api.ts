// /api: everything the browser can do. Each route checks the session,
// forwards to arclamp with vibes' key, and records who did it.

import { upgradeWebSocket } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type ErrorHandler } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { normalizeLights, type LightsResponse } from "../shared/arclamp.ts";
import { orientationsOf } from "../shared/fixtures.ts";
import { clampAlong, hangsOnRails, RAIL_ID, railLength } from "../shared/rails.ts";
import { MAX_TAGS, TAG } from "../shared/tags.ts";
import type { Change, Lights, Me, RoomMessage, Spot, Status } from "../shared/vibes.ts";
import { ApplyRefused, createApply, request as applyRequest } from "./apply.ts";
import { ArclampError, type Arclamp } from "./arclamp.ts";
import { readSession, requireUser, userOfToken, type AuthEnv } from "./auth.ts";
import type { Db } from "./db.ts";
import type { Config } from "./env.ts";
import type { HealthWatch } from "./health.ts";
import { instanceRoutes, type Instances } from "./instances.ts";
import { applyEdits, lightsFile } from "./lights.ts";
import type { SceneFeedSource } from "./scene-feed.ts";
import { createShaders, Refused, shaderRoutes } from "./shaders.ts";
import type { StreamRelay } from "./stream.ts";
import { streetviewRoutes } from "./streetview.ts";

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
  /** arclamp's health, followed (without it, it's asked for each time). */
  health?: HealthWatch | null;
}

// An event stream says something at least this often (a ping, if nothing
// else), so a browser can tell one that's gone quiet from one that's dead.
const STREAM_PING_MS = 10_000;
// The most an apply can say (each change's mask is at most 2000 lights).
const MAX_APPLY_BYTES = 4 * 1024 * 1024;
// The sockets, which a page at another of vibes' addresses opens without a cookie, saying who's there first.
const SOCKETS = new Set(["/api/scene/ws", "/api/stream"]);
// How long a socket without a cookie has to say who's there.
const AUTH_WAIT_MS = 10_000;
const authMessage = z.object({ type: z.literal("auth"), token: z.string().max(4096) });

/**
 * Who's on a socket: its cookie's person, or (with none) whoever its first
 * message's token says, told to `then` once known; closed if it says no one.
 * Each later message goes to `message`.
 */
function whoIsOn(cookie: Me | null, config: Config, ws: { close(code?: number, reason?: string): void }, then: (user: Me) => void) {
  let user = cookie;
  const waiting = user ? undefined : setTimeout(() => ws.close(4401, "log in first"), AUTH_WAIT_MS);
  if (user) then(user);
  return {
    /** A message, if it's past saying who's there (null if it was that). */
    take(text: string): string | null {
      if (user) return text;
      let asked: ReturnType<typeof authMessage.safeParse> | null = null;
      try {
        asked = authMessage.safeParse(JSON.parse(text));
      } catch {
        // Not JSON: no one.
      }
      user = asked?.success ? userOfToken(asked.data.token, config) : null;
      clearTimeout(waiting);
      if (!user) ws.close(4401, "log in first");
      else then(user);
      return null;
    },
    done: () => clearTimeout(waiting),
  };
}

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
  if (err instanceof Refused) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "internal error", code: "internal" }, 500);
};

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

const badBody = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (!result.success) {
    const message = result.error instanceof z.ZodError ? z.prettifyError(result.error) : "invalid request";
    return c.json({ error: message, code: "bad_body" }, 400);
  }
};

export function apiRoutes({ config, arclamp, db, relay, origins, lights, feed, sketches, instances = null, health = null }: ApiDeps) {
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
  // A page at another of vibes' addresses reaches the API at this one
  // (LoginOptions.api), with a token in place of a cookie: its browser may.
  api.use("*", cors({ origin: (o) => (origins.includes(o) ? o : null), allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"], maxAge: 7200 }));
  // So does its socket, which (with no cookie to bring) says who's there first:
  // let through without one, to do that (whoIsOn).
  const user = requireUser(config);
  api.use("*", async (c, next) => {
    if (SOCKETS.has(c.req.path) && c.req.header("upgrade")?.toLowerCase() === "websocket") {
      c.set("user", (await readSession(c, config)) as Me);
      return next();
    }
    return user(c, next);
  });
  // Whatever's changed through vibes outside arclamp (an instance, say) is made into the scene feed now too.
  api.use("*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.status < 400) feed.poke();
  });

  const { arclampLights, currentLights } = lights;
  if (sketches) {
    api.route("/sketches", sketches);
    // Sketches' builds, in the room.
    if (instances) api.route("/", instanceRoutes(instances));
  }
  // Shaders, by vibes' keys: muted, masked, reordered, taken out.
  const shaders = createShaders({ config, arclamp, db, instances });
  api.route("/", shaderRoutes(shaders));
  // The room photographed from a few places, to see it lit as it is now.
  if (config.roomstageDir) api.route("/streetview", streetviewRoutes(config.roomstageDir, db));

  /** Room tone, merged into arclamp's, and noted in the history (a drag's run of changes as one). */
  async function setRoomtone(lights: Record<string, Record<string, number>>, user: Me, code?: string, undo?: boolean) {
    const d = await arclamp.mergeRoomtone({ lights });
    const ids = Object.keys(lights).map(Number);
    if (ids.length > 0) {
      db.logCoalesced({ user, action: "roomtone.set", detail: { lights: ids.length, ...(code ? { code } : {}), ...(undo ? { undo } : {}) } }, ROOMTONE_LOG_WINDOW_MS);
    }
    return d;
  }
  // A browser's pending edits, made in one go (over the room socket).
  const apply = createApply({ shaders, instances, setRoomtone });

  return api
    .get("/me", (c) => c.json(c.get("user")))

    // From following arclamp's health; asked of arclamp only until that's first connected (or failed).
    .get("/status", async (c) => {
      let status: Status["arclamp"] = health?.reach() ?? "ok";
      if (!health?.reach()) {
        try {
          await arclamp.health();
        } catch (err) {
          if (!(err instanceof ArclampError)) throw err;
          status = err.status === 401 || err.status === 403 ? "rejected" : "unreachable";
        }
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

    // The room socket (RoomRequest and RoomMessage, in shared/vibes.ts): the
    // scene feed (scene-feed.ts), as it is and then each time it changes; and
    // applies, made in order (apply.ts), each answered once the scene that
    // shows it has gone out. A browser sends the next without waiting: in
    // live mode, a whole one (everything it has pending) each time that
    // changes, which stands for the whole ones waiting before it, so those
    // needn't be made, and the room keeps up with the latest. Their answers
    // wait on a paced scene (feed.soon), so a drag doesn't send the whole
    // scene to every browser at each step. Its origin is checked as every
    // request's is (above): a socket isn't held to the same-origin rule.
    .get(
      "/scene/ws",
      upgradeWebSocket((c) => {
        const cookie = (c.get("user") as Me | null) ?? null;
        let user: Me | null = null;
        let on: ReturnType<typeof whoIsOn> | null = null;
        let closed = false;
        let say = (_message: string) => {};
        let unsubscribe = () => {};
        let ping: ReturnType<typeof setInterval> | undefined;
        // Applies waiting to be made, in the order they came; whether one's
        // being made; and their answers, in that order too.
        const waiting: { id: string; changes: Change[]; whole: boolean }[] = [];
        let making = false;
        let answering: Promise<void> = Promise.resolve();
        const answer = (message: RoomMessage) => say(JSON.stringify(message));

        async function make() {
          if (making || !user) return;
          making = true;
          while (waiting.length > 0 && !closed) {
            // A whole one stands for the whole ones just before it.
            let n = 0;
            while (waiting[n]?.whole && waiting[n + 1]?.whole) n++;
            const covered = waiting.splice(0, n);
            const next = waiting.shift()!;
            let said: RoomMessage;
            try {
              said = { type: "applied", id: next.id, made: await apply(next.changes, user) };
            } catch (err) {
              const why = err instanceof ApplyRefused ? err : new ApplyRefused(0, "internal", "internal error", {});
              said = { type: "refused", id: next.id, at: why.at, error: why.message, code: why.code, made: why.made };
            }
            // Answered once what it changed has gone out: at once for an
            // Apply, paced for live mode's run. The next is made meanwhile.
            const shown: Promise<unknown> = next.whole ? feed.soon() : feed.now();
            answering = answering
              .then(() => shown)
              .catch(() => {})
              .then(() => {
                for (const { id } of [...covered, next]) answer({ ...said, id });
              });
          }
          making = false;
        }

        return {
          onOpen(_evt, ws) {
            say = (message) => {
              if (!closed) ws.send(message);
            };
            const scene = (json: string) => say(`{"type":"scene","feed":${json}}`);
            on = whoIsOn(cookie, config, ws, (u) => {
              user = u;
              void (async () => {
                const now = feed.current() ?? (await feed.now(), feed.current());
                if (closed) return;
                if (now) scene(now.json);
                unsubscribe = feed.subscribe((_feed, json) => scene(json));
              })();
              void make();
            });
            ping = setInterval(() => say('{"type":"ping"}'), STREAM_PING_MS);
          },
          onMessage(evt) {
            const text = typeof evt.data === "string" && evt.data.length <= MAX_APPLY_BYTES ? evt.data : "";
            // Who's there, first (from another of vibes' addresses).
            if (on?.take(text) === null) return;
            let asked: ReturnType<typeof applyRequest.safeParse> | null = null;
            try {
              asked = applyRequest.safeParse(JSON.parse(text));
            } catch {
              // Not JSON: refused below.
            }
            if (!asked?.success) {
              answer({ type: "refused", id: "", at: 0, error: "invalid request", code: "bad_body", made: {} });
              return;
            }
            waiting.push({ id: asked.data.id, changes: asked.data.changes, whole: asked.data.whole ?? false });
            void make();
          },
          onClose() {
            closed = true;
            on?.done();
            unsubscribe();
            clearInterval(ping);
          },
        };
      }),
    )

    // The scene feed now, with whatever change vibes has just made in it: for a browser that's just changed it.
    .get("/scene/live", async (c) => c.json(await feed.now()))

    // Shaders' scripts, by hash (?hashes=a,b), for the preview: the feed leaves them out.
    .get("/scene/scripts", (c) => {
      const all = feed.scripts();
      const wanted = (c.req.query("hashes") ?? "").split(",").filter((h) => all.has(h));
      return c.json(Object.fromEntries(wanted.map((h) => [h, all.get(h)!])));
    })

    .get("/health", async (c) => c.json(health?.latest() ?? (await arclamp.health())))

    .get("/activity", (c) => {
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
      return c.json(db.activity(limit));
    })

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
        const { lights, code, undo } = c.req.valid("json");
        return c.json(await setRoomtone(lights, c.get("user"), code, undo));
      },
    )

    // The light stream: each frame as it comes, once it's known who's there
    // (from another of vibes' addresses, a token, said first: StreamRequest).
    .get(
      "/stream",
      upgradeWebSocket((c) => {
        const cookie = (c.get("user") as Me | null) ?? null;
        let on: ReturnType<typeof whoIsOn> | null = null;
        let unsubscribe = () => {};
        return {
          onOpen(_evt, ws) {
            on = whoIsOn(cookie, config, ws, () => {
              unsubscribe = relay.subscribe((frame) => {
                const raw = ws.raw as { bufferedAmount?: number } | undefined;
                if ((raw?.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return;
                ws.send(frame as Uint8Array<ArrayBuffer>);
              });
            });
          },
          onMessage(evt) {
            if (typeof evt.data === "string") on?.take(evt.data);
          },
          onClose() {
            on?.done();
            unsubscribe();
          },
        };
      }),
    );
}
