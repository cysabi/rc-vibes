// One connection to arclamp's live light stream, shared by every browser.
// arclamp sends a frame every beat (100 a second). Each goes on to browsers
// as it arrives, unchanged (packed binary), and browsers play them out at a
// steady pace by their timestamps (src/web/playout.ts). A frame that only
// repeats the last one sent, timestamp aside, is skipped, but one still goes
// at least every heartbeat so browsers keep their timing.
//
// A connection can go quiet without ever closing: arclamp gives up on a
// write that stalls (a Wi-Fi hiccup will do), and the close can be lost on
// the way (seen through Tailscale), leaving the map frozen with nothing to
// say so. So the connection is pinged, and anything heard back counts as
// alive; after `silentMs` of nothing it's dropped and dialed again.

import WebSocket from "ws";
import { FRAME_HEADER_BYTES } from "../shared/arclamp.ts";

const MAX_RETRY_MS = 10_000;
const HANDSHAKE_MS = 10_000;

export type FrameListener = (frame: Uint8Array) => void;

export interface RelayTiming {
  heartbeatMs: number;
  pingMs: number;
  silentMs: number;
}

const TIMING: RelayTiming = { heartbeatMs: 1000, pingMs: 2000, silentMs: 5000 };

export function createStreamRelay(url: string, key: string, timing: Partial<RelayTiming> = {}) {
  const { heartbeatMs, pingMs, silentMs } = { ...TIMING, ...timing };
  const listeners = new Set<FrameListener>();
  let socket: WebSocket | null = null;
  let connected = false;
  let stopped = false;
  let retryMs = 500;
  let latest: Buffer | null = null;
  let sent: Buffer | null = null;
  let sentAt = 0;
  let lastError = "";

  function connect() {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: HANDSHAKE_MS });
    socket = ws;
    let heard = Date.now();
    const watch = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - heard > silentMs) {
        console.warn(`arclamp stream silent for ${silentMs} ms; reconnecting`);
        ws.terminate();
      } else {
        ws.ping();
      }
    }, pingMs);
    ws.on("open", () => {
      heard = Date.now();
      connected = true;
      retryMs = 500;
      lastError = "";
      console.log("arclamp stream connected");
    });
    ws.on("pong", () => (heard = Date.now()));
    ws.on("message", (data, isBinary) => {
      const now = (heard = Date.now());
      if (!isBinary) return;
      const frame = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
      latest = frame;
      const same = sent !== null && frame.subarray(FRAME_HEADER_BYTES).equals(sent.subarray(FRAME_HEADER_BYTES));
      if (same && now - sentAt < heartbeatMs) return;
      sent = frame;
      sentAt = now;
      for (const listener of listeners) listener(frame);
    });
    ws.on("error", (err) => {
      // Log each distinct failure once rather than on every retry.
      if (err.message !== lastError) console.warn(`arclamp stream: ${err.message}`);
      lastError = err.message;
    });
    ws.on("close", () => {
      clearInterval(watch);
      if (connected) console.warn("arclamp stream disconnected");
      connected = false;
      socket = null;
      if (stopped) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    });
  }

  connect();

  return {
    connected: () => connected,
    /** Returns an unsubscribe function. New listeners get the current frame first. */
    subscribe(listener: FrameListener) {
      listeners.add(listener);
      if (latest) listener(latest);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      socket?.close();
    },
  };
}

export type StreamRelay = ReturnType<typeof createStreamRelay>;
