// /api: everything the browser can do. Each route checks the session,
// forwards to arclamp with vibes' key, and records who did it.

import { upgradeWebSocket } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type ErrorHandler } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { normalizeLights, type Channels, type LightsResponse } from "../shared/arclamp.ts";
import { unfanOps, type RoomMessage } from "../shared/live.ts";
import { MAX_PRESENCE_SELECTED } from "../shared/presence.ts";
import { RAIL_ID } from "../shared/rails.ts";
import { MAX_TAGS, TAG } from "../shared/tags.ts";
import type { Lights, Me, Status } from "../shared/vibes.ts";
import { ArclampError, type Arclamp } from "./arclamp.ts";
import { readSession, requireUser, userOfToken, type AuthEnv } from "./auth.ts";
import type { Db } from "./db.ts";
import type { Config } from "./env.ts";
import type { HealthWatch } from "./health.ts";
import { instanceRoutes, type Instances } from "./instances.ts";
import type { LayoutEdits } from "./layout.ts";
import { applyEdits, lightsFile } from "./lights.ts";
import type { LiveState } from "./live.ts";
import type { Pools } from "./pools.ts";
import { createPresence, type PresenceHub } from "./presence.ts";
import type { SceneFeedSource } from "./scene-feed.ts";
import { createShaders, Refused, shaderRoutes } from "./shaders.ts";
import type { StreamRelay } from "./stream.ts";
import { streetviewPublicFiles, streetviewRoutes } from "./streetview.ts";
import { createUpdates, MAX_OPS } from "./updates.ts";

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
  /** The scene, made as arclamp's changes (and vibes'). */
  feed: SceneFeedSource;
  /** The live state (shared/live.ts), as every page has it. */
  live: LiveState;
  pools: Pools;
  /** The map's layout, as vibes changes it. */
  layout: LayoutEdits;
  /** Sketches' routes, and their instances in the room, while sketches are on. */
  sketches: Hono<AuthEnv> | null;
  instances?: Instances | null;
  /** arclamp's health, followed (without it, it's asked for each time). */
  health?: HealthWatch | null;
  /** arclamp's time, as vibes keeps up with it (rclamp-time.ts): told to each page that asks. Without it, vibes' own. */
  /** Who's here (shared/presence.ts); without it, one of its own. */
  presence?: PresenceHub;
}

// An event stream says something at least this often (a ping, if nothing
// else), so a browser can tell one that's gone quiet from one that's dead.
const STREAM_PING_MS = 10_000;
// The most an update can say (each mask is at most 2000 lights).
const MAX_UPDATE_BYTES = 4 * 1024 * 1024;
// An op, or a fan of them (shared/live.ts): its lights field at most every light there can be.
const op = z.union([z.tuple([z.string().max(300)]), z.tuple([z.string().max(300), z.unknown()]), z.tuple([z.string().max(300), z.unknown(), z.string().max(11_000)])]);
const roomRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), rev: z.number().int().nullable(), epoch: z.string().max(100).optional(), fans: z.boolean().optional() }),
  z.object({ type: z.literal("update"), id: z.string().min(1).max(100), ops: z.array(op).max(MAX_OPS), note: z.string().max(60).optional() }),
  z.object({ type: z.literal("presence"), floor: z.number().int().nullable(), selected: z.array(z.number().int()).max(MAX_PRESENCE_SELECTED) }),
  // A page from before the live state, asking the old way.
  z.object({ type: z.literal("apply"), id: z.string().max(100) }).passthrough(),
]);
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

export function apiRoutes({ config, arclamp, db, relay, origins, lights, feed, live, pools, layout, sketches, instances = null, health = null, presence = createPresence() }: ApiDeps) {
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
  // Streetview's maps, by their build's id, to anyone, so Cloudflare can keep
  // them: before CORS, whose Vary: Origin a shared cache shouldn't see (the
  // page fetches them from its own address).
  if (config.roomstageDir) api.use("/streetview/*", streetviewPublicFiles(config.roomstageDir));
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

  const { currentLights } = lights;
  if (sketches) {
    api.route("/sketches", sketches);
    // Sketches' builds, in the room.
    if (instances) api.route("/", instanceRoutes(instances));
  }
  // Shaders, by vibes' keys: muted, masked, reordered, taken out; their params.
  const shaders = createShaders({ config, arclamp, db, instances, pools });
  api.route("/", shaderRoutes(shaders));
  // The room photographed from a few places, to see it lit as it is now.
  if (config.roomstageDir) api.route("/streetview", streetviewRoutes(config.roomstageDir, db));

  /** Room tone, merged into arclamp's, and noted in the history (a drag's run of changes as one). */
  async function setRoomtone(lights: Record<string, Channels>, user: Me, code?: string, undo?: boolean) {
    const d = await arclamp.mergeRoomtone({ lights });
    const ids = Object.keys(lights).map(Number);
    if (ids.length > 0) {
      db.logCoalesced({ user, action: "roomtone.set", detail: { lights: ids.length, ...(code ? { code } : {}), ...(undo ? { undo } : {}) } }, ROOMTONE_LOG_WINDOW_MS);
    }
    return d;
  }
  // Pages' updates to the live state (over the room socket).
  const updates = createUpdates({
    shaders,
    instances,
    pools,
    layout,
    setRoomtone,
    shown: (soon) => (soon ? feed.soon() : feed.now()),
    logParam(pool, name, lights, user) {
      // A param of a shader in the room (its instance's pool), in the history: a drag's run as one.
      const owner = pools.get(pool)?.owner ?? "";
      if (!owner.startsWith("instance:")) return;
      const inst = db.instance(owner.slice("instance:".length));
      if (!inst) return;
      db.logCoalesced(
        {
          user,
          action: "shader.param",
          ...(inst.shader_id !== null ? { shaderId: inst.shader_id } : {}),
          shaderName: db.sketch(inst.sketch_id)?.name ?? null,
          detail: { instance: inst.id, param: name, lights },
        },
        ROOMTONE_LOG_WINDOW_MS,
        (last) => last?.instance === inst.id && last?.param === name,
      );
    },
  });

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

    // The map's layout (layout.ts has the rules), the same as the live state's updates change it.
    .put("/placements", zValidator("json", z.object({ placements: z.array(placement).min(1).max(500) }), badBody), async (c) => {
      await layout.place(c.req.valid("json").placements, c.get("user"));
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
        await layout.setRails(c.req.valid("json").rails, c.get("user"));
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
        await layout.turn(c.req.valid("json").lights, c.get("user"));
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
        await layout.tag(c.req.valid("json").lights, c.get("user"));
        return c.body(null, 204);
      },
    )

    // arclamp's lights.json, rebuilt from its API with everything changed
    // in vibes filled in (see lightsFile).
    .get("/lights.json", async (c) => {
      c.header("Content-Disposition", 'attachment; filename="lights.json"');
      return c.body(`${JSON.stringify(lightsFile(await currentLights()), null, 2)}\n`, 200, { "Content-Type": "application/json" });
    })

    // The room socket (RoomRequest and RoomMessage, in shared/live.ts): the
    // live state, once the page says hello: the whole tree (or, for a page
    // that's had it, what's changed since), then each change as it's made;
    // and the page's updates, each answered once the tree shows it
    // (updates.ts). A page sends the next without waiting: in live mode, its
    // latest changes each time they change, so the room keeps up with a drag.
    // Its origin is checked as every request's is (above): a socket isn't
    // held to the same-origin rule.
    .get(
      "/scene/ws",
      upgradeWebSocket((c) => {
        const cookie = (c.get("user") as Me | null) ?? null;
        let on: ReturnType<typeof whoIsOn> | null = null;
        let session: ReturnType<typeof updates.session> | null = null;
        let here: ReturnType<typeof presence.join> | null = null;
        let closed = false;
        let say = (_message: string) => {};
        let unsubscribe = () => {};
        let ping: ReturnType<typeof setInterval> | undefined;
        const answer = (message: RoomMessage) => say(JSON.stringify(message));

        return {
          onOpen(_evt, ws) {
            say = (message) => {
              if (!closed) ws.send(message);
            };
            on = whoIsOn(cookie, config, ws, (u) => {
              session = updates.session(u, answer);
              here = presence.join(u, say);
            });
            ping = setInterval(() => say('{"type":"ping"}'), STREAM_PING_MS);
          },
          onMessage(evt) {
            const text = typeof evt.data === "string" && evt.data.length <= MAX_UPDATE_BYTES ? evt.data : "";
            // Who's there, first (from another of vibes' addresses).
            if (on?.take(text) === null || !session) return;
            let asked: ReturnType<typeof roomRequest.safeParse> | null = null;
            try {
              asked = roomRequest.safeParse(JSON.parse(text));
            } catch {
              // Not JSON: refused below.
            }
            if (!asked?.success) {
              answer({ type: "refused", id: "", error: "invalid request", code: "bad_body", made: {} });
              return;
            }
            const m = asked.data;
            if (m.type === "hello") {
              // The tree, or what's changed since the page had it, then every change: nothing between them lost.
              unsubscribe();
              const fans = m.fans === true;
              const missed = m.rev === null ? null : live.since(m.rev, m.epoch, fans);
              if (missed) for (const d of missed) say(d);
              else say(live.state());
              unsubscribe = live.subscribe(say, fans);
            } else if (m.type === "update") {
              // Its fans opened, it's ops like any other.
              const ops = unfanOps(m.ops, MAX_OPS);
              if (ops === "bad") answer({ type: "refused", id: m.id, error: "a fan is of lights' paths, with a lights field", code: "bad_update", made: {} });
              else if (ops === "too_big") answer({ type: "refused", id: m.id, error: `an update carries at most ${MAX_OPS} changes`, code: "too_big", made: {} });
              else session.take(m.id, ops, m.note);
            } else if (m.type === "presence") {
              here?.move(m.floor, m.selected);
            } else {
              // A page from before: it says why its changes don't go through.
              say(JSON.stringify({ type: "refused", id: m.id, at: 0, error: "vibes has changed since this page loaded: reload it", code: "reload", made: {} }));
            }
          },
          onClose() {
            closed = true;
            on?.done();
            unsubscribe();
            session?.close();
            here?.leave();
            clearInterval(ping);
          },
        };
      }),
    )

    // Shaders' scripts, by hash (?hashes=a,b), for the preview: the feed leaves them out.
    .get("/scene/scripts", (c) => {
      const all = feed.scripts();
      const wanted = (c.req.query("hashes") ?? "").split(",").filter((h) => all.has(h));
      return c.json(Object.fromEntries(wanted.map((h) => [h, all.get(h)!])));
    })

    .get("/health", async (c) => c.json(health?.latest() ?? (await arclamp.health())))

    .get("/activity", async (c) => {
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
      return c.json(await db.activity(limit));
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
