// The room's light state: live from arclamp's stream (relayed by vibes), or,
// while there are pending edits, the browser's preview of them (sim.ts).
// Frames arrive up to 30 times a second, so they live outside React: the map
// draws straight from the store, and React only hears about connection
// changes.

import { useEffect, useSyncExternalStore } from "react";
import { decodeFrame, type Frame, type LightsResponse } from "../shared/arclamp.ts";

const RETRY_MS = 1000;

let liveFrame: Frame | null = null;
let simFrame: Frame | null = null;
let simulated = false;
let connected = false;
const frameListeners = new Set<(f: Frame) => void>();
const statusListeners = new Set<() => void>();

/** The frame to show: the preview's while simulating, else the room's. */
export const latestFrame = () => (simulated ? (simFrame ?? liveFrame) : liveFrame);

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
  notify(f);
}

/** Called for every new frame. Returns an unsubscribe function. */
export function onFrame(listener: (f: Frame) => void) {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

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

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}/api/stream`);
      socket = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        try {
          liveFrame = decodeFrame(event.data as ArrayBuffer, layout);
        } catch (err) {
          console.warn("bad light frame", err);
          return;
        }
        if (!simulated) notify(liveFrame);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = window.setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [layout]);
}
