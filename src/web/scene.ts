// The room socket (/api/scene/ws; shared/live.ts): this page's copy of the
// live state, kept as vibes sends it (the whole tree, then each change, each
// numbered: a page that reconnects says the last it had, and gets what it
// missed), and this page's updates to it (sendUpdate), each answered once the
// tree shows it. Both ways, lights set to one value go as fans, opened again
// as they come. From the tree, the room as the page shows it (useScene: the
// stack of shaders, top first, the room tone, and the pools) and the lights'
// layout (useLayout). The tree leaves scripts out (scriptHash says which
// each shader's is); the preview needs them to run pending edits, so they're
// fetched once each, by hash, and put back. And the show (useShowOn,
// useShowClock, sendTransport), with arclamp's time to read its clock by,
// asked of vibes on the same socket (rtime.ts).

import { useCallback, useState, useSyncExternalStore } from "react";
import type { RoomTemplate } from "../shared/arclamp.ts";
import { fanOps, pathOf, unfanOps, withOps, type LiveTree, type Op, type Pool, type RoomMessage, type RoomRequest } from "../shared/live.ts";
import type { Presence } from "../shared/presence.ts";
import { NO_SCENES, type Scenes } from "../shared/scenes.ts";
import { RESTING, type CueMode, type ShowClock, type ShowState, type TransportAction } from "../shared/show.ts";
import type { Lights, Placement, RailChange, Shader, ShaderKey, TagChange, TypeChange } from "../shared/vibes.ts";
import { apiSocket, request } from "./api.ts";
import { heard as heardTime, pageNow } from "./rtime.ts";

/** A shader as vibes has it, with its script once that's here. */
export interface SceneShader extends Shader {
  script?: string;
}

/** The room: its shaders, top first, its room tone, and the pools of params. */
export interface Scene {
  shaders: SceneShader[];
  roomtone: RoomTemplate | null;
  pools: Record<string, Pool>;
}

interface State {
  /** Undefined until the first tree. */
  scene: Scene | undefined;
  layout: Lights | undefined;
  error: Error | null;
  /** Whether a show's on, its clock, how its scenes come in, and the one waiting for its frame (shared/show.ts). */
  showOn: boolean;
  clock: ShowClock;
  cue: CueMode;
  queued: ShowState["queued"];
  /** The room's scenes (shared/scenes.ts). */
  scenes: Scenes;
}

let state: State = { scene: undefined, layout: undefined, error: null, showOn: RESTING.on, clock: RESTING.clock, cue: RESTING.cue, queued: null, scenes: NO_SCENES };
let tree: LiveTree | null = null;
// The last change the copy here has, of which run of vibes.
let rev: number | null = null;
let epoch: string | undefined;
const scripts = new Map<string, string>();
const fetching = new Set<string>();
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;

// The scene's shaders as last made, by key, with what each was made from:
// one that hasn't changed is the same object, so what's made from it needn't be again.
let made = new Map<ShaderKey, { from: Shader; script: string | undefined; shader: SceneShader }>();
let layoutFrom: LiveTree["layout"] = null;

function publish() {
  if (!tree) return;
  const next = new Map<ShaderKey, { from: Shader; script: string | undefined; shader: SceneShader }>();
  const shaders: SceneShader[] = [];
  for (const key of tree.stack) {
    const from = tree.shaders[key];
    if (!from) continue;
    const script = from.scriptHash ? scripts.get(from.scriptHash) : undefined;
    const was = made.get(key);
    const shader = was && was.from === from && was.script === script ? was.shader : script === undefined ? from : { ...from, script };
    next.set(key, { from, script, shader });
    shaders.push(shader);
  }
  made = next;
  const scene: Scene = { shaders, roomtone: { lights: tree.roomtone }, pools: tree.pools };
  let layout = state.layout;
  if (tree.layout !== layoutFrom) {
    layoutFrom = tree.layout;
    const l = tree.layout;
    layout = l
      ? {
          id_width: l.id_width,
          lights: l.order.flatMap((id) => (l.lights[String(id)] ? [l.lights[String(id)]!] : [])),
          rails: l.railOrder.flatMap((id) => (l.rails[id] ? [l.rails[id]!] : [])),
          changed: l.changed,
        }
      : undefined;
  }
  const show = tree.show ?? RESTING;
  state = { scene, layout, error: null, showOn: show.on, clock: show.clock ?? RESTING.clock, cue: show.cue ?? RESTING.cue, queued: show.queued ?? null, scenes: tree.scenes ?? NO_SCENES };
  for (const l of listeners) l();
}

// Changes come many a second while anyone drags: those that come together are shown together.
let publishing = false;
function publishSoon() {
  if (publishing) return;
  publishing = true;
  queueMicrotask(() => {
    publishing = false;
    publish();
  });
}

/** The scripts the tree has that aren't here yet; the ones it's dropped, forgotten. */
async function fetchScripts() {
  if (!tree) return;
  const now = new Set(Object.values(tree.shaders).flatMap((s) => (s.scriptHash ? [s.scriptHash] : [])));
  for (const hash of scripts.keys()) if (!now.has(hash)) scripts.delete(hash);
  const missing = [...now].filter((h) => !scripts.has(h) && !fetching.has(h));
  if (missing.length === 0) return;
  for (const h of missing) fetching.add(h);
  try {
    const got = await request<Record<string, string>>("GET", `/api/scene/scripts?hashes=${missing.join(",")}`);
    for (const [hash, script] of Object.entries(got)) scripts.set(hash, script);
    publish();
  } catch {
    // Tried again with the next change.
  } finally {
    for (const h of missing) fetching.delete(h);
  }
}

/** An update vibes didn't make (all of it, or, failing part way in arclamp, the rest of it): why, and the shaders it added before it stopped. */
export class UpdateError extends Error {
  readonly code: string;
  readonly made: Record<string, ShaderKey>;

  constructor(message: string, code: string, made: Record<string, ShaderKey>) {
    super(message);
    this.code = code;
    this.made = made;
  }
}

// Updates sent, by id, waiting for their answers.
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

// arclamp's time (rtime.ts), asked of vibes on this socket: a few at once as
// it opens (and as the page comes back into view), then one every few
// seconds, each answer timed by this page's clock.
const ASK_EVERY_MS = 5_000;
const BURST = 8;
const BURST_GAP_MS = 100;
const askedAt = new Map<number, number>();
let asks = 0;
let asking: number | undefined;

function askOnce(ws: WebSocket) {
  if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
  const id = ++asks;
  askedAt.set(id, pageNow());
  ws.send(JSON.stringify({ type: "time", id } satisfies RoomRequest));
}

function askTime(ws: WebSocket) {
  for (let i = 0; i < BURST; i++) window.setTimeout(() => askOnce(ws), i * BURST_GAP_MS);
  window.clearInterval(asking);
  asking = window.setInterval(() => askOnce(ws), ASK_EVERY_MS);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && socket) askTime(socket);
  });
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
    // The tree, or what's changed since the copy here.
    ws.send(JSON.stringify({ type: "hello", rev, ...(epoch ? { epoch } : {}), fans: true } satisfies RoomRequest));
    // Where this page is, said again on every socket: vibes forgot it with the last.
    if (presenceOut) ws.send(presenceOut);
    greet(ws);
    askTime(ws);
  };
  ws.onmessage = (e: MessageEvent<string>) => {
    const answered = pageNow();
    heard = Date.now();
    const m = JSON.parse(e.data) as RoomMessage;
    if (m.type === "time") {
      const asked = askedAt.get(m.id);
      askedAt.delete(m.id);
      if (asked !== undefined) heardTime(asked, answered, m.r, m.e);
    } else if (m.type === "state") {
      tree = m.tree;
      rev = m.rev;
      epoch = m.epoch;
      publish();
      void fetchScripts();
    } else if (m.type === "delta") {
      // One missed (it can't be, on one socket, but if it were), or not understood: the tree again, from the start.
      const ops = unfanOps(m.ops);
      if (!tree || rev === null || m.rev !== rev + 1 || typeof ops === "string") {
        rev = null;
        ws.close();
        return;
      }
      tree = withOps(tree, ops);
      rev = m.rev;
      publishSoon();
      if (ops.some(([path]) => path.startsWith("shaders/"))) void fetchScripts();
    } else if (m.type === "done" || m.type === "refused") {
      const asked = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.type === "done") asked?.resolve(m.made);
      else asked?.reject(new UpdateError(m.error, m.code, m.made));
    } else if (m.type === "presence") {
      for (const l of presenceListeners) l(m.people);
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    window.clearInterval(watchdog);
    window.clearInterval(asking);
    askedAt.clear();
    // Updates with no answer now: made, or not, or some of them. Sending
    // them again is safe (a sketch is added once, however often it's sent).
    for (const [id, asked] of waiting) {
      waiting.delete(id);
      asked.reject(new Error("lost the connection to vibes"));
    }
    // Opened again in a moment, while anything's watching. Meanwhile the copy here stands.
    window.clearTimeout(retry);
    retry = window.setTimeout(() => {
      if (listeners.size > 0 && !socket) open();
    }, RETRY_MS);
    // Everyone else is unknown until it's open again.
    for (const l of presenceListeners) l([]);
    if (state.scene === undefined) {
      state = { ...state, error: new Error("couldn't reach vibes for the room") };
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
 * Changes to the live state, as one update (all of it, or none); the shaders
 * it added, by the keys of the edits that added them. Refused, an
 * UpdateError says why. Sent at once, whatever's still waiting for an
 * answer: vibes makes them in order, and those that come while one's being
 * made, together. No changes at all is answered once the tree here is up to
 * date with whatever vibes has just changed.
 */
export function sendUpdate(ops: Op[], note?: string): Promise<Record<string, ShaderKey>> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    waiting.set(id, { resolve, reject });
    open();
    void greeted!.then((ws) => ws.send(JSON.stringify({ type: "update", id, ops: fanOps(ops), ...(note ? { note } : {}) } satisfies RoomRequest)));
  });
}

// Who's here (shared/presence.ts; web/presence.ts has it): where this page
// is, as last said, and who's told what vibes says of everyone.
let presenceOut: string | null = null;
const presenceListeners = new Set<(people: Presence[]) => void>();

/** Where this page is: sent now if the socket's open, and again whenever it opens. */
export function sayPresence(floor: number | null, selected: number[]) {
  presenceOut = JSON.stringify({ type: "presence", floor, selected } satisfies RoomRequest);
  if (socket?.readyState === WebSocket.OPEN) socket.send(presenceOut);
}

/** Told everyone's presence (this page's too) each time vibes says it; nobody's when the socket closes. */
export function onPresence(listener: (people: Presence[]) => void) {
  presenceListeners.add(listener);
  return () => void presenceListeners.delete(listener);
}

const snapshot = () => state;
const useState_ = () => useSyncExternalStore(subscribe, snapshot);

/** The room, as `{ data }` (undefined until the first tree). */
export function useScene(): { data: Scene | undefined; error: Error | null } {
  const s = useState_();
  return { data: s.scene, error: s.error };
}

/** The lights and rails, with vibes' changes made, as `{ data }` (undefined until vibes has had them from arclamp). */
export function useLights(): { data: Lights | undefined; error: Error | null } {
  const s = useState_();
  return { data: s.layout, error: s.scene ? null : s.error };
}

/** Whether a show's on (shared/show.ts), as vibes last said. */
export function useShowOn(): boolean {
  return useSyncExternalStore(subscribe, () => state.showOn);
}

/** The show clock (shared/show.ts), as vibes last said it: resting, with no show on. */
export function useShowClock(): ShowClock {
  return useSyncExternalStore(subscribe, () => state.clock);
}

/** The show clock as vibes last said it, outside React (the map's simulation). */
export const showClockNow = () => state.clock;

/** Something done to the show (starting or ending one, too), at once whatever the mode (it's the room's: never a pending edit). */
export const sendTransport = (action: TransportAction) => sendUpdate([[pathOf("show", "transport"), action]]);

/** The room's scenes (shared/scenes.ts), as vibes last said them. */
export function useScenes(): Scenes {
  return useSyncExternalStore(subscribe, () => state.scenes);
}

/** Changes to the scenes (scenes/…: shared/live.ts), at once whatever the mode: they're the room's, never a pending edit. */
export const sendScenes = (ops: Op[]) => sendUpdate(ops);

/** How a show's scenes come in (shared/show.ts). */
export function useShowCue(): CueMode {
  return useSyncExternalStore(subscribe, () => state.cue);
}

/** The scene applied in a show that's waiting for its frame, if any. */
export function useShowQueued(): ShowState["queued"] {
  return useSyncExternalStore(subscribe, () => state.queued);
}

/** A scene applied on the show's clock, pressed at `at` (arclamp's time: rtime.ts), whatever the mode: the show's. */
export const sendApply = (scene: string, at: number) => sendUpdate([[pathOf("show", "apply"), { scene, at }]]);

/** A change to the map: rails drawn or moved, lights moved, turned to another orientation, and/or tagged. */
export interface LayoutChange {
  rails?: RailChange[];
  placements?: Placement[];
  types?: TypeChange[];
  tags?: TagChange[];
}

/** A change to the map as changes to the live state (vibes draws rails first, so lights can go on one drawn in the same change). */
export function layoutOps({ rails = [], placements = [], types = [], tags = [] }: LayoutChange): Op[] {
  return [
    ...rails.map((r): Op => [pathOf("layout", "rails", r.id), r.rail]),
    ...placements.map((p): Op => [pathOf("layout", "lights", p.id, "spot"), "rail" in p ? { rail: p.rail } : p.coords && { coords: p.coords }]),
    ...types.map((t): Op => [pathOf("layout", "lights", t.id, "type"), t.type]),
    ...tags.map((t): Op => [pathOf("layout", "lights", t.id, "tags"), t.tags]),
  ];
}

/** Changing the map: each change sent as it's made (mutate); whether any's still on its way, and why the last one failed, if it did. */
export function useChangeLayout() {
  const [sending, setSending] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const mutate = useCallback((change: LayoutChange) => {
    setSending((n) => n + 1);
    setError(null);
    sendUpdate(layoutOps(change))
      .catch((err: Error) => setError(err))
      .finally(() => setSending((n) => n - 1));
  }, []);
  return { mutate, isPending: sending > 0, error };
}

/** The tree here, once it has whatever vibes has just changed (after changing it some other way, to see it changed). */
export async function invalidateScene(): Promise<void> {
  await sendUpdate([]);
}
