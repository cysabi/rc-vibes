// The room socket (/api/scene/ws; RoomMessage and RoomRequest, in
// shared/vibes.ts): the room as vibes pushes it (scene-feed.ts on the
// server), the stack of shaders as vibes has them, top first, and the room
// tone, sent again each time it changes while anything here is watching; and
// applies, a draft's changes sent as one (applyChanges), each answered once
// the scene showing it has come. The feed leaves scripts out (scriptHash says
// which each is); the preview needs them to run pending edits, so they're
// fetched once each, by hash, and put back.

import { useSyncExternalStore } from "react";
import type { RoomTemplate } from "../shared/arclamp.ts";
import type { Change, RoomMessage, RoomRequest, SceneFeed, Shader, ShaderKey } from "../shared/vibes.ts";
import { apiSocket, request } from "./api.ts";

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
let socket: WebSocket | null = null;

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

/** An apply vibes refused at one of its changes (`at`): the ones before it were made, adding `made`. */
export class ApplyError extends Error {
  readonly at: number;
  readonly made: Record<string, ShaderKey>;

  constructor(message: string, at: number, made: Record<string, ShaderKey>) {
    super(message);
    this.at = at;
    this.made = made;
  }
}

// Applies sent, by id, waiting for their answers.
const waiting = new Map<string, { resolve: (made: Record<string, ShaderKey>) => void; reject: (err: Error) => void }>();

// How long to wait before opening the socket again, once it's closed.
const RETRY_MS = 2000;
// vibes says something at least every 10 s (a ping, if nothing else); this
// long without a word, the socket's dead, though the browser may not know
// (vibes gone from behind a proxy that keeps the connection), so it's opened again.
const SILENT_MS = 25_000;
let retry: number | undefined;
let heard = 0;
let watchdog: number | undefined;

// The socket being opened (its address, and token, first: apiSocket); and,
// once it's open and has said who's there, the socket itself, for sends.
let opening = false;
let greeted: Promise<WebSocket> | null = null;

function open() {
  if (socket || opening) return;
  opening = true;
  greeted = apiSocket("/api/scene/ws").then(
    ({ url, hello }) =>
      new Promise<WebSocket>((resolve) => {
        opening = false;
        // Nothing wants it any more.
        if (listeners.size === 0 && waiting.size === 0) return;
        connect(url, hello, resolve);
      }),
  );
}

function connect(url: string, hello: string | null, greet: (ws: WebSocket) => void) {
  const ws = new WebSocket(url);
  socket = ws;
  heard = Date.now();
  window.clearInterval(watchdog);
  watchdog = window.setInterval(() => {
    if (socket === ws && Date.now() - heard >= SILENT_MS) ws.close();
  }, SILENT_MS / 5);
  ws.onopen = () => {
    heard = Date.now();
    if (hello) ws.send(hello);
    greet(ws);
  };
  ws.onmessage = (e: MessageEvent<string>) => {
    heard = Date.now();
    const m = JSON.parse(e.data) as RoomMessage;
    if (m.type === "scene") take(m.feed);
    if (m.type !== "applied" && m.type !== "refused") return;
    const asked = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.type === "applied") asked?.resolve(m.made);
    else asked?.reject(new ApplyError(m.error, m.at, m.made));
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    window.clearInterval(watchdog);
    // Applies with no answer now: made, or not, or some of them. Sending
    // them again is safe (a sketch is added once, however often it's sent).
    for (const [id, asked] of waiting) {
      waiting.delete(id);
      asked.reject(new Error("lost the connection to vibes"));
    }
    // Opened again in a moment, while anything's watching. Meanwhile the last scene stands.
    window.clearTimeout(retry);
    retry = window.setTimeout(() => {
      if (listeners.size > 0 && !socket) open();
    }, RETRY_MS);
    if (state.scene === undefined) {
      state = { ...state, error: new Error("couldn't reach vibes for the scene") };
      for (const l of listeners) l();
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && waiting.size === 0) {
      window.clearTimeout(retry);
      window.clearInterval(watchdog);
      const ws = socket;
      socket = null;
      ws?.close();
    }
  };
}

/**
 * A draft's changes, made in the room in order, as one apply; the shaders
 * it added, by the keys of the edits that added them. Refused at a change,
 * an ApplyError says which. Sent at once, whatever's still waiting for an
 * answer; `whole` (live mode's), it's everything pending, and stands for any
 * whole one sent before it that vibes hasn't made yet.
 */
export function applyChanges(changes: Change[], whole = false): Promise<Record<string, ShaderKey>> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    waiting.set(id, { resolve, reject });
    open();
    void greeted!.then((ws) => ws.send(JSON.stringify({ type: "apply", id, changes, ...(whole ? { whole } : {}) } satisfies RoomRequest)));
  });
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
