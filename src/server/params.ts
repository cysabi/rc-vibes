// Params in the room: each instance's values (kept with it: instances.ts),
// and a stream to its shader. The protocol is the library's
// (packages/vibes/src/wire.ts).
//
// vibes links a shader once in its sandbox's life: an eval in arclamp hands
// the library where vibes is and a token of the instance's. The library then
// opens POST /shader-api/params, saying what its sketch declares, and vibes
// answers with every value (state), then each change as it's made (change),
// and something every 15 s. A new script in the same sandbox keeps the link
// and opens its own stream; a new sandbox (a respawn) needs linking again.
// Nothing is lost: within a stream, every change arrives, in order, and a
// stream that breaks opens again with every value. A shader too slow to read
// its stream loses the stream, not a change.
//
// The token is the instance's id and its link's number, signed: linking again
// counts up, so older tokens stop working. It's in arclamp's audit log (with
// the eval), and can only read the instance's values and say what it declares.

import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { LightInfo } from "../shared/arclamp.ts";
import { checkSpec, factsOf, groupsOf, MAX_PARAMS, passes, PROTOCOL, valuesOf, type Changes, type EndEvent, type ParamSpec, type ParamTable } from "../shared/params.ts";
import type { Arclamp } from "./arclamp.ts";
import type { Db } from "./db.ts";

const KEEP_ALIVE_MS = 15_000;
// More than this waiting for a shader to read, and its stream goes.
const MOST_QUEUED = 256 * 1024;
const HELLO_LIMIT = 64 * 1024;
const WATCH_MS = 5_000;
// After linking, or a stream ending, how long the library has to open its own.
const LINK_WAIT_MS = 10_000;
const FIRST_RETRY_MS = 2_000;
const MOST_RETRY_MS = 60_000;

const finite = z.number().finite();
const colorValue = z.object({ a: finite, b: finite, lm: finite.min(0), fidelity: z.number().min(0).max(1) });

/** A change to a param's values, as the API takes it (Changes): each value with its lights; null puts them back to the default. */
export const changesBody = z
  .array(z.tuple([z.union([finite, z.boolean(), colorValue, z.null()]), z.array(z.number().int().positive()).max(2000)]))
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

/** A shader's token for its instance's params: the instance, which link, signed. */
export const linkToken = (secret: string, id: string, link: number) => `${id}.${link}.${mac(secret, id, link)}`;

/** The instance and link a token is for, if it's one vibes made. */
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

/** A shader in the room, as the scene has it, for an instance. */
export interface SeenShader {
  instance: string;
  shaderId: number;
  /** Running now (not starting, failing, or restarting). */
  running: boolean;
  /** How many times its sandbox has started over: each a new one, with no link. */
  respawns: number;
  scriptHash: string;
}

export interface LinkDeps {
  db: Pick<Db, "instance" | "updateInstance">;
  arclamp: Pick<Arclamp, "evalShader">;
  /** What tokens are signed with. */
  secret: string;
  /** Where shaders reach vibes' stream (…/shader-api/params). */
  url: string;
  /** Every light, for which a param's for. */
  lights: () => Promise<LightInfo[]>;
  /** Told when what an instance declares changes (the scene feed shows it). */
  changed?: () => void;
  now?: () => number;
}

export function createParamLinks({ db, arclamp, secret, url, lights, changed = () => {}, now = Date.now }: LinkDeps) {
  const streams = new Map<string, Stream>();
  // Each instance's shader, as the scene last had it.
  let seen = new Map<string, SeenShader>();
  // The last link of each instance's shader (or the last stream's end): for
  // which shader, sandbox and script (key), when, and how long until trying again.
  const tries = new Map<string, { key: string; at: number; wait: number; none: boolean }>();
  const linking = new Set<string>();
  // vibes just started: shaders linked before have this long to open their streams again by themselves.
  const began = now();

  const keyOf = (s: SeenShader) => `${s.shaderId}:${s.respawns}:${s.scriptHash}`;

  /** Lights a param can have values for. */
  async function allowedFor(): Promise<(spec: ParamSpec) => (id: number) => boolean> {
    const facts = new Map((await lights()).map((l) => [l.id, factsOf(l)]));
    return (spec) => (id) => {
      const f = facts.get(id);
      return f !== undefined && passes(spec.lights, f);
    };
  }

  /** What a shader says its sketch declares, kept; values it can't have any more (another kind now, or lights it's no longer for) let go. */
  async function declare(id: string, specs: ParamSpec[]) {
    const inst = db.instance(id);
    if (!inst) return;
    const allowed = await allowedFor();
    const values: ParamTable = { ...inst.params };
    for (const spec of specs) {
      if (!values[spec.name]) continue;
      const ok = allowed(spec);
      const groups = groupsOf(spec, new Map([...valuesOf(spec, values[spec.name])].filter(([id]) => ok(id))));
      if (groups.length > 0) values[spec.name] = groups;
      else delete values[spec.name];
    }
    const same = JSON.stringify(inst.declared) === JSON.stringify(specs) && JSON.stringify(inst.params) === JSON.stringify(values);
    if (same) return;
    db.updateInstance(id, { declared: specs, params: values });
    changed();
  }

  async function link(s: SeenShader, key: string) {
    const prev = tries.get(s.instance);
    const again = prev?.key === key;
    linking.add(s.instance);
    let outcome: "linked" | "none" | "failed" = "failed";
    try {
      const inst = db.instance(s.instance);
      if (!inst) return;
      const n = inst.link_epoch + 1;
      db.updateInstance(s.instance, { link_epoch: n });
      // Generated, with JSON for data: nothing anyone typed is ever run.
      const code = `globalThis.__vibes?.connect(${JSON.stringify({ v: PROTOCOL, url, token: linkToken(secret, s.instance, n) })})`;
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
      linking.delete(s.instance);
    }
    // No library to link (or one too old): not again, for this sandbox and script.
    const first = outcome === "linked" ? LINK_WAIT_MS : FIRST_RETRY_MS;
    tries.set(s.instance, { key, at: now(), wait: again ? Math.min(MOST_RETRY_MS, prev!.wait * 2) : first, none: outcome === "none" });
  }

  /** Each running shader with no stream linked, unless it's been tried for this sandbox and script lately (or has no library). */
  function check() {
    if (now() - began < LINK_WAIT_MS) return;
    for (const s of seen.values()) {
      if (!s.running || streams.has(s.instance) || linking.has(s.instance)) continue;
      const key = keyOf(s);
      const t = tries.get(s.instance);
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
      seen = new Map(shaders.map((s) => [s.instance, s]));
      check();
    },

    /** A change to an instance's values, to its shader. */
    send(id: string, name: string, set: Changes) {
      streams.get(id)?.write(eventText("change", { name, set }));
    },

    /** An instance gone: its stream ended, and its link no good. */
    gone(id: string) {
      streams.get(id)?.end("gone");
      seen.delete(id);
      tries.delete(id);
    },

    /** Whether an instance's shader has its stream open. */
    linked: (id: string) => streams.has(id),

    routes() {
      return new Hono().post(
        "/shader-api/params",
        bodyLimit({ maxSize: HELLO_LIMIT, onError: (c) => c.text("that's more than params", 413) }),
        async (c) => {
          const who = bearer(c.req.header("authorization"));
          const inst = who ? db.instance(who.id) : undefined;
          if (!who || !inst || inst.link_epoch !== who.link) return c.text("that link is over", 401);
          let hello: { v?: unknown; params?: unknown };
          try {
            hello = await c.req.json();
          } catch {
            return c.text("say hello in JSON", 400);
          }
          if (hello?.v !== PROTOCOL) return c.text(`vibes speaks params protocol ${PROTOCOL}`, 400);
          const { specs, dropped } = declarationsOf(hello.params);
          for (const why of dropped) console.warn(`params: instance ${inst.id}: ${why}`);
          await declare(inst.id, specs);
          // One stream an instance: this one takes over.
          streams.get(inst.id)?.end("replaced");
          const { response, stream } = eventStream(() => {
            if (streams.get(inst.id) !== stream) return;
            streams.delete(inst.id);
            // It'll likely open again by itself (a new script, or a blip): give it the time to.
            const s = seen.get(inst.id);
            if (s) tries.set(inst.id, { key: keyOf(s), at: now(), wait: LINK_WAIT_MS, none: false });
          });
          streams.set(inst.id, stream);
          tries.delete(inst.id);
          stream.write(eventText("state", { v: PROTOCOL, values: db.instance(inst.id)?.params ?? {} }));
          return response;
        },
      );
    },

    stop() {
      clearInterval(timer);
      for (const s of streams.values()) s.end();
    },
  };
}

export type ParamLinks = ReturnType<typeof createParamLinks>;
