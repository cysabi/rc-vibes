// One connection to arclamp's live light stream, shared by every browser.
// arclamp sends ~100 frames a second; browsers get the newest frame at most
// 30 times a second. Frames are relayed unchanged (packed binary).

import WebSocket from "ws";

const SEND_INTERVAL_MS = 1000 / 30;
const MAX_RETRY_MS = 10_000;

export type FrameListener = (frame: Uint8Array) => void;

export function createStreamRelay(url: string, key: string) {
  const listeners = new Set<FrameListener>();
  let socket: WebSocket | null = null;
  let connected = false;
  let stopped = false;
  let retryMs = 500;
  let latest: Uint8Array | null = null;
  let seq = 0;
  let sentSeq = 0;
  let lastError = "";

  function connect() {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    socket = ws;
    ws.on("open", () => {
      connected = true;
      retryMs = 500;
      lastError = "";
      console.log("arclamp stream connected");
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      latest = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
      seq++;
    });
    ws.on("error", (err) => {
      // Log each distinct failure once rather than on every retry.
      if (err.message !== lastError) console.warn(`arclamp stream: ${err.message}`);
      lastError = err.message;
    });
    ws.on("close", () => {
      if (connected) console.warn("arclamp stream disconnected");
      connected = false;
      socket = null;
      if (stopped) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    });
  }

  const pacer = setInterval(() => {
    if (!latest || seq === sentSeq) return;
    sentSeq = seq;
    for (const listener of listeners) listener(latest);
  }, SEND_INTERVAL_MS);

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
      clearInterval(pacer);
      socket?.close();
    },
  };
}

export type StreamRelay = ReturnType<typeof createStreamRelay>;
