// The scene, as vibes pushes it to browsers (/api/scene/events): arclamp's,
// followed as it changes (/v1/scene/events: the whole scene to start, then
// each shader as it's added or changes, and each one removed), with each
// shader's sketch, footprint and instance, and the instances not in arclamp
// yet; sent whenever it's different. Scripts are left out, as arclamp's
// events leave them out, saying which by hash: vibes fetches each new one
// once, for its stamp and for the preview (which fetches the ones it needs,
// by hash: /api/scene/scripts). So it's small.
//
// After vibes changes the scene itself, it reads it back at once (refresh),
// so whoever changed it sees their change straight away rather than when its
// event comes; a read that events overtook is dropped, as older than they are.
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
import { decodeTouched, lightsOf, type LightsResponse, type ShaderDescriptor } from "../shared/arclamp.ts";
import type { SceneFeed, SceneNode, ShaderSketch } from "../shared/vibes.ts";
import { ArclampError, type Arclamp } from "./arclamp.ts";
import type { Db } from "./db.ts";
import type { Config } from "./env.ts";
import type { EventHandlers, Following } from "./event-stream.ts";
import type { Instances } from "./instances.ts";
import { sketchOf } from "./stamp.ts";

// Events that come together (a move shifts several shaders) go on as one.
const GATHER_MS = 20;
const FOOTPRINT_WRITE_MS = 1000;
// The lights' layout, fetched again when the stream doesn't fit it, at most this often.
const LAYOUT_RETRY_MS = 10_000;
// Light stream messages kept until the layout comes: a couple of seconds' worth.
const MAX_EARLY = 200;

export interface FeedDeps {
  config: Config;
  db: Db;
  arclamp: Pick<Arclamp, "scene" | "shader">;
  /** Follows arclamp's scene events (event-stream.ts, on /v1/scene/events). */
  follow: (on: EventHandlers) => Following;
  /** The lights, in arclamp's order: what the light stream's touched bits are over. */
  layout: () => Promise<LightsResponse>;
  /** Instances, while sketches are on. */
  instances?: () => Instances | null;
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

export function createSceneFeed({ config, db, arclamp, follow, layout, instances = () => null }: FeedDeps) {
  const shaders = new Map<number, Kept>();
  // Whether it's been told (or read) the whole scene yet.
  let whole = false;
  // How many events it's heard, so a read they overtook can tell.
  let heard = 0;
  // Scripts by hash, and the sketch each was built from (by its stamp).
  const scripts = new Map<string, string>();
  const sketches = new Map<string, ShaderSketch | undefined>();
  // By shader: the lights it's changed, and its script's hash (null until that's known).
  const footprints = new Map<number, { hash: string | null; lights: Set<number> }>(
    db.footprints().map((f) => [f.shaderId, { hash: f.scriptHash, lights: new Set(f.lights) }]),
  );
  const unwritten = new Set<number>();
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
    const byShader = new Map(db.instances().flatMap((i) => (i.shader_id !== null && i.state === "live" ? [[i.shader_id, i] as const] : [])));
    const inUse = new Set<string>();
    const nodes: SceneNode[] = [...shaders.values()]
      .sort((a, b) => a.position - b.position)
      .map((n) => {
        if (n.type !== "js") return n;
        const { script_hash: hash = "", ...rest } = n;
        inUse.add(hash);
        const sketch = sketches.get(hash);
        const inst = byShader.get(n.id);
        return {
          ...rest,
          scriptHash: hash,
          footprint: sorted(footprintOf(n.id, hash || null).lights),
          ...(sketch ? { sketch } : {}),
          ...(inst && live ? { instance: live.view(inst) } : {}),
        };
      });
    for (const hash of [...scripts.keys()]) {
      if (inUse.has(hash)) continue;
      scripts.delete(hash);
      sketches.delete(hash);
    }
    // Not in the room yet: building, couldn't go in, or just put in and its shader not heard of yet.
    const pending = live ? db.instances().filter((i) => i.state !== "live" || i.shader_id === null || !shaders.has(i.shader_id)).map((i) => live.view(i)) : [];
    const feed: SceneFeed = { nodes, pending };
    const json = JSON.stringify(feed);
    if (json === latest?.json) return;
    latest = { feed, json };
    for (const listener of listeners) listener(feed, json);
  }

  // One make at a time; asked for while one's going, one more after it.
  let making: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  function run(): Promise<void> {
    making = make()
      .catch((err) => console.error("couldn't make the scene feed:", err))
      .finally(() => (making = null));
    return making;
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
  function gather() {
    if (stopped || gathering) return;
    gathering = setTimeout(() => {
      gathering = undefined;
      void build();
    }, GATHER_MS);
  }

  const following = follow({
    event(name, data) {
      if (name === "snapshot") {
        heard++;
        shaders.clear();
        for (const n of JSON.parse(data) as ShaderDescriptor[]) shaders.set(n.id, keep(n));
        whole = true;
        void sweep();
        gather();
      } else if (name === "shader") {
        heard++;
        const n = keep(JSON.parse(data) as ShaderDescriptor);
        const was = shaders.get(n.id);
        shaders.set(n.id, n);
        if (!was || JSON.stringify(was) !== JSON.stringify(n)) gather();
      } else if (name === "removed") {
        heard++;
        const { id } = JSON.parse(data) as { id: number };
        shaders.delete(id);
        gone(id);
        gather();
      }
    },
  });

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

    /** The scene read from arclamp now (unless events overtake the read), sent on if it's different. */
    async refresh(): Promise<SceneFeed | null> {
      const before = heard;
      try {
        const scene = await arclamp.scene();
        if (heard === before) {
          shaders.clear();
          for (const n of scene) {
            const hash = n.type === "js" && n.script !== undefined ? learnScript(n.script) : undefined;
            shaders.set(n.id, { ...keep(n), ...(hash ? { script_hash: hash } : {}) });
          }
          whole = true;
          await sweep();
        }
      } catch {
        // arclamp's away: the scene as last heard stands (the banners say so).
      }
      await build();
      return latest?.feed ?? null;
    },

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
      clearInterval(writing);
      write();
    },
  };
}

export type SceneFeedSource = ReturnType<typeof createSceneFeed>;
