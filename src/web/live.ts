// The room's light state: live from arclamp's stream (relayed by vibes), or,
// while there are pending edits, the browser's preview of them (sim.ts).
// Live frames arrive as arclamp makes them, up to 100 a second, and are played
// out at a steady pace by their timestamps (playout.ts), one per screen
// refresh at most. They live outside React: the map draws straight from the
// store, and React only hears about connection changes.

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { decodeFrame, frameTime, type Frame, type LightsResponse } from "../shared/arclamp.ts";
import { apiSocket } from "./api.ts";
import { Playout, type PlayoutStats } from "./playout.ts";

const RETRY_MS = 1000;

const playout = new Playout<ArrayBuffer>();
/** This browser's clock in ms, on a steady timeline (rAF times are on it too). */
const clock = (t = performance.now()) => performance.timeOrigin + t;

/** How the live stream's timing has gone since the last call, for admin mode's readout. */
export const liveTiming = (): PlayoutStats => playout.stats();

let liveFrame: Frame | null = null;
let simFrame: Frame | null = null;
let simulated = false;
// Peeking at the saved room (peek.ts' SAVED): the room's own frames shown, the preview still running behind them.
let showingRoom = false;
let connected = false;
const frameListeners = new Set<(f: Frame) => void>();
const statusListeners = new Set<() => void>();

/** The frame to show: the preview's while simulating (unless peeking at the saved room), else the room's. */
export const latestFrame = () => (simulated && !showingRoom ? (simFrame ?? liveFrame) : liveFrame);

function notify(f: Frame) {
  for (const l of frameListeners) l(f);
}

/** Switch between showing the live room and the preview. */
export function setSimulated(on: boolean) {
  if (simulated === on) return;
  simulated = on;
  simFrame = null;
  if (!on && liveFrame) notify(liveFrame);
}

export function pushSimFrame(f: Frame) {
  if (!simulated) return;
  simFrame = f;
  if (!showingRoom) notify(f);
}

/**
 * Show the room's own frames (the saved pipeline, as it runs), whatever's
 * pending, or go back to the preview. The preview keeps running meanwhile,
 * so nothing in it starts over.
 */
export function setShowingRoom(on: boolean) {
  if (showingRoom === on) return;
  showingRoom = on;
  const f = latestFrame();
  if (f) notify(f);
}

/** Called for every new frame. Returns an unsubscribe function. */
export function onFrame(listener: (f: Frame) => void) {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

/**
 * Where a map, and whatever reads its lights, gets the light from: the room
 * (as above), or a sketch's own preview (preview/runner.ts). They take theirs
 * from context, so a sketch's preview runs on its own and touches nothing else.
 */
export interface FrameSource {
  /** The frame to show now, if there is one yet. */
  latest(): Frame | null;
  /** Called for every new frame. Returns an unsubscribe function. */
  subscribe(listener: (f: Frame) => void): () => void;
}

/** The room: live, or the preview of pending edits while there are some. */
export const roomFrames: FrameSource = { latest: latestFrame, subscribe: onFrame };

const FramesContext = createContext<FrameSource>(roomFrames);
export const FramesProvider = FramesContext.Provider;
export const useFrames = () => useContext(FramesContext);

function setConnected(value: boolean) {
  connected = value;
  for (const l of statusListeners) l();
}

export function useStreamConnected(): boolean {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => connected,
  );
}

/** Keep a connection to /api/stream open while mounted. */
export function useLiveStream(layout: LightsResponse | undefined) {
  useEffect(() => {
    if (!layout) return;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let stopped = false;
    let shown: ArrayBuffer | null = null;

    // Only frames that reach the screen are decoded.
    const show = (data: ArrayBuffer) => {
      if (data === shown) return;
      shown = data;
      try {
        liveFrame = decodeFrame(data, layout);
      } catch (err) {
        console.warn("bad light frame", err);
        return;
      }
      if (!simulated || showingRoom) notify(liveFrame);
    };

    // At vibes' API address, saying who's there first if that's another site (apiSocket).
    const connect = () => void apiSocket("/api/stream").then(open);
    const open = ({ url, hello }: { url: string; hello: string | null }) => {
      if (stopped) return;
      const ws = new WebSocket(url);
      socket = ws;
      ws.binaryType = "arraybuffer";
      let first = true;
      ws.onopen = () => {
        if (hello) ws.send(hello);
        setConnected(true);
      };
      ws.onmessage = (event) => {
        const data = event.data as ArrayBuffer;
        if (first) {
          // vibes greets each connection with the last frame it had, which is
          // old if arclamp has gone quiet: shown at once, but not timed.
          first = false;
          playout.reset();
          show(data);
          return;
        }
        try {
          playout.push(frameTime(data), data, clock());
        } catch (err) {
          console.warn("bad light frame", err);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = window.setTimeout(connect, RETRY_MS);
      };
    };

    let raf = requestAnimationFrame(function step(t) {
      const data = playout.at(clock(t));
      if (data) show(data);
      raf = requestAnimationFrame(step);
    });

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      cancelAnimationFrame(raf);
      socket?.close();
    };
  }, [layout]);
}
