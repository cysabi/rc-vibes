// Params' streams: each pool's values (pools.ts) to the code running with it.
// The protocol is the library's (packages/vibes/src/wire.ts).
//
// vibes links a shader in the room once in its sandbox's life: an eval in
// arclamp hands the library where vibes is and a token of its instance's
// pool. The library then opens POST /shader-api/params, saying what its
// sketch declares (so the pool's declarations are the room's), and vibes
// answers with every value (state), then each change as it's made (change),
// and something every 15 s. A new script in the same sandbox keeps the link
// and opens its own stream; a new sandbox (a respawn) needs linking again.
// Nothing is lost: within a stream, every change arrives, in order, and a
// stream that breaks opens again with every value. Code too slow to read its
// stream loses the stream, not a change. A sketch's preview, in its box,
// follows its own pool the same way (a token from /box-api/pools: sketches.ts).
//
// The token is the pool's id and its link's number, signed: linking again
// counts up, so older tokens stop working. A shader's is in arclamp's audit
// log (with the eval). Whoever can read that can read its values, say what
// its sketch declares (which changes which controls show, not the values
// kept), or take its stream over, cutting its shader off until vibes links it
// again.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { checkSpec, MAX_PARAMS, PROTOCOL, type ColorValue, type EndEvent, type ParamSpec } from "../shared/params.ts";
import type { Arclamp } from "./arclamp.ts";
import type { Pools } from "./pools.ts";

const KEEP_ALIVE_MS = 15_000;
// More than this waiting for a shader to read, and its stream goes.
const MOST_QUEUED = 256 * 1024;
const HELLO_LIMIT = 64 * 1024;
const WATCH_MS = 5_000;
// After linking, or a stream ending, how long the library has to open its own.
const LINK_WAIT_MS = 10_000;
const FIRST_RETRY_MS = 2_000;
const MOST_RETRY_MS = 60_000;

/**
 * A change to a param's values, as the API takes it (Changes): each value
 * with its lights; null puts them back to the default. Whether a value is
 * one of its param's is the library's rules' to say (cleanValue, in
 * instances.ts), as everywhere else.
 */
export const changesBody = z
  .array(
    z.tuple([
      z.union([z.number().finite(), z.boolean(), z.custom<ColorValue>((v) => typeof v === "object" && v !== null && !Array.isArray(v)), z.null()]),
      z.array(z.number().int().positive()).max(2000),
    ]),
  )
  .min(1)
  .max(100);

/** What a shader declares, checked: any that aren't params are left out, and why. */
export function declarationsOf(raw: unknown): { specs: ParamSpec[]; dropped: string[] } {
  const specs: ParamSpec[] = [];
  const dropped: string[] = [];
  if (!Array.isArray(raw)) return { specs, dropped: ["its params aren't a list"] };
  for (const item of raw.slice(0, MAX_PARAMS)) {
    const spec = checkSpec(item);
    if (typeof spec === "string") dropped.push(spec);
    else if (specs.some((s) => s.name === spec.name)) dropped.push(`param ${spec.name} is declared twice`);
    else specs.push(spec);
  }
  if (raw.length > MAX_PARAMS) dropped.push(`only the first ${MAX_PARAMS} params are kept`);
  return { specs, dropped };
}

const mac = (secret: string, id: string, link: number) => createHmac("sha256", secret).update(`params:${id}:${link}`).digest("base64url");

/** A token for a pool's stream: the pool, which link, signed. */
export const linkToken = (secret: string, id: string, link: number) => `${id}.${link}.${mac(secret, id, link)}`;

/** The pool and link a token is for, if it's one vibes made. */
export function linkOfToken(secret: string, token: string): { id: string; link: number } | null {
  const m = /^([^.]+)\.(\d{1,9})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const [, id, n, sig] = m as unknown as [string, string, string, string];
  const given = Buffer.from(sig);
  const want = Buffer.from(mac(secret, id, Number(n)));
  return given.length === want.length && timingSafeEqual(given, want) ? { id, link: Number(n) } : null;
}

const eventText = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface Stream {
  write(text: string): void;
  /** Ended on purpose, saying why (or just closed). */
  end(reason?: EndEvent["reason"]): void;
}

/** An event stream as a response: written to as things happen; done with (onClose) when either side's finished. */
function eventStream(onClose: () => void): { response: Response; stream: Stream } {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(keepAlive);
    onClose();
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c;
      },
      cancel: finish,
    },
    new ByteLengthQueuingStrategy({ highWaterMark: MOST_QUEUED }),
  );
  const write = (text: string) => {
    if (done) return;
    controller.enqueue(encoder.encode(text));
    // Too far behind: the stream goes (the shader opens another, with every value), not a change.
    if ((controller.desiredSize ?? 0) < 0) {
      controller.error(new Error("the shader isn't keeping up"));
      finish();
    }
  };
  const keepAlive = setInterval(() => write(": keep-alive\n\n"), KEEP_ALIVE_MS);
  keepAlive.unref();
  const stream: Stream = {
    write,
    end(reason) {
      if (done) return;
      if (reason) controller.enqueue(encoder.encode(eventText("end", { reason } satisfies EndEvent)));
      controller.close();
      finish();
    },
  };
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
  return { response, stream };
}

/** A shader in the room, as the scene has it, for an instance: with its pool. */
export interface SeenShader {
  instance: string;
  pool: string;
  shaderId: number;
  /** Running now (not starting, failing, or restarting). */
  running: boolean;
  /** How many times its sandbox has started over: each a new one, with no link. */
  respawns: number;
  scriptHash: string;
}

export interface LinkDeps {
  pools: Pools;
  arclamp: Pick<Arclamp, "evalShader">;
  /** What tokens are signed with. */
  secret: string;
  /** Where shaders reach vibes' stream (…/shader-api/params). */
  url: string;
  now?: () => number;
}

// A stream opened just before the scene said its shader's sandbox or script
// changed is the new one's, not the old's.
const STALE_SLACK_MS = 2_000;

export function createParamLinks({ pools, arclamp, secret, url, now = Date.now }: LinkDeps) {
  // Each pool's stream: one at a time.
  const streams = new Map<string, Stream>();
  // When each pool's stream opened, and when the scene last said its shader's sandbox or script changed.
  const opened = new Map<string, number>();
  const moved = new Map<string, number>();
  // Each pool's shader in the room, as the scene last had it.
  let seen = new Map<string, SeenShader>();
  // The last link of each pool's shader (or the last stream's end): for
  // which shader, sandbox and script (key), when, and how long until trying again.
  const tries = new Map<string, { key: string; at: number; wait: number; none: boolean }>();
  const linking = new Set<string>();
  // vibes just started: shaders linked before have this long to open their streams again by themselves.
  const began = now();

  const keyOf = (s: SeenShader) => `${s.shaderId}:${s.respawns}:${s.scriptHash}`;

  // Each change to a pool's values, to the code running with it.
  const unlisten = pools.onChange((pool, name, set) => streams.get(pool)?.write(eventText("change", { name, set })));

  /** Whether a pool's stream is from before its shader's sandbox or script changed, with none since: dead, if still open on this end. */
  function stale(pool: string): boolean {
    const at = moved.get(pool);
    return at !== undefined && (opened.get(pool) ?? 0) < at - STALE_SLACK_MS && now() - at >= LINK_WAIT_MS;
  }

  async function link(s: SeenShader, key: string) {
    const prev = tries.get(s.pool);
    const again = prev?.key === key;
    linking.add(s.pool);
    let outcome: "linked" | "none" | "failed" = "failed";
    try {
      if (!pools.get(s.pool)) return;
      const n = pools.relink(s.pool);
      // Generated, with JSON for data: nothing anyone typed is ever run.
      const code = `globalThis.__vibes?.connect(${JSON.stringify({ v: PROTOCOL, url, token: linkToken(secret, s.pool, n) })})`;
      const r = await arclamp.evalShader(s.shaderId, code);
      if (r.ok && r.result === "undefined") outcome = "none";
      else if (r.ok) {
        const answer = JSON.parse(r.result ?? "null") as { v?: number; error?: string } | null;
        outcome = answer?.v === PROTOCOL && !answer.error ? "linked" : "failed";
        if (outcome === "failed") console.warn(`params: shader ${s.shaderId} wouldn't link: ${r.result}`);
      } else console.warn(`params: linking shader ${s.shaderId} threw: ${r.error}`);
    } catch (err) {
      // Not reachable, its sandbox not up, or busy: next time.
      if ((err as { status?: number }).status !== 409) console.warn(`params: couldn't link shader ${s.shaderId}: ${(err as Error).message}`);
    } finally {
      linking.delete(s.pool);
    }
    // No library to link (or one too old): not again, for this sandbox and script.
    const first = outcome === "linked" ? LINK_WAIT_MS : FIRST_RETRY_MS;
    tries.set(s.pool, { key, at: now(), wait: again ? Math.min(MOST_RETRY_MS, prev!.wait * 2) : first, none: outcome === "none" });
  }

  /** Each running shader with no (live) stream linked, unless it's been tried for this sandbox and script lately (or has no library). */
  function check() {
    if (now() - began < LINK_WAIT_MS) return;
    for (const s of seen.values()) {
      if (!s.running || linking.has(s.pool) || (streams.has(s.pool) && !stale(s.pool))) continue;
      const key = keyOf(s);
      const t = tries.get(s.pool);
      if (t && t.key === key && (t.none || now() - t.at < t.wait)) continue;
      void link(s, key);
    }
  }

  const timer = setInterval(check, WATCH_MS);
  timer.unref();

  const bearer = (header: string | undefined) => {
    const [scheme, token = ""] = (header ?? "").split(" ");
    return scheme?.toLowerCase() === "bearer" ? linkOfToken(secret, token) : null;
  };

  return {
    /** The shaders in the room that are instances': linked as they need to be. */
    scene(shaders: SeenShader[]) {
      for (const s of shaders) {
        const was = seen.get(s.pool);
        if (was && keyOf(was) !== keyOf(s)) moved.set(s.pool, now());
      }
      seen = new Map(shaders.map((s) => [s.pool, s]));
      check();
    },

    /** A token for a pool's stream that isn't a shader's (a preview's): a new link, so any before it stop working. */
    token: (pool: string) => linkToken(secret, pool, pools.relink(pool)),

    /** A pool gone (its instance with it): its stream ended, and its link no good. */
    gone(pool: string) {
      streams.get(pool)?.end("gone");
      seen.delete(pool);
      tries.delete(pool);
      opened.delete(pool);
      moved.delete(pool);
    },

    /** Whether a pool's code has its stream open. */
    linked: (pool: string) => streams.has(pool),

    routes() {
      return new Hono().post(
        "/shader-api/params",
        bodyLimit({ maxSize: HELLO_LIMIT, onError: (c) => c.text("that's more than params", 413) }),
        async (c) => {
          const who = bearer(c.req.header("authorization"));
          const p = who ? pools.get(who.id) : undefined;
          if (!who || !p || p.link_epoch !== who.link) return c.text("that link is over", 401);
          let hello: { v?: unknown; params?: unknown };
          try {
            hello = await c.req.json();
          } catch {
            return c.text("say hello in JSON", 400);
          }
          if (hello?.v !== PROTOCOL) return c.text(`vibes speaks params protocol ${PROTOCOL}`, 400);
          const { specs, dropped } = declarationsOf(hello.params);
          for (const why of dropped) console.warn(`params: pool ${p.id}: ${why}`);
          // Its code says what it declares, as its owner.
          pools.declare(p.id, specs, p.owner);
          // One stream a pool: this one takes over.
          streams.get(p.id)?.end("replaced");
          const { response, stream } = eventStream(() => {
            if (streams.get(p.id) !== stream) return;
            streams.delete(p.id);
            // It'll likely open again by itself (a new script, or a blip): give it the time to.
            const s = seen.get(p.id);
            if (s) tries.set(p.id, { key: keyOf(s), at: now(), wait: LINK_WAIT_MS, none: false });
          });
          streams.set(p.id, stream);
          opened.set(p.id, now());
          tries.delete(p.id);
          stream.write(eventText("state", { v: PROTOCOL, values: pools.table(p.id) }));
          return response;
        },
      );
    },

    stop() {
      clearInterval(timer);
      unlisten();
      for (const s of streams.values()) s.end();
    },
  };
}

export type ParamLinks = ReturnType<typeof createParamLinks>;
