// The room, as vibes has it, for the live state (live.ts: its scene part,
// which every page has): the stack of shaders as vibes has them (Shader, in
// shared/vibes.ts), top first, and the room tone; made again whenever it may
// be different, and handed on (subscribe). It's made from arclamp's scene,
// followed as it changes (/v1/scene/events: the whole scene to start, then
// each shader as it's added or changes, and each one removed), each shader
// with its sketch (by its stamp), footprint and instance; and the instances
// not in arclamp yet, on their way in (or that couldn't go in), each where
// it's to go in: just above the shader it's to be above, or on top.
// Each shader has vibes' key (shader-keys.ts), never arclamp's id. Scripts
// are left out, as arclamp's events leave them out, saying which by hash:
// vibes fetches each new one once, for its stamp and for the preview (which
// fetches the ones it needs, by hash: /api/scene/scripts). So it's small.
//
// What vibes changes in the scene itself (through noting(arclamp), which
// every route writes through) is shown at once, to every browser, as it's
// made: arclamp only looks for changes to send ten times a second, so its
// event comes up to a tenth of a second later. When it does, it has the last
// word. A shader shown changed that no event confirms (a move arclamp made
// differently, with someone else moving shaders at once) is asked after.
//
// A footprint is every light a shader has changed since its script last did,
// before its mask or mute: where its code lights. Each frame of the light
// stream says what every shader's latest render changed (its touched
// section: touched(), from the relay). The union is kept, in the database
// (written at most once a second), and starts again with each new script.
//
// A shader's instance (and footprint) goes with it: when arclamp says it's
// removed, or when it's missing from the whole scene and arclamp, asked,
// says there's no such shader (rather than one too new to be in it).

import { createHash } from "node:crypto";
import { decodeTouched, lightsOf, type LightsResponse, type RoomTemplate, type ShaderDescriptor } from "../shared/arclamp.ts";
import type { SceneFeed, Shader, ShaderSketch } from "../shared/vibes.ts";
import { ArclampError, type Arclamp } from "./arclamp.ts";
import type { Db, InstanceRow } from "./db.ts";
import type { Config } from "./env.ts";
import type { EventHandlers, Following } from "./event-stream.ts";
import type { Instances } from "./instances.ts";
import type { SceneShader } from "./base-color.ts";
import type { SeenShader } from "./params.ts";
import { rclampKey, shaderOfKey } from "./shaders.ts";
import { readStamp, sketchOf } from "./stamp.ts";

// Events that come together (a move shifts several shaders) go on as one.
const GATHER_MS = 20;
const FOOTPRINT_WRITE_MS = 1000;
// The lights' layout, fetched again when the stream doesn't fit it, at most this often.
const LAYOUT_RETRY_MS = 10_000;
// Light stream messages kept until the layout comes: a couple of seconds' worth.
const MAX_EARLY = 200;
// A shader vibes changed is asked after if no event's said how it is by then.
const CONFIRM_MS = 500;
// A run of changes (live mode's drag) changes the room as each comes; the
// scene that shows them goes to browsers at most this often (soon).
const PACE_MS = 10;

export interface FeedDeps {
  config: Config;
  db: Db;
  /** For scripts the events leave out, and whether a shader's there. */
  arclamp: Pick<Arclamp, "shader">;
  /** Follows arclamp's scene events (event-stream.ts, on /v1/scene/events). */
  follow: (on: EventHandlers) => Following;
  /** The lights, in arclamp's order: what the light stream's touched bits are over. */
  layout: () => Promise<LightsResponse>;
  /** Instances, while sketches are on. */
  instances?: () => Instances | null;
  /** Told the shaders in the scene that are instances' (by their stamps), each time it's made: for linking them for params (params.ts). */
  onShaders?: (shaders: SeenShader[]) => void;
  /** Told every shader in the scene (not the room tone), each time it's made: for keeping the base Tone (base-color.ts). */
  onScene?: (shaders: SceneShader[]) => void;
  confirmMs?: number;
}

/**
 * A shader as the feed keeps it: without its script, or what it's changing
 * this second (which arclamp sends ten times a second; footprints have
 * touched, and nothing else needs it).
 */
type Kept = Omit<ShaderDescriptor, "script" | "changing">;

const keep = ({ script: _script, changing: _changing, ...rest }: ShaderDescriptor): Kept => rest;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sorted = (ids: Iterable<number>) => [...ids].sort((a, b) => a - b);

export function createSceneFeed({ config, db, arclamp, follow, layout, instances = () => null, onShaders, onScene, confirmMs = CONFIRM_MS }: FeedDeps) {
  const shaders = new Map<number, Kept>();
  // Whether it's been told the whole scene yet.
  let whole = false;
  // Scripts by hash; the sketch each was built from, and the instance it is (by its stamp, signed by vibes).
  const scripts = new Map<string, string>();
  const sketches = new Map<string, ShaderSketch | undefined>();
  const stampedFor = new Map<string, string | null>();
  // By shader: the lights it's changed, and its script's hash (null until that's known).
  const footprints = new Map<number, { hash: string | null; lights: Set<number> }>(
    db.footprints().map((f) => [f.shaderId, { hash: f.scriptHash, lights: new Set(f.lights) }]),
  );
  const unwritten = new Set<number>();
  // Shaders shown as vibes changed them, until an event says how they are: since when.
  const unconfirmed = new Map<number, number>();
  let confirming: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(feed: SceneFeed, json: string) => void>();
  let latest: { feed: SceneFeed; json: string } | null = null;
  let lights: LightsResponse | null = null;
  let layoutAt = 0;
  let stopped = false;

  function learnScript(script: string): string {
    const hash = sha(script);
    if (!scripts.has(hash)) {
      scripts.set(hash, script);
      sketches.set(hash, sketchOf(script, config.signingKey, db));
      const stamp = readStamp(script, config.signingKey);
      stampedFor.set(hash, stamp?.verified ? (stamp.stamp.shader ?? null) : null);
    }
    return hash;
  }

  /** The scripts of shaders whose script is new to vibes, each fetched once. */
  async function fetchScripts() {
    const wanted = [...shaders.values()].filter((n) => n.type === "js" && n.script_hash && !scripts.has(n.script_hash));
    await Promise.all(
      wanted.map(async (n) => {
        try {
          const d = await arclamp.shader(n.id);
          if (d.script !== undefined) learnScript(d.script);
        } catch {
          // Gone meanwhile, or arclamp's away: asked again next time.
        }
      }),
    );
  }

  /** A shader's footprint, started again if its script's changed. */
  function footprintOf(id: number, hash: string | null) {
    let f = footprints.get(id);
    if (!f || (hash !== null && f.hash !== null && f.hash !== hash)) {
      f = { hash, lights: new Set() };
      footprints.set(id, f);
    } else if (f.hash === null && hash !== null) {
      f.hash = hash;
      if (f.lights.size > 0) unwritten.add(id);
    }
    return f;
  }

  /** A shader that's gone: its footprint, and its instance, if it was one. */
  function gone(id: number) {
    if (footprints.delete(id)) db.deleteFootprint(id);
    unwritten.delete(id);
    instances()?.forget(id);
  }

  /** Shaders vibes keeps something of that the scene doesn't have: gone, if arclamp says there's no such shader. */
  async function sweep() {
    const kept = new Set([...footprints.keys(), ...db.instances().flatMap((i) => (i.state === "live" && i.shader_id !== null ? [i.shader_id] : []))]);
    for (const id of kept) {
      if (shaders.has(id)) continue;
      try {
        await arclamp.shader(id);
      } catch (err) {
        if (err instanceof ArclampError && err.status === 404 && !shaders.has(id)) {
          gone(id);
          gather();
        }
      }
    }
  }

  async function make() {
    if (!whole) return;
    await fetchScripts();
    const live = instances();
    // Each instance whose shader's in the scene goes with it (however far its going in has got).
    const byShader = new Map(db.instances().flatMap((i) => (i.shader_id !== null && shaders.has(i.shader_id) ? [[i.shader_id, i] as const] : [])));
    const inUse = new Set<string>();
    let roomtone: RoomTemplate | null = null;
    const inRoom: Shader[] = [];
    // Instances' shaders, by their stamps: the ones vibes may link for params.
    const ours: SeenShader[] = [];
    for (const n of [...shaders.values()].sort((a, b) => b.position - a.position)) {
      if (n.type === "roomtone") {
        roomtone = n.template ?? null;
        continue;
      }
      const hash = n.script_hash ?? "";
      inUse.add(hash);
      const sketch = sketches.get(hash) ?? null;
      const inst = byShader.get(n.id);
      const instance = inst && live ? live.view(inst) : null;
      if (inst && stampedFor.get(hash) === inst.id) {
        ours.push({ instance: inst.id, pool: inst.pool_id, shaderId: n.id, running: n.state === "running", respawns: n.respawns ?? 0, scriptHash: hash });
      }
      inRoom.push({
        key: inst ? inst.id : rclampKey(n.id),
        stage: "live",
        // Built from a sketch: the sketch's name (by the shader's stamp, or its instance).
        name: sketch || instance ? (sketch?.name ?? instance?.sketchName ?? "Unknown sketch") : `Shader #${n.id}`,
        state: n.state,
        error: n.error ?? null,
        muted: n.muted,
        mask: n.mask ?? [],
        sketch,
        instance,
        by: n.created_by,
        footprint: sorted(footprintOf(n.id, hash || null).lights),
        scriptHash: hash || null,
        pool: inst ? inst.pool_id : null,
      });
    }
    onShaders?.(ours);
    onScene?.([...shaders.values()].filter((n) => n.type === "js").map((n) => ({ id: n.id, position: n.position, muted: n.muted, mask: n.mask ?? [] })));
    for (const hash of [...scripts.keys()]) {
      if (inUse.has(hash)) continue;
      scripts.delete(hash);
      sketches.delete(hash);
      stampedFor.delete(hash);
    }
    // The rest aren't in the room yet: building, couldn't go in, or just put
    // in and their shader not heard of yet.
    const coming = live ? db.instances().filter((i) => i.shader_id === null || !shaders.has(i.shader_id)) : [];
    const feed: SceneFeed = { shaders: live ? stacked(inRoom, coming, live) : inRoom, roomtone };
    const json = JSON.stringify(feed);
    if (json === latest?.json) return;
    latest = { feed, json };
    for (const listener of listeners) listener(feed, json);
  }

  /**
   * The shaders in the room (top first) with those on their way in among
   * them, each where it's to go in: just above the one it's to be above (as
   * instances.ts puts it there), or at the bottom; on top, the latest topmost,
   * if it's to go on top or what it's to be above is gone.
   */
  function stacked(inRoom: Shader[], coming: InstanceRow[], live: Instances): Shader[] {
    const latest = [...coming].sort((a, b) => b.at - a.at);
    const keyOf = (key: string) => {
      const it = shaderOfKey(db, key);
      return it && (it.instance?.id ?? rclampKey(it.arclampId!));
    };
    const comingOf = (row: InstanceRow) => shaderOfInstance(row, live);
    let stack = [...latest.filter((i) => i.above === null).map(comingOf), ...inRoom];
    // Above one that's itself on its way in: placed once that is.
    for (let waiting = latest.filter((i) => i.above !== null); waiting.length > 0; ) {
      const still = waiting.filter((i) => {
        const at = i.above === "" ? stack.length : stack.findIndex((s) => s.key === keyOf(i.above!));
        if (at < 0) return true;
        stack.splice(at, 0, comingOf(i));
        return false;
      });
      if (still.length === waiting.length) {
        stack = [...still.map(comingOf), ...stack];
        break;
      }
      waiting = still;
    }
    return stack;
  }

  /** An instance on its way in (or that couldn't go in), as a shader in the stack, as it's wanted. */
  function shaderOfInstance(row: InstanceRow, live: Instances): Shader {
    const i = live.view(row);
    return {
      key: i.id,
      stage: i.state === "failed" ? "failed" : "building",
      name: i.sketchName ?? "Unknown sketch",
      state: null,
      error: i.error,
      muted: row.muted,
      mask: row.mask ?? [],
      sketch: { id: i.sketchId, name: i.sketchName, commit: i.commit, edited: false, deleted: db.sketch(i.sketchId)?.deleted_at != null },
      instance: i,
      by: i.by.name,
      footprint: [],
      scriptHash: null,
      pool: row.pool_id,
    };
  }

  // One make at a time; asked for while one's going, one more after it.
  let making: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  let madeAt = 0;
  function run(): Promise<void> {
    madeAt = Date.now();
    making = make()
      .catch((err) => console.error("couldn't make the scene feed:", err))
      .finally(() => (making = null));
    return making;
  }
  // The next paced make (soon), and everyone waiting on it.
  let pacing: Promise<void> | null = null;
  /** The scene made, and sent on, with every change made so far: now, or once it's been PACE_MS since the last. */
  function soon(): Promise<void> {
    pacing ??= new Promise<void>((done) => setTimeout(done, Math.max(0, madeAt + PACE_MS - Date.now()))).then(() => {
      pacing = null;
      clearTimeout(gathering);
      gathering = undefined;
      return build();
    });
    return pacing;
  }
  function build(): Promise<void> {
    if (queued) return queued;
    if (!making) return run();
    queued = making.then(() => {
      queued = null;
      return run();
    });
    return queued;
  }
  let gathering: ReturnType<typeof setTimeout> | undefined;
  // Paced too, so a run of changes (each a gather) makes a scene at most every PACE_MS.
  function gather() {
    if (stopped || gathering) return;
    gathering = setTimeout(
      () => {
        gathering = undefined;
        void build();
      },
      Math.max(GATHER_MS, madeAt + PACE_MS - Date.now()),
    );
  }

  const following = follow({
    event(name, data) {
      if (name === "snapshot") {
        shaders.clear();
        unconfirmed.clear();
        for (const n of JSON.parse(data) as ShaderDescriptor[]) shaders.set(n.id, keep(n));
        whole = true;
        void sweep();
        gather();
      } else if (name === "shader") {
        const n = keep(JSON.parse(data) as ShaderDescriptor);
        unconfirmed.delete(n.id);
        if (put(n)) gather();
      } else if (name === "removed") {
        const { id } = JSON.parse(data) as { id: number };
        unconfirmed.delete(id);
        shaders.delete(id);
        gone(id);
        gather();
      }
    },
  });

  function guessed(id: number) {
    unconfirmed.set(id, Date.now());
    if (!confirming && !stopped) confirming = setTimeout(confirm, confirmMs);
  }
  /** Asks arclamp how each shader is that's waited long enough for an event. */
  async function confirm() {
    confirming = undefined;
    const due = [...unconfirmed].filter(([, at]) => Date.now() - at >= confirmMs).map(([id]) => id);
    for (const id of due) unconfirmed.delete(id);
    await Promise.all(
      due.map(async (id) => {
        try {
          answered(await arclamp.shader(id), false);
        } catch (err) {
          if (!(err instanceof ArclampError && err.status === 404)) return;
          shaders.delete(id);
          gone(id);
        }
      }),
    );
    if (due.length > 0) gather();
    if (unconfirmed.size > 0 && !stopped) confirming = setTimeout(confirm, confirmMs);
  }

  /** A shader as it is now; true if that's news. */
  function put(n: Kept): boolean {
    const was = shaders.get(n.id);
    shaders.set(n.id, n);
    return !was || JSON.stringify(was) !== JSON.stringify(n);
  }

  /**
   * A shader's descriptor, as arclamp gave it (answering a change to it, or
   * asked): its script, if it has one, learned. A change's answer waits for
   * its event, as arclamp may have changed it again since.
   */
  function answered(d: ShaderDescriptor, change = true) {
    const hash = d.type === "js" && d.script !== undefined ? learnScript(d.script) : undefined;
    put({ ...keep(d), ...(hash ? { script_hash: hash } : {}) });
    if (change) guessed(d.id);
  }

  /** Some of a shader changed, as vibes asked: muted, or its mask (none, if it's empty). */
  function patch(id: number, change: Partial<Kept>) {
    const n = shaders.get(id);
    if (!n) return;
    const next: Kept = { ...n, ...change };
    if ("mask" in change && !change.mask?.length) delete next.mask;
    put(next);
    guessed(id);
  }

  /** A shader moved, as arclamp moves one: taken out, and put back in at `position` (1 to the last), the rest closing up around it. */
  function move(id: number, position: number) {
    const stack = [...shaders.values()].filter((n) => n.type !== "roomtone").sort((a, b) => a.position - b.position);
    const moving = stack.findIndex((n) => n.id === id);
    if (moving < 0) return;
    const [n] = stack.splice(moving, 1);
    stack.splice(Math.min(Math.max(position, 1), stack.length + 1) - 1, 0, n!);
    stack.forEach((s, i) => {
      if (s.position === i + 1) return;
      put({ ...s, position: i + 1 });
      guessed(s.id);
    });
  }

  /**
   * arclamp as vibes changes it, each change shown at once: the same client,
   * its writes told to the feed as each one lands (ahead of its event). It's
   * sent on with whatever comes in the same moment (putting an instance in is
   * a shader made, masked and noted), and straight away to whoever asks (now).
   */
  function noting(a: Arclamp): Arclamp {
    const then = <T>(change: () => void, value: T) => {
      if (whole) {
        change();
        gather();
      }
      return value;
    };
    return {
      ...a,
      // Put in at a position, the rest above it move up.
      createShader: async (script, position, initial) => {
        const d = await a.createShader(script, position, initial);
        return then(() => {
          answered(d);
          move(d.id, d.position);
        }, d);
      },
      setScript: async (id, script) => {
        const d = await a.setScript(id, script);
        return then(() => answered(d), d);
      },
      mergeRoomtone: async (template) => {
        const d = await a.mergeRoomtone(template);
        return then(() => answered(d), d);
      },
      setMuted: async (id, muted) => then(() => patch(id, { muted }), await a.setMuted(id, muted)),
      setMask: async (id, mask) => then(() => patch(id, { mask: sorted(new Set(mask)) }), await a.setMask(id, mask)),
      moveShader: async (id, position) => then(() => move(id, position), await a.moveShader(id, position)),
      deleteShader: async (id) => {
        const out = () => {
          shaders.delete(id);
          gone(id);
        };
        try {
          await a.deleteShader(id);
        } catch (err) {
          // Gone already is gone.
          if (err instanceof ArclampError && err.status === 404) then(out, undefined);
          throw err;
        }
        then(out, undefined);
      },
      clearScene: async () => {
        await a.clearScene();
        then(() => {
          for (const n of [...shaders.values()]) {
            if (n.type === "roomtone") continue;
            shaders.delete(n.id);
            gone(n.id);
          }
        }, undefined);
      },
    };
  }

  // The light stream's messages that came before the layout did, to read once it has.
  let early: Uint8Array[] = [];
  async function loadLayout() {
    if (Date.now() - layoutAt < LAYOUT_RETRY_MS) return;
    layoutAt = Date.now();
    try {
      lights = await layout();
    } catch {
      // arclamp's away: next time.
    }
    if (!lights) return;
    const waiting = early;
    early = [];
    for (const message of waiting) touched(message);
  }
  void loadLayout();

  /** One message of the light stream: what each shader touched in its frame, into its footprint. */
  function touched(message: Uint8Array) {
    if (!lights) {
      if (early.length < MAX_EARLY) early.push(message);
      void loadLayout();
      return;
    }
    let frame: ReturnType<typeof decodeTouched>;
    try {
      frame = decodeTouched(message, lights);
    } catch {
      void loadLayout();
      return;
    }
    if (!frame) return;
    let grew = false;
    for (const s of frame.shaders) {
      const f = footprintOf(s.id, shaders.get(s.id)?.script_hash ?? null);
      for (const id of lightsOf(s.touched, frame.ids)) {
        if (f.lights.has(id)) continue;
        f.lights.add(id);
        unwritten.add(s.id);
        grew = true;
      }
    }
    if (grew) gather();
  }

  function write() {
    for (const id of unwritten) {
      const f = footprints.get(id);
      if (f?.hash) db.setFootprint(id, f.hash, sorted(f.lights));
      if (!f || f.hash) unwritten.delete(id);
    }
  }
  const writing = setInterval(write, FOOTPRINT_WRITE_MS);
  writing.unref();

  return {
    /** The scene as last made, if it's been made. */
    current: () => latest,

    /** The scene as vibes has it now: made (with any change vibes has just made, or is making), and sent on if it's different. */
    async now(): Promise<SceneFeed | null> {
      clearTimeout(gathering);
      gathering = undefined;
      await build();
      return latest?.feed ?? null;
    },

    /** As now, but paced: made at most every PACE_MS, however many ask (live mode's run of changes). */
    soon,

    noting,

    /** Each shader's script, by hash (for the preview). */
    scripts: () => scripts,

    touched,

    /** Tells `listener` of each new scene; returns a way to stop. */
    subscribe(listener: (feed: SceneFeed, json: string) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Something's changed in vibes (an instance): made again now. */
    poke: () => gather(),

    stop() {
      stopped = true;
      following.stop();
      clearTimeout(gathering);
      clearTimeout(confirming);
      clearInterval(writing);
      write();
    },
  };
}

export type SceneFeedSource = ReturnType<typeof createSceneFeed>;
