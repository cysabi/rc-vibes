// The room, as vibes pushes it (/api/scene/events, scene-feed.ts on the
// server): the stack of shaders as vibes has them (top first: the ones on
// their way in, then the ones in the room), and the room tone; sent again
// each time it changes, while anything here is watching. The feed leaves
// scripts out (scriptHash says which each is); the preview needs them to run
// pending edits, so they're fetched once each, by hash, and put back.

import { useSyncExternalStore } from "react";
import type { RoomTemplate } from "../shared/arclamp.ts";
import type { SceneFeed, Shader } from "../shared/vibes.ts";
import { request } from "./api.ts";

/** A shader as vibes sent it, with its script once that's here. */
export interface SceneShader extends Shader {
  script?: string;
}

/** The room: its shaders, top first, and its room tone. */
export interface Scene {
  shaders: SceneShader[];
  roomtone: RoomTemplate | null;
}

interface State {
  /** Undefined until the first scene. */
  scene: Scene | undefined;
  error: Error | null;
}

let state: State = { scene: undefined, error: null };
let feed: SceneFeed | null = null;
const scripts = new Map<string, string>();
const fetching = new Set<string>();
const listeners = new Set<() => void>();
let source: EventSource | null = null;

function publish() {
  if (!feed) return;
  const shaders = feed.shaders.map((s) => {
    const script = s.scriptHash ? scripts.get(s.scriptHash) : undefined;
    return script === undefined ? s : { ...s, script };
  });
  state = { scene: { shaders, roomtone: feed.roomtone }, error: null };
  for (const l of listeners) l();
}

function take(next: SceneFeed) {
  feed = next;
  publish();
  void fetchScripts();
}

/** The scripts the scene has that aren't here yet; the ones it's dropped, forgotten. */
async function fetchScripts() {
  if (!feed) return;
  const now = new Set(feed.shaders.flatMap((s) => (s.scriptHash ? [s.scriptHash] : [])));
  for (const hash of scripts.keys()) if (!now.has(hash)) scripts.delete(hash);
  const missing = [...now].filter((h) => !scripts.has(h) && !fetching.has(h));
  if (missing.length === 0) return;
  for (const h of missing) fetching.add(h);
  try {
    const got = await request<Record<string, string>>("GET", `/api/scene/scripts?hashes=${missing.join(",")}`);
    for (const [hash, script] of Object.entries(got)) scripts.set(hash, script);
    publish();
  } catch {
    // Tried again with the next scene.
  } finally {
    for (const h of missing) fetching.delete(h);
  }
}

// How long to wait before opening the stream again, once it's given up.
const RETRY_MS = 2000;
// vibes says something at least every 10 s (a ping, if nothing else); this
// long without a word, the stream's dead, though the browser may not know
// (vibes gone from behind a proxy that keeps the connection), so it's opened again.
const SILENT_MS = 25_000;
let retry: number | undefined;
let heard = 0;
let watchdog: number | undefined;

function open() {
  const es = new EventSource("/api/scene/events");
  source = es;
  heard = Date.now();
  window.clearInterval(watchdog);
  watchdog = window.setInterval(() => {
    if (source !== es || Date.now() - heard < SILENT_MS) return;
    es.close();
    source = null;
    open();
  }, SILENT_MS / 5);
  es.onopen = () => (heard = Date.now());
  es.addEventListener("ping", () => (heard = Date.now()));
  es.addEventListener("scene", (e) => {
    heard = Date.now();
    take(JSON.parse((e as MessageEvent<string>).data) as SceneFeed);
  });
  es.onerror = () => {
    // A dropped connection it reconnects by itself, but one answered with an
    // error (vibes restarting, behind a proxy) it gives up on for good: so
    // it's opened again here. Meanwhile the last scene stands.
    if (es.readyState === EventSource.CLOSED && source === es) {
      source = null;
      window.clearTimeout(retry);
      retry = window.setTimeout(() => {
        if (listeners.size > 0 && !source) open();
      }, RETRY_MS);
    }
    if (state.scene === undefined) {
      state = { ...state, error: new Error("couldn't reach vibes for the scene") };
      for (const l of listeners) l();
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!source) open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearTimeout(retry);
      window.clearInterval(watchdog);
      source?.close();
      source = null;
    }
  };
}

const snapshot = () => state;

/** The room, as `{ data }` (undefined until the first scene). */
export function useScene(): { data: Scene | undefined; error: Error | null } {
  const s = useSyncExternalStore(subscribe, snapshot);
  return { data: s.scene, error: s.error };
}

/** The scene, looked at again now (after changing it, to see it changed). */
export async function invalidateScene(): Promise<void> {
  const next = await request<SceneFeed | null>("GET", "/api/scene/live");
  if (next) take(next);
}
